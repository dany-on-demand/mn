import { createServer } from 'node:http'
import { scrypt, randomBytes, timingSafeEqual } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import fs from 'node:fs'

import express from 'express'
import session from 'express-session'
import compression from 'compression'
import send from 'send'
import Database from 'better-sqlite3'
import { WebSocketServer } from 'ws'
import { rateLimit } from 'express-rate-limit'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const SESSION_CLEANUP_INTERVAL_MS = 15 * 60 * 1000   // 15 minutes
const MAX_CHAT_MESSAGE_LENGTH = 500
const MAX_CHAT_USERNAME_LENGTH = 64
const IS_PRODUCTION = process.env.NODE_ENV === 'production'

// ---------------------------------------------------------------------------
// Data directory & SQLite database
// ---------------------------------------------------------------------------
const DATA_DIR = path.join(__dirname, 'data')
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true })

const db = new Database(path.join(DATA_DIR, 'mn.db'))
db.pragma('journal_mode = WAL')
db.pragma('foreign_keys = ON')
db.pragma('synchronous = NORMAL')    // safe with WAL, ~2× faster writes
db.pragma('cache_size = -16000')     // 16 MB page cache

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    username      TEXT    UNIQUE NOT NULL,
    password_hash TEXT    NOT NULL,
    role          TEXT    NOT NULL DEFAULT 'user',
    created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS app_config (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sessions (
    sid    TEXT    PRIMARY KEY,
    sess   TEXT    NOT NULL,
    expire INTEGER NOT NULL
  );
`)

// ---------------------------------------------------------------------------
// Pre-compile ALL prepared statements (data-oriented: compile once, run many)
// ---------------------------------------------------------------------------
const stmts = {
  // app_config
  getConfigValue:         db.prepare('SELECT value FROM app_config WHERE key = ?'),
  insertConfigValue:      db.prepare('INSERT INTO app_config (key, value) VALUES (?, ?)'),
  // settings
  insertIgnoreSetting:    db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)'),
  upsertSetting:          db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)'),
  getAllSettings:          db.prepare('SELECT key, value FROM settings'),
  // users
  getUserByUsername:      db.prepare('SELECT * FROM users WHERE username = ?'),
  getUserById:            db.prepare('SELECT * FROM users WHERE id = ?'),
  getAdmin:               db.prepare("SELECT id FROM users WHERE role = 'admin' LIMIT 1"),
  insertUser:             db.prepare('INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)'),
  updatePassword:         db.prepare('UPDATE users SET password_hash = ? WHERE id = ?'),
  deleteUser:             db.prepare('DELETE FROM users WHERE id = ?'),
  listUsers:              db.prepare('SELECT id, username, role, created_at FROM users'),
  // sessions
  getSession:             db.prepare('SELECT sess FROM sessions WHERE sid = ? AND expire > ?'),
  upsertSession:          db.prepare('INSERT OR REPLACE INTO sessions (sid, sess, expire) VALUES (?, ?, ?)'),
  deleteSession:          db.prepare('DELETE FROM sessions WHERE sid = ?'),
  deleteExpiredSessions:  db.prepare('DELETE FROM sessions WHERE expire < ?'),
}

// ---------------------------------------------------------------------------
// Seed default settings (migrate from config/globals.json if present)
// ---------------------------------------------------------------------------
const globalsPath = path.join(__dirname, 'config', 'globals.json')
const defaultSettings = fs.existsSync(globalsPath)
  ? JSON.parse(fs.readFileSync(globalsPath, 'utf8'))
  : { media_file: 'test.mp4', 'message-of-the-day': 'Welcome to movie night!' }

for (const [key, value] of Object.entries(defaultSettings)) {
  stmts.insertIgnoreSetting.run(key, String(value))
}

// ---------------------------------------------------------------------------
// Persistent session secret
// Env var SESSION_SECRET takes priority; otherwise generate+persist in DB.
// ---------------------------------------------------------------------------
let sessionSecret = process.env.SESSION_SECRET || stmts.getConfigValue.get('session_secret')?.value
if (!sessionSecret) {
  sessionSecret = randomBytes(32).toString('hex')
  stmts.insertConfigValue.run('session_secret', sessionSecret)
}

// ---------------------------------------------------------------------------
// In-memory settings cache — avoids a DB round-trip on every WS connection
// and every /stream request.  Invalidated whenever settings are written.
// ---------------------------------------------------------------------------
let settingsCache = null

function getSettings() {
  if (!settingsCache) {
    const rows = stmts.getAllSettings.all()
    settingsCache = Object.fromEntries(rows.map(r => [r.key, r.value]))
  }
  return settingsCache
}

function invalidateSettings() {
  settingsCache = null
  rebuildMediaCache()
  rebuildWelcomePrefix()
}

// ---------------------------------------------------------------------------
// Media path cache — path.join + settings lookup done once, not per request
// Also validates that the resolved path stays within MEDIA_DIR (path traversal guard).
// ---------------------------------------------------------------------------
const MEDIA_DIR = path.join(__dirname, 'media')
let cachedMediaFile = null
let cachedMediaPath = null

function rebuildMediaCache() {
  const file = getSettings().media_file || 'test.mp4'
  const resolved = path.resolve(MEDIA_DIR, file)
  // Reject any path that escapes MEDIA_DIR (e.g. ../data/mn.db)
  if (!resolved.startsWith(MEDIA_DIR + path.sep)) {
    console.warn(`[security] media_file "${file}" escapes media directory — ignoring`)
    cachedMediaFile = 'test.mp4'
    cachedMediaPath = path.join(MEDIA_DIR, 'test.mp4')
    return
  }
  cachedMediaFile = file
  cachedMediaPath = resolved
}

// ---------------------------------------------------------------------------
// Password helpers – inline callbacks avoid the promisify allocation
// ---------------------------------------------------------------------------
function hashPassword(password) {
  return new Promise((resolve, reject) => {
    const salt = randomBytes(16)
    scrypt(password, salt, 64, (err, hash) => {
      if (err) return reject(err)
      resolve(`${salt.toString('hex')}:${hash.toString('hex')}`)
    })
  })
}

function verifyPassword(password, storedHash) {
  return new Promise((resolve, reject) => {
    const [saltHex, hashHex] = storedHash.split(':')
    const salt = Buffer.from(saltHex, 'hex')
    const stored = Buffer.from(hashHex, 'hex')
    scrypt(password, salt, 64, (err, hash) => {
      if (err) return reject(err)
      try { resolve(timingSafeEqual(hash, stored)) } catch { resolve(false) }
    })
  })
}

// ---------------------------------------------------------------------------
// Ensure at least one admin account exists
// ---------------------------------------------------------------------------
async function ensureAdmin() {
  const existing = stmts.getAdmin.get()
  if (existing) return

  const adminUser = process.env.ADMIN_USERNAME || 'admin'
  const adminPass = process.env.ADMIN_PASSWORD || randomBytes(8).toString('hex')
  const passwordHash = await hashPassword(adminPass)

  stmts.insertUser.run(adminUser, passwordHash, 'admin')

  console.log('\n\x1b[33m┌─ Admin account created ────────────────────────┐\x1b[0m')
  console.log(`\x1b[33m│\x1b[0m  Username : \x1b[32m${adminUser}\x1b[0m`)
  console.log(`\x1b[33m│\x1b[0m  Password : \x1b[32m${adminPass}\x1b[0m`)
  console.log('\x1b[33m│\x1b[0m  \x1b[31mChange this password after first login!\x1b[0m')
  console.log('\x1b[33m└────────────────────────────────────────────────┘\x1b[0m\n')
}

// ---------------------------------------------------------------------------
// Simple SQLite session store – uses pre-compiled stmts, no per-call prepare
// ---------------------------------------------------------------------------
class SQLiteSessionStore extends session.Store {
  constructor() {
    super()
    // Prune expired sessions every 15 minutes
    setInterval(() => {
      stmts.deleteExpiredSessions.run(Math.floor(Date.now() / 1000))
    }, SESSION_CLEANUP_INTERVAL_MS).unref()
  }

  get(sid, cb) {
    const row = stmts.getSession.get(sid, Math.floor(Date.now() / 1000))
    if (!row) return cb(null, null)
    try { cb(null, JSON.parse(row.sess)) } catch (e) { cb(e) }
  }

  set(sid, sess, cb) {
    // sess.cookie.maxAge is in milliseconds; convert to seconds for the Unix timestamp
    const maxAgeMs = sess.cookie?.maxAge || (7 * 24 * 60 * 60 * 1000)
    const expire = Math.floor(Date.now() / 1000) + Math.floor(maxAgeMs / 1000)
    stmts.upsertSession.run(sid, JSON.stringify(sess), expire)
    cb(null)
  }

  destroy(sid, cb) {
    stmts.deleteSession.run(sid)
    cb(null)
  }
}

// ---------------------------------------------------------------------------
// Express setup
// ---------------------------------------------------------------------------
const app = express()
const httpServer = createServer(app)

const sessionParser = session({
  store: new SQLiteSessionStore(),
  secret: sessionSecret,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: 'strict',
    secure: IS_PRODUCTION,  // HTTPS-only in production
    maxAge: 7 * 24 * 60 * 60 * 1000 // 1 week
  }
})

// Rate limiters
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,  // 15 minutes
  max: 20,                    // max 20 requests per window
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later' }
})

const apiReadLimiter = rateLimit({
  windowMs: 60 * 1000,        // 1 minute
  max: 120,                   // max 120 read requests per minute
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later' }
})

const apiWriteLimiter = rateLimit({
  windowMs: 60 * 1000,        // 1 minute
  max: 60,                    // max 60 write requests per minute
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later' }
})

const streamLimiter = rateLimit({
  windowMs: 60 * 1000,        // 1 minute
  max: 30,                    // max 30 stream requests per minute
  standardHeaders: true,
  legacyHeaders: false,
  message: 'Too many requests, please try again later'
})

const staticLimiter = rateLimit({
  windowMs: 60 * 1000,        // 1 minute
  max: 300,                   // max 300 static file requests per minute
  standardHeaders: true,
  legacyHeaders: false
})

app.use(compression({
  // Don't try to compress already-compressed video streams — wastes CPU
  filter: (req, res) => req.path.startsWith('/stream') ? false : compression.filter(req, res)
}))

// Security headers on every response
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('X-Frame-Options', 'SAMEORIGIN')
  res.setHeader('Referrer-Policy', 'same-origin')
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()')
  if (IS_PRODUCTION) {
    // Tell browsers to use HTTPS for 2 years once they've seen it once
    res.setHeader('Strict-Transport-Security', 'max-age=63072000; includeSubDomains')
  }
  next()
})

app.use(sessionParser)
// Body parsing scoped to /api only — /stream and static routes never need a JSON body.
// The 16 kb cap prevents body-size DoS.
app.use('/api', express.json({ limit: '16kb' }))

// ---------------------------------------------------------------------------
// CSRF protection – synchronizer token pattern
// ---------------------------------------------------------------------------

// Expose a CSRF token in the session (works for both authenticated and guest sessions)
app.get('/api/csrf-token', (req, res) => {
  if (!req.session.csrfToken) {
    req.session.csrfToken = randomBytes(32).toString('hex')
  }
  res.json({ csrfToken: req.session.csrfToken })
})

function csrfProtect(req, res, next) {
  // CSRF check only needed for state-changing methods
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next()

  const sessionToken = req.session?.csrfToken
  const headerToken  = req.headers['x-csrf-token']

  if (!sessionToken || !headerToken || sessionToken.length !== headerToken.length) {
    return res.status(403).json({ error: 'Invalid CSRF token' })
  }
  try {
    if (!timingSafeEqual(Buffer.from(sessionToken), Buffer.from(headerToken))) {
      return res.status(403).json({ error: 'Invalid CSRF token' })
    }
  } catch {
    return res.status(403).json({ error: 'Invalid CSRF token' })
  }
  next()
}

app.use(csrfProtect)

// ---------------------------------------------------------------------------
// Auth helpers
// ---------------------------------------------------------------------------
function requireAuth(req, res, next) {
  if (req.session?.user) return next()
  res.status(401).json({ error: 'Unauthorised' })
}

function requireAdmin(req, res, next) {
  if (req.session?.user?.role === 'admin') return next()
  res.status(403).json({ error: 'Forbidden' })
}

// ---------------------------------------------------------------------------
// API – Auth
// ---------------------------------------------------------------------------
app.get('/api/auth/me', (req, res) => {
  if (req.session?.user) {
    const { id, username, role } = req.session.user
    res.json({ id, username, role })
  } else {
    res.json(null)
  }
})

app.post('/api/auth/login', authLimiter, async (req, res) => {
  const { username, password } = req.body || {}
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password are required' })
  }

  const user = stmts.getUserByUsername.get(username)
  if (!user) return res.status(401).json({ error: 'Invalid credentials' })

  let valid = false
  try { valid = await verifyPassword(password, user.password_hash) } catch {}
  if (!valid) return res.status(401).json({ error: 'Invalid credentials' })

  req.session.user = { id: user.id, username: user.username, role: user.role }
  res.json({ id: user.id, username: user.username, role: user.role })
})

app.post('/api/auth/logout', requireAuth, (req, res) => {
  req.session.destroy(() => res.json({ ok: true }))
})

app.post('/api/auth/change-password', requireAuth, authLimiter, async (req, res) => {
  const { currentPassword, newPassword } = req.body || {}
  if (!currentPassword || !newPassword) {
    return res.status(400).json({ error: 'currentPassword and newPassword are required' })
  }
  if (newPassword.length < 8) {
    return res.status(400).json({ error: 'New password must be at least 8 characters' })
  }

  const user = stmts.getUserById.get(req.session.user.id)
  if (!user) return res.status(404).json({ error: 'User not found' })

  const valid = await verifyPassword(currentPassword, user.password_hash)
  if (!valid) return res.status(401).json({ error: 'Current password is incorrect' })

  const newHash = await hashPassword(newPassword)
  stmts.updatePassword.run(newHash, user.id)
  res.json({ ok: true })
})

// ---------------------------------------------------------------------------
// API – Settings (admin only)
// ---------------------------------------------------------------------------
app.get('/api/settings', requireAdmin, apiReadLimiter, (_req, res) => {
  res.json(getSettings())
})

app.post('/api/settings', requireAdmin, apiWriteLimiter, (req, res) => {
  const incoming = req.body || {}

  // Validate media_file doesn't escape MEDIA_DIR before persisting
  if (incoming.media_file) {
    const resolved = path.resolve(MEDIA_DIR, incoming.media_file)
    if (!resolved.startsWith(MEDIA_DIR + path.sep)) {
      return res.status(400).json({ error: 'Invalid media file path' })
    }
  }

  const oldMedia = getSettings().media_file
  const txn = db.transaction(() => {
    for (const [key, value] of Object.entries(incoming)) {
      stmts.upsertSetting.run(key, String(value))
    }
  })
  txn()
  invalidateSettings()

  if (incoming.media_file && incoming.media_file !== oldMedia) {
    channel.currentTime = 0
    broadcast({ type: 'authoritative', message: { 'server-time': new Date().toISOString(), 'video-seek-time': 0 } })
  }

  res.json({ ok: true })
})

// ---------------------------------------------------------------------------
// API – Users (admin only)
// ---------------------------------------------------------------------------
app.get('/api/users', requireAdmin, apiReadLimiter, (_req, res) => {
  res.json(stmts.listUsers.all())
})

app.post('/api/users', requireAdmin, apiWriteLimiter, async (req, res) => {
  const { username, password, role = 'user' } = req.body || {}
  if (!username || !password) {
    return res.status(400).json({ error: 'username and password are required' })
  }
  if (!['user', 'admin'].includes(role)) {
    return res.status(400).json({ error: 'role must be user or admin' })
  }
  const passwordHash = await hashPassword(password)
  try {
    const result = stmts.insertUser.run(username, passwordHash, role)
    res.json({ id: result.lastInsertRowid, username, role })
  } catch (e) {
    if (e.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      return res.status(409).json({ error: 'Username already exists' })
    }
    throw e
  }
})

app.delete('/api/users/:id', requireAdmin, apiWriteLimiter, (req, res) => {
  const id = parseInt(req.params.id, 10)
  if (id === req.session.user.id) {
    return res.status(400).json({ error: 'Cannot delete your own account' })
  }
  const result = stmts.deleteUser.run(id)
  if (result.changes === 0) return res.status(404).json({ error: 'User not found' })
  res.json({ ok: true })
})

// ---------------------------------------------------------------------------
// API – Media file list (admin only) — lets the admin pick from existing files
// ---------------------------------------------------------------------------
app.get('/api/media', requireAdmin, apiReadLimiter, (_req, res) => {
  try {
    const files = fs.readdirSync(MEDIA_DIR).filter(f => !f.startsWith('.'))
    res.json(files)
  } catch {
    res.json([])
  }
})

// ---------------------------------------------------------------------------
// Stream endpoint – media path served from cache, no DB round-trip per request
// ---------------------------------------------------------------------------
app.use('/stream', streamLimiter, (req, res) => {
  if (!fs.existsSync(cachedMediaPath)) {
    return res.status(404).send('Media file not found. Add it to the /media directory.')
  }
  send(req, cachedMediaFile, { root: MEDIA_DIR }).pipe(res)
})

// ---------------------------------------------------------------------------
// Static files
// ---------------------------------------------------------------------------
app.use(express.static(path.join(__dirname, 'public')))

// SPA fallback – serve index.html for any unmatched GET
app.get('*', staticLimiter, (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'))
})

// ---------------------------------------------------------------------------
// Channel state
// ---------------------------------------------------------------------------
const channel = {
  launchTime: new Date().toISOString(),
  currentTime: 0
}

// ---------------------------------------------------------------------------
// Broadcast helpers
// ---------------------------------------------------------------------------

// Heartbeat frame – built once per tick so all clients get the same pre-serialized
// string.  Using string concat avoids JSON.stringify on the hot 1 Hz loop.
let heartbeatFrame = ''
function buildHeartbeatFrame() {
  heartbeatFrame = `{"type":"heartbeat","message":{"server-time":"${new Date().toISOString()}","video-seek-time":${channel.currentTime}}}`
}

// Welcome frame – prefix is cached and only rebuilt when MOTD/settings change.
// The per-connection seek time is appended at connection time.
let welcomePrefix = ''
function rebuildWelcomePrefix() {
  const motd = JSON.stringify(getSettings()['message-of-the-day'] || '')
  welcomePrefix = `{"type":"welcome","message":{"server-launch-time":"${channel.launchTime}","message-of-the-day":${motd},"video-seek-time":`
}
function buildWelcomeFrame() {
  return `${welcomePrefix}${channel.currentTime}}}`
}

function broadcast(packet) {
  const data = JSON.stringify(packet)
  for (const client of wss.clients) {
    if (client.readyState === 1 /* OPEN */) client.send(data)
  }
}

function broadcastRaw(data) {
  for (const client of wss.clients) {
    if (client.readyState === 1 /* OPEN */) client.send(data)
  }
}

// ---------------------------------------------------------------------------
// WebSocket server (shares the HTTP server – no separate port needed)
// ---------------------------------------------------------------------------
const wss = new WebSocketServer({ noServer: true })

// Per-IP connection tracking — cap at 5 simultaneous WS connections per IP.
// This prevents a single client from exhausting server memory with socket floods.
const wsClientsByIp = new Map()

// Parse sessions on WS upgrade so we know who the user is
httpServer.on('upgrade', (req, socket, head) => {
  const ip = req.socket.remoteAddress || 'unknown'
  if ((wsClientsByIp.get(ip) ?? 0) >= 5) {
    socket.write('HTTP/1.1 429 Too Many Connections\r\n\r\n')
    socket.destroy()
    return
  }

  sessionParser(req, {}, () => {
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.user = req.session?.user || null
      wsClientsByIp.set(ip, (wsClientsByIp.get(ip) ?? 0) + 1)
      ws.on('close', () => {
        const n = wsClientsByIp.get(ip) ?? 1
        if (n <= 1) wsClientsByIp.delete(ip)
        else wsClientsByIp.set(ip, n - 1)
      })
      wss.emit('connection', ws, req)
    })
  })
})

wss.on('connection', (ws) => {
  ws.send(buildWelcomeFrame())

  // Per-connection message rate limit — max 10 messages/s.
  // Drops excess silently; prevents chat spam and CPU abuse.
  let msgCount = 0
  const msgReset = setInterval(() => { msgCount = 0 }, 1000)
  ws.on('close', () => clearInterval(msgReset))

  ws.on('message', (raw) => {
    if (++msgCount > 10) return  // rate limit exceeded — drop
    let packet
    try { packet = JSON.parse(raw) } catch { return }

    switch (packet.type) {
      case 'admin-seek-time-update':
        if (ws.user?.role !== 'admin') return // reject unauthenticated updates
        channel.currentTime = Number(packet.message?.['video-seek-time']) || 0
        break

      case 'chat-message': {
        const msg = packet.message || {}
        const chatText = String(msg['chat-message'] || '').trim().slice(0, MAX_CHAT_MESSAGE_LENGTH)
        const chatOwner = String(msg['chat-message-owner'] || 'Anonymous').trim().slice(0, MAX_CHAT_USERNAME_LENGTH)
        if (!chatText) return
        broadcast({
          type: 'incoming-chat-message',
          message: {
            'server-time': new Date().toISOString(),
            'chat-message': chatText,
            'chat-message-owner': chatOwner
          }
        })
        break
      }
    }
  })
})

// Heartbeat every second – build the frame once, send same string to all clients.
// Skip entirely when no clients are connected to avoid pointless work.
const heartbeatInterval = setInterval(() => {
  if (wss.clients.size === 0) return
  buildHeartbeatFrame()
  broadcastRaw(heartbeatFrame)
}, 1000)
heartbeatInterval.unref()

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
const PORT = parseInt(process.env.PORT || '3016', 10)

await ensureAdmin()

if (!fs.existsSync(MEDIA_DIR)) fs.mkdirSync(MEDIA_DIR, { recursive: true })

// Warm the caches (settings → media path → welcome prefix) before first request
getSettings()
rebuildMediaCache()
rebuildWelcomePrefix()

if (!fs.existsSync(cachedMediaPath)) {
  console.warn(`\x1b[33mWarning: media file "${cachedMediaFile}" not found in /media\x1b[0m`)
}

httpServer.listen(PORT, () => {
  console.log(`\x1b[32m✓ Movie Night listening on http://localhost:${PORT}\x1b[0m`)
})
