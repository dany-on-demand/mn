import { scrypt, randomBytes, timingSafeEqual } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import fs from 'node:fs'

import Fastify from 'fastify'
import fastifyStatic from '@fastify/static'
import fastifyWebsocket from '@fastify/websocket'
import Database from 'better-sqlite3'
import send from 'send'

const __filename = fileURLToPath(import.meta.url)
const __dirname  = path.dirname(__filename)

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const SESSION_CLEANUP_INTERVAL_MS = 15 * 60 * 1000
const SESSION_MAX_AGE_S            = 7 * 24 * 60 * 60   // 1 week
const SESSION_COOKIE               = 'mn.sid'
const MAX_CHAT_MESSAGE_LENGTH      = 500
const MAX_CHAT_USERNAME_LENGTH     = 64
const IS_PRODUCTION                = process.env.NODE_ENV === 'production'
const STATIC_DIR                   = path.join(__dirname, 'public')
const MEDIA_DIR                    = path.join(__dirname, 'media')

// Rate limit policies: [maxRequests, windowMs]
const RL_AUTH   = [20,  15 * 60 * 1000]
const RL_READ   = [120, 60_000]
const RL_WRITE  = [60,  60_000]
const RL_STREAM = [30,  60_000]
const RL_STATIC = [300, 60_000]

// ---------------------------------------------------------------------------
// Data directory & SQLite database
// ---------------------------------------------------------------------------
const DATA_DIR = path.join(__dirname, 'data')
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true })
if (!fs.existsSync(MEDIA_DIR)) fs.mkdirSync(MEDIA_DIR, { recursive: true })

const db = new Database(path.join(DATA_DIR, 'mn.db'))
db.pragma('journal_mode = WAL')
db.pragma('foreign_keys = ON')
db.pragma('synchronous = NORMAL')
db.pragma('cache_size = -16000')

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
// Prepared statements
// ---------------------------------------------------------------------------
const stmts = {
  getConfigValue:        db.prepare('SELECT value FROM app_config WHERE key = ?'),
  insertConfigValue:     db.prepare('INSERT INTO app_config (key, value) VALUES (?, ?)'),
  insertIgnoreSetting:   db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)'),
  upsertSetting:         db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)'),
  getAllSettings:        db.prepare('SELECT key, value FROM settings'),
  getUserByUsername:     db.prepare('SELECT * FROM users WHERE username = ?'),
  getUserById:           db.prepare('SELECT * FROM users WHERE id = ?'),
  getAdmin:              db.prepare("SELECT id FROM users WHERE role = 'admin' LIMIT 1"),
  insertUser:            db.prepare('INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)'),
  updatePassword:        db.prepare('UPDATE users SET password_hash = ? WHERE id = ?'),
  deleteUser:            db.prepare('DELETE FROM users WHERE id = ?'),
  listUsers:             db.prepare('SELECT id, username, role, created_at FROM users'),
  getSession:            db.prepare('SELECT sess FROM sessions WHERE sid = ? AND expire > ?'),
  upsertSession:         db.prepare('INSERT OR REPLACE INTO sessions (sid, sess, expire) VALUES (?, ?, ?)'),
  deleteSession:         db.prepare('DELETE FROM sessions WHERE sid = ?'),
  deleteExpiredSessions: db.prepare('DELETE FROM sessions WHERE expire < ?'),
}

// ---------------------------------------------------------------------------
// Seed default settings
// ---------------------------------------------------------------------------
const globalsPath = path.join(__dirname, 'config', 'globals.json')
const defaultSettings = fs.existsSync(globalsPath)
  ? JSON.parse(fs.readFileSync(globalsPath, 'utf8'))
  : { media_file: 'test.mp4', 'message-of-the-day': 'Welcome to movie night!' }

for (const [key, value] of Object.entries(defaultSettings)) {
  stmts.insertIgnoreSetting.run(key, String(value))
}

// Persistent session secret
let sessionSecret = process.env.SESSION_SECRET || stmts.getConfigValue.get('session_secret')?.value
if (!sessionSecret) {
  sessionSecret = randomBytes(32).toString('hex')
  stmts.insertConfigValue.run('session_secret', sessionSecret)
}

// ---------------------------------------------------------------------------
// Settings cache
// ---------------------------------------------------------------------------
let settingsCache = null
function getSettings() {
  if (!settingsCache) settingsCache = Object.fromEntries(stmts.getAllSettings.all().map(r => [r.key, r.value]))
  return settingsCache
}
function invalidateSettings() { settingsCache = null; rebuildMediaCache(); rebuildWelcomePrefix() }

