import { createServer } from 'http'
import { scrypt, randomBytes, timingSafeEqual } from 'crypto'
import { promisify } from 'util'
import { fileURLToPath } from 'url'
import path from 'path'
import fs from 'fs'

import express from 'express'
import session from 'express-session'
import compression from 'compression'
import send from 'send'
import Database from 'better-sqlite3'
import { WebSocketServer } from 'ws'
import { rateLimit } from 'express-rate-limit'

const scryptAsync = promisify(scrypt)

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
// Seed default settings (migrate from config/globals.json if present)
// ---------------------------------------------------------------------------
const globalsPath = path.join(__dirname, 'config', 'globals.json')
const defaultSettings = fs.existsSync(globalsPath)
  ? JSON.parse(fs.readFileSync(globalsPath, 'utf8'))
  : { media_file: 'test.mp4', 'message-of-the-day': 'Welcome to movie night!' }

const insertSetting = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)')
for (const [key, value] of Object.entries(defaultSettings)) {
  insertSetting.run(key, String(value))
}

// ---------------------------------------------------------------------------
// Persistent session secret
// ---------------------------------------------------------------------------
let sessionSecret = db.prepare('SELECT value FROM app_config WHERE key = ?').get('session_secret')?.value
if (!sessionSecret) {
  sessionSecret = randomBytes(32).toString('hex')
  db.prepare('INSERT INTO app_config (key, value) VALUES (?, ?)').run('session_secret', sessionSecret)
}

// ---------------------------------------------------------------------------
// Password helpers (Node.js built-in crypto – no native addon required)
// ---------------------------------------------------------------------------
async function hashPassword(password) {
  const salt = randomBytes(16)
  const hash = await scryptAsync(password, salt, 64)
  return `${salt.toString('hex')}:${hash.toString('hex')}`
}

async function verifyPassword(password, storedHash) {
  const [saltHex, hashHex] = storedHash.split(':')
  const salt = Buffer.from(saltHex, 'hex')
  const hash = await scryptAsync(password, salt, 64)
  const stored = Buffer.from(hashHex, 'hex')
  return timingSafeEqual(hash, stored)
}

// ---------------------------------------------------------------------------
// Ensure at least one admin account exists
// ---------------------------------------------------------------------------
async function ensureAdmin() {
  const existing = db.prepare("SELECT id FROM users WHERE role = 'admin' LIMIT 1").get()
  if (existing) return

  const adminUser = process.env.ADMIN_USERNAME || 'admin'
  const adminPass = process.env.ADMIN_PASSWORD || randomBytes(8).toString('hex')
  const passwordHash = await hashPassword(adminPass)

  db.prepare('INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)').run(
    adminUser, passwordHash, 'admin'
  )

  console.log('\n\x1b[33m┌─ Admin account created ────────────────────────┐\x1b[0m')
  console.log(`\x1b[33m│\x1b[0m  Username : \x1b[32m${adminUser}\x1b[0m`)
  console.log(`\x1b[33m│\x1b[0m  Password : \x1b[32m${adminPass}\x1b[0m`)
  console.log('\x1b[33m│\x1b[0m  \x1b[31mChange this password after first login!\x1b[0m')
  console.log('\x1b[33m└────────────────────────────────────────────────┘\x1b[0m\n')
}

// ---------------------------------------------------------------------------
// Simple SQLite session store (no extra package needed)
// ---------------------------------------------------------------------------
class SQLiteSessionStore extends session.Store {
  constructor(db) {
    super()
    this.db = db
    // Prune expired sessions every 15 minutes
    setInterval(() => {
      const now = Math.floor(Date.now() / 1000)
      this.db.prepare('DELETE FROM sessions WHERE expire < ?').run(now)
    }, SESSION_CLEANUP_INTERVAL_MS).unref()
  }

  get(sid, cb) {
    const row = this.db.prepare('SELECT sess FROM sessions WHERE sid = ? AND expire > ?')
      .get(sid, Math.floor(Date.now() / 1000))
    if (!row) return cb(null, null)
    try { cb(null, JSON.parse(row.sess)) } catch (e) { cb(e) }
  }

  set(sid, sess, cb) {
    // sess.cookie.maxAge is in milliseconds; convert to seconds for the Unix timestamp
    const maxAgeMs = sess.cookie?.maxAge || (7 * 24 * 60 * 60 * 1000)
    const expire = Math.floor(Date.now() / 1000) + Math.floor(maxAgeMs / 1000)
    this.db.prepare('INSERT OR REPLACE INTO sessions (sid, sess, expire) VALUES (?, ?, ?)')
      .run(sid, JSON.stringify(sess), expire)
    cb(null)
  }

  destroy(sid, cb) {
    this.db.prepare('DELETE FROM sessions WHERE sid = ?').run(sid)
    cb(null)
  }
}