// ---------------------------------------------------------------------------
// Media path cache
// ---------------------------------------------------------------------------
let cachedMediaFile = null
let cachedMediaPath = null
let mediaFileExists = false

function rebuildMediaCache() {
  const file     = getSettings().media_file || 'test.mp4'
  const resolved = path.resolve(MEDIA_DIR, file)
  if (!resolved.startsWith(MEDIA_DIR + path.sep)) {
    console.warn(`[security] media_file "${file}" escapes media directory — ignoring`)
    cachedMediaFile = 'test.mp4'
    cachedMediaPath = path.join(MEDIA_DIR, 'test.mp4')
  } else {
    cachedMediaFile = file
    cachedMediaPath = resolved
  }
  mediaFileExists = fs.existsSync(cachedMediaPath)
}

// ---------------------------------------------------------------------------
// Password helpers
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
    const salt   = Buffer.from(saltHex, 'hex')
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
  if (stmts.getAdmin.get()) return
  const adminUser = process.env.ADMIN_USERNAME || 'admin'
  const adminPass = process.env.ADMIN_PASSWORD || randomBytes(8).toString('hex')
  stmts.insertUser.run(adminUser, await hashPassword(adminPass), 'admin')
  console.log('\n\x1b[33m┌─ Admin account created ────────────────────────┐\x1b[0m')
  console.log(`\x1b[33m│\x1b[0m  Username : \x1b[32m${adminUser}\x1b[0m`)
  console.log(`\x1b[33m│\x1b[0m  Password : \x1b[32m${adminPass}\x1b[0m`)
  console.log('\x1b[33m│\x1b[0m  \x1b[31mChange this password after first login!\x1b[0m')
  console.log('\x1b[33m└────────────────────────────────────────────────┘\x1b[0m\n')
}

// ---------------------------------------------------------------------------
// Session management
// ---------------------------------------------------------------------------
setInterval(() => stmts.deleteExpiredSessions.run(Math.floor(Date.now() / 1000)), SESSION_CLEANUP_INTERVAL_MS).unref()

function parseCookies(cookieHeader) {
  const out = {}
  for (const part of (cookieHeader || '').split(';')) {
    const idx = part.indexOf('=')
    if (idx < 1) continue
    const k = part.slice(0, idx).trim()
    try { out[k] = decodeURIComponent(part.slice(idx + 1).trim()) } catch { out[k] = part.slice(idx + 1).trim() }
  }
  return out
}

async function loadSession(request) {
  const sid = parseCookies(request.headers.cookie)[SESSION_COOKIE]
  if (sid) {
    const row = stmts.getSession.get(sid, Math.floor(Date.now() / 1000))
    if (row) {
      try {
        request.sessionId    = sid
        request.session      = JSON.parse(row.sess)
        request.sessionIsNew = false
        return
      } catch {}
    }
  }
  request.sessionId    = randomBytes(16).toString('hex')
  request.session      = {}
  request.sessionIsNew = true
}

function saveSession(request, reply) {
  if (!request.sessionId) return
  stmts.upsertSession.run(request.sessionId, JSON.stringify(request.session), Math.floor(Date.now() / 1000) + SESSION_MAX_AGE_S)
  if (request.sessionIsNew) {
    const secure = IS_PRODUCTION ? '; Secure' : ''
    reply.header('Set-Cookie', `${SESSION_COOKIE}=${request.sessionId}; HttpOnly; SameSite=Strict${secure}; Max-Age=${SESSION_MAX_AGE_S}; Path=/`)
    request.sessionIsNew = false
  }
}

function destroySession(request, reply) {
  if (request.sessionId) stmts.deleteSession.run(request.sessionId)
  reply.header('Set-Cookie', `${SESSION_COOKIE}=; HttpOnly; Max-Age=0; Path=/`)
  request.session   = {}
  request.sessionId = null
}

// ---------------------------------------------------------------------------
// Rate limiting — in-memory sliding window
// ---------------------------------------------------------------------------
const rlStore = new Map()
setInterval(() => {
  const now = Date.now()
  for (const [k, v] of rlStore) if (now > v.resetAt) rlStore.delete(k)
}, 60_000).unref()

function rateLimited(ip, [maxReqs, windowMs]) {
  const key = `${ip}:${maxReqs}:${windowMs}`
  const now = Date.now()
  let e = rlStore.get(key)
  if (!e || now > e.resetAt) { rlStore.set(key, { count: 1, resetAt: now + windowMs }); return false }
  return ++e.count > maxReqs
}

// ---------------------------------------------------------------------------
// CSRF check
// ---------------------------------------------------------------------------
function csrfCheck(request, reply) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(request.method)) return true
  const s = request.session?.csrfToken
  const h = request.headers['x-csrf-token']
  if (!s || !h || s.length !== h.length) { reply.code(403).send({ error: 'Invalid CSRF token' }); return false }
  try { if (timingSafeEqual(Buffer.from(s), Buffer.from(h))) return true } catch {}
  reply.code(403).send({ error: 'Invalid CSRF token' })
  return false
}

// ---------------------------------------------------------------------------
// Auth guards
// ---------------------------------------------------------------------------
function requireAuth(request, reply) {
  if (request.session?.user) return true
  reply.code(401).send({ error: 'Unauthorised' })
  return false
}
function requireAdmin(request, reply) {
  if (request.session?.user?.role === 'admin') return true
  reply.code(403).send({ error: 'Forbidden' })
  return false
}

// ---------------------------------------------------------------------------
// Channel state + WebSocket broadcast
// ---------------------------------------------------------------------------
const channel = { launchTime: new Date().toISOString(), currentTime: 0 }

let heartbeatFrame = ''
function buildHeartbeatFrame() {
  heartbeatFrame = `{"type":"heartbeat","message":{"server-time":"${new Date().toISOString()}","video-seek-time":${channel.currentTime}}}`
}

let welcomePrefix = ''
function rebuildWelcomePrefix() {
  const motd = JSON.stringify(getSettings()['message-of-the-day'] || '')
  welcomePrefix = `{"type":"welcome","message":{"server-launch-time":"${channel.launchTime}","message-of-the-day":${motd},"video-seek-time":`
}
function buildWelcomeFrame() { return `${welcomePrefix}${channel.currentTime}}}` }

// wss is assigned after Fastify registers @fastify/websocket
let wss = null
function broadcast(packet) {
  if (!wss) return
  const data = JSON.stringify(packet)
  for (const client of wss.clients) if (client.readyState === 1) client.send(data)
}
function broadcastRaw(data) {
  if (!wss) return
  for (const client of wss.clients) if (client.readyState === 1) client.send(data)
}

// ---------------------------------------------------------------------------
// Fastify application
// ---------------------------------------------------------------------------
const app = Fastify({
  logger: false,
  trustProxy: IS_PRODUCTION,
  bodyLimit: 16384,
  // Disable the default 400ms keep-alive drain — we handle our own lifecycle
  keepAliveTimeout: 5000,
  connectionTimeout: 0,
})

// Security headers on every response
app.addHook('onSend', async (request, reply) => {
  reply.header('X-Content-Type-Options',   'nosniff')
  reply.header('X-Frame-Options',          'SAMEORIGIN')
  reply.header('Referrer-Policy',          'same-origin')
  reply.header('Permissions-Policy',       'camera=(), microphone=(), geolocation=()')
  if (IS_PRODUCTION) reply.header('Strict-Transport-Security', 'max-age=63072000; includeSubDomains')
})

// Session on API and WebSocket routes
app.addHook('preHandler', async (request) => {
  if (request.url.startsWith('/api/') || request.url.startsWith('/ws')) await loadSession(request)
})

// Register WebSocket plugin
await app.register(fastifyWebsocket, { options: { maxPayload: 65536 } })
wss = app.websocketServer

// Register static file serving (SPA)
await app.register(fastifyStatic, {
  root: STATIC_DIR,
  prefix: '/',
  dotfiles: 'deny',
  etag: true,
  lastModified: true,
  cacheControl: false,   // we set Cache-Control ourselves below
  setHeaders: (res, filePath) => {
    res.setHeader('Cache-Control', filePath.endsWith('.html') ? 'no-cache' : 'public, max-age=86400')
  },
})

// ---------------------------------------------------------------------------
// Static rate limiting
// ---------------------------------------------------------------------------
app.addHook('onRequest', async (request, reply) => {
  // Only rate-limit static assets (non-API, non-stream, non-WS)
  if (
    !request.url.startsWith('/api/') &&
    request.url !== '/stream' &&
    !request.url.startsWith('/ws')
  ) {
    if (rateLimited(request.ip, RL_STATIC)) {
      reply.code(429).send('Too many requests')
    }
  }
})

// ---------------------------------------------------------------------------
// Video stream — `send` handles byte-range natively
// ---------------------------------------------------------------------------
app.get('/stream', async (request, reply) => {
  if (rateLimited(request.ip, RL_STREAM)) return reply.code(429).send('Too many requests')
  if (!mediaFileExists) return reply.code(404).send('Media file not found. Add it to the /media directory.')
  // Use `send` via the raw Node.js response for proper Range support
  return new Promise((resolve, reject) => {
    send(request.raw, cachedMediaFile, { root: MEDIA_DIR })
      .on('error', (err) => { reply.raw.writeHead(err.status || 500); reply.raw.end(); resolve() })
      .on('end', resolve)
      .pipe(reply.raw)
  })
})