// ---------------------------------------------------------------------------
// Express setup
// ---------------------------------------------------------------------------
const app = express()
const httpServer = createServer(app)

const sessionParser = session({
  store: new SQLiteSessionStore(db),
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

app.use(compression())
app.use(sessionParser)
app.use(express.json())

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

  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username)
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

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.user.id)
  if (!user) return res.status(404).json({ error: 'User not found' })

  const valid = await verifyPassword(currentPassword, user.password_hash)
  if (!valid) return res.status(401).json({ error: 'Current password is incorrect' })

  const newHash = await hashPassword(newPassword)
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(newHash, user.id)
  res.json({ ok: true })
})

// ---------------------------------------------------------------------------
// API – Settings (admin only)
// ---------------------------------------------------------------------------
app.get('/api/settings', requireAdmin, apiReadLimiter, (_req, res) => {
  const rows = db.prepare('SELECT key, value FROM settings').all()
  res.json(Object.fromEntries(rows.map(r => [r.key, r.value])))
})

app.post('/api/settings', requireAdmin, apiWriteLimiter, (req, res) => {
  const incoming = req.body || {}
  const upsert = db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)')

  const oldMedia = db.prepare("SELECT value FROM settings WHERE key = 'media_file'").get()?.value
  const txn = db.transaction(() => {
    for (const [key, value] of Object.entries(incoming)) {
      upsert.run(key, String(value))
    }
  })
  txn()

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
  const users = db.prepare('SELECT id, username, role, created_at FROM users').all()
  res.json(users)
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
    const result = db.prepare('INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)')
      .run(username, passwordHash, role)
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
  const result = db.prepare('DELETE FROM users WHERE id = ?').run(id)
  if (result.changes === 0) return res.status(404).json({ error: 'User not found' })
  res.json({ ok: true })
})

// ---------------------------------------------------------------------------
// Stream endpoint
// ---------------------------------------------------------------------------
app.use('/stream', streamLimiter, (req, res) => {
  const mediaFile = db.prepare("SELECT value FROM settings WHERE key = 'media_file'").get()?.value || 'test.mp4'
  const mediaDir = path.join(__dirname, 'media')
  const mediaPath = path.join(mediaDir, mediaFile)

  if (!fs.existsSync(mediaPath)) {
    return res.status(404).send('Media file not found. Add it to the /media directory.')
  }

  send(req, mediaFile, { root: mediaDir }).pipe(res)
})

// ---------------------------------------------------------------------------
// Static files
// ---------------------------------------------------------------------------
app.use(express.static(path.join(__dirname, 'public')))

// SPA fallback – serve index.html for any unmatched GET
app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'))
})

// ---------------------------------------------------------------------------
// Channel state
// ---------------------------------------------------------------------------
const channel = {
  launchTime: new Date().toISOString(),
  currentTime: 0
}

function getSettings() {
  const rows = db.prepare('SELECT key, value FROM settings').all()
  return Object.fromEntries(rows.map(r => [r.key, r.value]))
}

function broadcast(packet) {
  const data = JSON.stringify(packet)
  for (const client of wss.clients) {
    if (client.readyState === 1 /* OPEN */) client.send(data)
  }
}

// ---------------------------------------------------------------------------
// WebSocket server (shares the HTTP server – no separate port needed)
// ---------------------------------------------------------------------------
const wss = new WebSocketServer({ noServer: true })

// Parse sessions on WS upgrade so we know who the user is
httpServer.on('upgrade', (req, socket, head) => {
  sessionParser(req, {}, () => {
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.user = req.session?.user || null
      wss.emit('connection', ws, req)
    })
  })
})

wss.on('connection', (ws) => {
  const settings = getSettings()
  ws.send(JSON.stringify({
    type: 'welcome',
    message: {
      'server-launch-time': channel.launchTime,
      'message-of-the-day': settings['message-of-the-day'],
      'video-seek-time': channel.currentTime
    }
  }))

  ws.on('message', (raw) => {
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

// Heartbeat every second
const heartbeatInterval = setInterval(() => {
  broadcast({
    type: 'heartbeat',
    message: { 'server-time': new Date().toISOString(), 'video-seek-time': channel.currentTime }
  })
}, 1000)
heartbeatInterval.unref()

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
const PORT = parseInt(process.env.PORT || '3016', 10)

await ensureAdmin()

const mediaDir = path.join(__dirname, 'media')
if (!fs.existsSync(mediaDir)) fs.mkdirSync(mediaDir, { recursive: true })

const mediaFile = getSettings().media_file
if (!fs.existsSync(path.join(mediaDir, mediaFile))) {
  console.warn(`\x1b[33mWarning: media file "${mediaFile}" not found in /media\x1b[0m`)
}

httpServer.listen(PORT, () => {
  console.log(`\x1b[32m✓ Movie Night listening on http://localhost:${PORT}\x1b[0m`)
})