// ---------------------------------------------------------------------------
// WebSocket endpoint
// ---------------------------------------------------------------------------
const wsClientsByIp = new Map()

app.get('/ws', { websocket: true }, (socket, request) => {
  const ip = request.ip
  if ((wsClientsByIp.get(ip) ?? 0) >= 5) {
    socket.close(1008, 'Too many connections from this IP')
    return
  }
  wsClientsByIp.set(ip, (wsClientsByIp.get(ip) ?? 0) + 1)
  socket.on('close', () => {
    const n = wsClientsByIp.get(ip) ?? 1
    if (n <= 1) wsClientsByIp.delete(ip)
    else wsClientsByIp.set(ip, n - 1)
  })

  const sessionUser = request.session?.user || null
  socket.user = sessionUser

  socket.send(buildWelcomeFrame())

  let msgCount = 0
  const msgReset = setInterval(() => { msgCount = 0 }, 1000)
  socket.on('close', () => clearInterval(msgReset))

  socket.on('message', (raw) => {
    if (++msgCount > 10) return
    let packet
    try { packet = JSON.parse(raw) } catch { return }

    switch (packet.type) {
      case 'admin-seek-time-update':
        if (socket.user?.role !== 'admin') return
        channel.currentTime = Number(packet.message?.['video-seek-time']) || 0
        break

      case 'chat-message': {
        const msg       = packet.message || {}
        const chatText  = String(msg['chat-message']        || '').trim().slice(0, MAX_CHAT_MESSAGE_LENGTH)
        const chatOwner = String(msg['chat-message-owner'] || 'Anonymous').trim().slice(0, MAX_CHAT_USERNAME_LENGTH)
        if (!chatText) return
        broadcast({
          type: 'incoming-chat-message',
          message: { 'server-time': new Date().toISOString(), 'chat-message': chatText, 'chat-message-owner': chatOwner }
        })
        break
      }
    }
  })
})

// ---------------------------------------------------------------------------
// API routes
// ---------------------------------------------------------------------------
app.get('/api/csrf-token', async (request, reply) => {
  if (!request.session.csrfToken) request.session.csrfToken = randomBytes(32).toString('hex')
  saveSession(request, reply)
  return { csrfToken: request.session.csrfToken }
})

app.get('/api/auth/me', async (request, reply) => {
  const u = request.session.user
  return reply.send(u ? { id: u.id, username: u.username, role: u.role } : null)
})

app.post('/api/auth/login', async (request, reply) => {
  if (rateLimited(request.ip, RL_AUTH)) return reply.code(429).send({ error: 'Too many requests, please try again later' })
  if (!csrfCheck(request, reply)) return
  const { username, password } = request.body || {}
  if (!username || !password)    return reply.code(400).send({ error: 'Username and password are required' })
  if (username.length > 64)      return reply.code(400).send({ error: 'Invalid credentials' })
  const user = stmts.getUserByUsername.get(username)
  if (!user)                     return reply.code(401).send({ error: 'Invalid credentials' })
  let valid = false
  try { valid = await verifyPassword(password, user.password_hash) } catch {}
  if (!valid)                    return reply.code(401).send({ error: 'Invalid credentials' })
  request.session.user = { id: user.id, username: user.username, role: user.role }
  saveSession(request, reply)
  return request.session.user
})

app.post('/api/auth/logout', async (request, reply) => {
  if (!requireAuth(request, reply)) return
  if (!csrfCheck(request, reply)) return
  destroySession(request, reply)
  return { ok: true }
})

app.post('/api/auth/change-password', async (request, reply) => {
  if (!requireAuth(request, reply))    return
  if (!csrfCheck(request, reply))      return
  if (rateLimited(request.ip, RL_AUTH)) return reply.code(429).send({ error: 'Too many requests, please try again later' })
  const { currentPassword, newPassword } = request.body || {}
  if (!currentPassword || !newPassword) return reply.code(400).send({ error: 'currentPassword and newPassword are required' })
  if (newPassword.length < 8)           return reply.code(400).send({ error: 'New password must be at least 8 characters' })
  const user = stmts.getUserById.get(request.session.user.id)
  if (!user) return reply.code(404).send({ error: 'User not found' })
  if (!await verifyPassword(currentPassword, user.password_hash)) return reply.code(401).send({ error: 'Current password is incorrect' })
  stmts.updatePassword.run(await hashPassword(newPassword), user.id)
  return { ok: true }
})

app.get('/api/settings', async (request, reply) => {
  if (!requireAdmin(request, reply))    return
  if (rateLimited(request.ip, RL_READ)) return reply.code(429).send({ error: 'Too many requests, please try again later' })
  return getSettings()
})

app.post('/api/settings', async (request, reply) => {
  if (!requireAdmin(request, reply))     return
  if (!csrfCheck(request, reply))        return
  if (rateLimited(request.ip, RL_WRITE)) return reply.code(429).send({ error: 'Too many requests, please try again later' })
  const body = request.body || {}
  if (body.media_file) {
    const resolved = path.resolve(MEDIA_DIR, body.media_file)
    if (!resolved.startsWith(MEDIA_DIR + path.sep)) return reply.code(400).send({ error: 'Invalid media file path' })
  }
  const oldMedia = getSettings().media_file
  db.transaction(() => { for (const [k, v] of Object.entries(body)) stmts.upsertSetting.run(k, String(v)) })()
  invalidateSettings()
  if (body.media_file && body.media_file !== oldMedia) {
    channel.currentTime = 0
    broadcast({ type: 'authoritative', message: { 'server-time': new Date().toISOString(), 'video-seek-time': 0 } })
  }
  return { ok: true }
})

app.get('/api/users', async (request, reply) => {
  if (!requireAdmin(request, reply))    return
  if (rateLimited(request.ip, RL_READ)) return reply.code(429).send({ error: 'Too many requests, please try again later' })
  return stmts.listUsers.all()
})

app.post('/api/users', async (request, reply) => {
  if (!requireAdmin(request, reply))     return
  if (!csrfCheck(request, reply))        return
  if (rateLimited(request.ip, RL_WRITE)) return reply.code(429).send({ error: 'Too many requests, please try again later' })
  const { username, password, role = 'user' } = request.body || {}
  if (!username || !password)            return reply.code(400).send({ error: 'username and password are required' })
  if (!['user', 'admin'].includes(role)) return reply.code(400).send({ error: 'role must be user or admin' })
  try {
    const result = stmts.insertUser.run(username, await hashPassword(password), role)
    return { id: result.lastInsertRowid, username, role }
  } catch (e) {
    if (e.code === 'SQLITE_CONSTRAINT_UNIQUE') return reply.code(409).send({ error: 'Username already exists' })
    throw e
  }
})

app.delete('/api/users/:id', async (request, reply) => {
  if (!requireAdmin(request, reply))     return
  if (!csrfCheck(request, reply))        return
  if (rateLimited(request.ip, RL_WRITE)) return reply.code(429).send({ error: 'Too many requests, please try again later' })
  const id = parseInt(request.params.id, 10)
  if (!id)                          return reply.code(400).send({ error: 'Invalid user id' })
  if (id === request.session.user.id) return reply.code(400).send({ error: 'Cannot delete your own account' })
  const result = stmts.deleteUser.run(id)
  if (result.changes === 0)          return reply.code(404).send({ error: 'User not found' })
  return { ok: true }
})

app.get('/api/media', async (request, reply) => {
  if (!requireAdmin(request, reply))    return
  if (rateLimited(request.ip, RL_READ)) return reply.code(429).send({ error: 'Too many requests, please try again later' })
  try {
    return (await fs.promises.readdir(MEDIA_DIR)).filter(f => !f.startsWith('.'))
  } catch {
    return []
  }
})

// SPA fallback — serve index.html for unmatched paths
app.setNotFoundHandler(async (request, reply) => {
  if (request.url.startsWith('/api/')) return reply.code(404).send({ error: 'Not found' })
  return reply.sendFile('index.html')
})

// ---------------------------------------------------------------------------
// Heartbeat
// ---------------------------------------------------------------------------
const heartbeatInterval = setInterval(() => {
  if (!wss || wss.clients.size === 0) return
  buildHeartbeatFrame()
  broadcastRaw(heartbeatFrame)
}, 1000)
heartbeatInterval.unref()

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
const PORT = parseInt(process.env.PORT || '3016', 10)

await ensureAdmin()

getSettings()
rebuildMediaCache()
rebuildWelcomePrefix()

if (!mediaFileExists) {
  console.warn(`\x1b[33mWarning: media file "${cachedMediaFile}" not found in /media\x1b[0m`)
}

await app.listen({ port: PORT, host: '0.0.0.0' })  // 0.0.0.0 required for Docker/container environments
console.log(`\x1b[32m✓ Movie Night listening on http://localhost:${PORT}\x1b[0m`)
