import { createServer } from 'node:http'
import { scrypt, randomBytes, timingSafeEqual } from 'node:crypto'
import { gzipSync } from 'node:zlib'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import fs from 'node:fs'

import Database from 'better-sqlite3'
import { WebSocketServer } from 'ws'
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

// Rate limit policies: [maxRequests, windowMs]
const RL_AUTH   = [20,  15 * 60 * 1000]  // login / password change
const RL_READ   = [120, 60_000]           // admin reads
const RL_WRITE  = [60,  60_000]           // admin writes
const RL_STREAM = [30,  60_000]           // video byte-range requests
const RL_STATIC = [300, 60_000]           // static assets

// ---------------------------------------------------------------------------
// Data directory & SQLite database
// ---------------------------------------------------------------------------
const DATA_DIR = path.join(__dirname, 'data')
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true })

const db = new Database(path.join(DATA_DIR, 'mn.db'))
db.pragma('journal_mode = WAL')
db.pragma('foreign_keys = ON')
db.pragma('synchronous = NORMAL')   // safe with WAL, ~2× faster writes
db.pragma('cache_size = -16000')    // 16 MB page cache

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
// Pre-compiled prepared statements — compile once, run many
// ---------------------------------------------------------------------------
const stmts = {
  // app_config
  getConfigValue:        db.prepare('SELECT value FROM app_config WHERE key = ?'),
  insertConfigValue:     db.prepare('INSERT INTO app_config (key, value) VALUES (?, ?)'),
  // settings
  insertIgnoreSetting:   db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)'),
  upsertSetting:         db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)'),
  getAllSettings:        db.prepare('SELECT key, value FROM settings'),
  // users
  getUserByUsername:     db.prepare('SELECT * FROM users WHERE username = ?'),
  getUserById:           db.prepare('SELECT * FROM users WHERE id = ?'),
  getAdmin:              db.prepare("SELECT id FROM users WHERE role = 'admin' LIMIT 1"),
  insertUser:            db.prepare('INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)'),
  updatePassword:        db.prepare('UPDATE users SET password_hash = ? WHERE id = ?'),
  deleteUser:            db.prepare('DELETE FROM users WHERE id = ?'),
  listUsers:             db.prepare('SELECT id, username, role, created_at FROM users'),
  // sessions
  getSession:            db.prepare('SELECT sess FROM sessions WHERE sid = ? AND expire > ?'),
  upsertSession:         db.prepare('INSERT OR REPLACE INTO sessions (sid, sess, expire) VALUES (?, ?, ?)'),
  deleteSession:         db.prepare('DELETE FROM sessions WHERE sid = ?'),
  deleteExpiredSessions: db.prepare('DELETE FROM sessions WHERE expire < ?'),
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
// Persistent session secret — stored in DB so it survives restarts.
// Not used for cookie signing yet (128-bit random IDs are sufficient),
// but kept for future HMAC hardening.
// ---------------------------------------------------------------------------
let sessionSecret = process.env.SESSION_SECRET || stmts.getConfigValue.get('session_secret')?.value
if (!sessionSecret) {
  sessionSecret = randomBytes(32).toString('hex')
  stmts.insertConfigValue.run('session_secret', sessionSecret)
}

// ---------------------------------------------------------------------------
// Settings cache — avoids a DB round-trip on every heartbeat / stream request
// ---------------------------------------------------------------------------
let settingsCache = null

function getSettings() {
  if (!settingsCache) {
    settingsCache = Object.fromEntries(stmts.getAllSettings.all().map(r => [r.key, r.value]))
  }
  return settingsCache
}

function invalidateSettings() {
  settingsCache = null
  rebuildMediaCache()
  rebuildWelcomePrefix()
}

// ---------------------------------------------------------------------------
// Media path cache — eliminates path.join + existsSync on every /stream req
// ---------------------------------------------------------------------------
const MEDIA_DIR = path.join(__dirname, 'media')
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
// Password helpers — inline callbacks avoid promisify allocation
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
// Session management — replaces express-session (no npm package needed)
// ---------------------------------------------------------------------------
setInterval(() => stmts.deleteExpiredSessions.run(Math.floor(Date.now() / 1000)), SESSION_CLEANUP_INTERVAL_MS).unref()

function parseCookies(req) {
  const out = {}
  for (const part of (req.headers.cookie || '').split(';')) {
    const idx = part.indexOf('=')
    if (idx < 1) continue
    const k = part.slice(0, idx).trim()
    try { out[k] = decodeURIComponent(part.slice(idx + 1).trim()) } catch { out[k] = part.slice(idx + 1).trim() }
  }
  return out
}

async function loadSession(req) {
  const sid = parseCookies(req)[SESSION_COOKIE]
  if (sid) {
    const row = stmts.getSession.get(sid, Math.floor(Date.now() / 1000))
    if (row) {
      try {
        req.sessionId   = sid
        req.session     = JSON.parse(row.sess)
        req.sessionIsNew = false
        return
      } catch {}
    }
  }
  req.sessionId   = randomBytes(16).toString('hex')
  req.session     = {}
  req.sessionIsNew = true
}

function saveSession(req, res) {
  if (!req.sessionId) return
  stmts.upsertSession.run(req.sessionId, JSON.stringify(req.session), Math.floor(Date.now() / 1000) + SESSION_MAX_AGE_S)
  if (req.sessionIsNew) {
    const secure = IS_PRODUCTION ? '; Secure' : ''
    res.setHeader('Set-Cookie', `${SESSION_COOKIE}=${req.sessionId}; HttpOnly; SameSite=Strict${secure}; Max-Age=${SESSION_MAX_AGE_S}; Path=/`)
    req.sessionIsNew = false
  }
}

function destroySession(req, res) {
  if (req.sessionId) stmts.deleteSession.run(req.sessionId)
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; HttpOnly; Max-Age=0; Path=/`)
  req.session  = {}
  req.sessionId = null
}

// ---------------------------------------------------------------------------
// Rate limiting — in-memory sliding window, replaces express-rate-limit
// ---------------------------------------------------------------------------
const rlStore = new Map()
setInterval(() => {
  const now = Date.now()
  for (const [k, v] of rlStore) if (now > v.resetAt) rlStore.delete(k)
}, 60_000).unref()

function getIp(req) {
  // Trust X-Forwarded-For only in production (behind a reverse proxy)
  if (IS_PRODUCTION) {
    const fwd = req.headers['x-forwarded-for']
    if (fwd) return fwd.split(',')[0].trim()
  }
  return req.socket.remoteAddress || 'unknown'
}

// Returns true if this request is over the limit (should be rejected)
function rateLimited(req, [maxReqs, windowMs]) {
  const key = `${getIp(req)}:${maxReqs}:${windowMs}`
  const now = Date.now()
  let e = rlStore.get(key)
  if (!e || now > e.resetAt) { rlStore.set(key, { count: 1, resetAt: now + windowMs }); return false }
  return ++e.count > maxReqs
}

// ---------------------------------------------------------------------------
// HTTP response helpers
// ---------------------------------------------------------------------------
function setSecurityHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('X-Frame-Options', 'SAMEORIGIN')
  res.setHeader('Referrer-Policy', 'same-origin')
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()')
  if (IS_PRODUCTION) res.setHeader('Strict-Transport-Security', 'max-age=63072000; includeSubDomains')
}

// Sends JSON — gzip compressed if client accepts it and body > 256 bytes
function sendJson(req, res, status, data) {
  const buf     = Buffer.from(JSON.stringify(data), 'utf8')
  const headers = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
  if ((req.headers['accept-encoding'] || '').includes('gzip') && buf.length > 256) {
    const gz = gzipSync(buf)
    headers['Content-Encoding'] = 'gzip'
    headers['Content-Length']   = gz.length
    res.writeHead(status, headers)
    res.end(gz)
  } else {
    headers['Content-Length'] = buf.length
    res.writeHead(status, headers)
    res.end(buf)
  }
}

// Reads up to 16 KB of the request body and parses it as JSON
async function parseJsonBody(req) {
  return new Promise((resolve) => {
    const chunks = []
    let size = 0
    req.on('data', chunk => {
      size += chunk.length
      if (size > 16384) { req.destroy(); resolve({}) }
      else chunks.push(chunk)
    })
    req.on('end',   () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))) } catch { resolve({}) } })
    req.on('error', () => resolve({}))
  })
}

// Serves a file from STATIC_DIR using `send` (handles ETags, range requests,
// MIME types). Falls back to index.html for unknown paths (SPA routing).
function serveStatic(req, res, pathname) {
  send(req, pathname, { root: STATIC_DIR, dotfiles: 'deny', etag: true, lastModified: true })
    .on('headers', (res, fp) => {
      res.setHeader('Cache-Control', fp.endsWith('.html') ? 'no-cache' : 'public, max-age=86400')
    })
    .on('error', (err) => {
      if (err.status === 404) {
        // SPA fallback — serve index.html for any unknown path
        send(req, '/index.html', { root: STATIC_DIR })
          .on('headers', r => r.setHeader('Cache-Control', 'no-cache'))
          .on('error',   () => { res.writeHead(500); res.end() })
          .pipe(res)
      } else {
        res.writeHead(err.status || 500); res.end()
      }
    })
    .pipe(res)
}

// ---------------------------------------------------------------------------
// CSRF — synchronizer token pattern
// ---------------------------------------------------------------------------
function csrfCheck(req, res) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return true
  const s = req.session?.csrfToken
  const h = req.headers['x-csrf-token']
  if (!s || !h || s.length !== h.length) { sendJson(req, res, 403, { error: 'Invalid CSRF token' }); return false }
  try { if (timingSafeEqual(Buffer.from(s), Buffer.from(h))) return true } catch {}
  sendJson(req, res, 403, { error: 'Invalid CSRF token' })
  return false
}

// ---------------------------------------------------------------------------
// Auth guards
// ---------------------------------------------------------------------------
function requireAuth(req, res) {
  if (req.session?.user) return true
  sendJson(req, res, 401, { error: 'Unauthorised' })
  return false
}

function requireAdmin(req, res) {
  if (req.session?.user?.role === 'admin') return true
  sendJson(req, res, 403, { error: 'Forbidden' })
  return false
}

// ---------------------------------------------------------------------------
// Channel state + broadcast helpers
// ---------------------------------------------------------------------------
const channel = {
  launchTime:  new Date().toISOString(),
  currentTime: 0
}

// WebSocket server — declared here so broadcast can reference wss.clients
const wss = new WebSocketServer({ noServer: true })

// Heartbeat frame — built once per tick, sent as the same string to all clients
let heartbeatFrame = ''
function buildHeartbeatFrame() {
  heartbeatFrame = `{"type":"heartbeat","message":{"server-time":"${new Date().toISOString()}","video-seek-time":${channel.currentTime}}}`
}

// Welcome frame prefix — rebuilt only when settings change
let welcomePrefix = ''
function rebuildWelcomePrefix() {
  const motd  = JSON.stringify(getSettings()['message-of-the-day'] || '')
  welcomePrefix = `{"type":"welcome","message":{"server-launch-time":"${channel.launchTime}","message-of-the-day":${motd},"video-seek-time":`
}
function buildWelcomeFrame() { return `${welcomePrefix}${channel.currentTime}}}` }

function broadcast(packet) {
  const data = JSON.stringify(packet)
  for (const client of wss.clients) if (client.readyState === 1) client.send(data)
}
function broadcastRaw(data) {
  for (const client of wss.clients) if (client.readyState === 1) client.send(data)
}

// ---------------------------------------------------------------------------
// API routes — flat if/else, no framework needed
// ---------------------------------------------------------------------------
async function handleApi(req, res, pathname, body) {
  if (!csrfCheck(req, res)) return

  if (req.method === 'GET' && pathname === '/api/csrf-token') {
    if (!req.session.csrfToken) req.session.csrfToken = randomBytes(32).toString('hex')
    saveSession(req, res)
    return sendJson(req, res, 200, { csrfToken: req.session.csrfToken })
  }

  if (req.method === 'GET' && pathname === '/api/auth/me') {
    const u = req.session.user
    return sendJson(req, res, 200, u ? { id: u.id, username: u.username, role: u.role } : null)
  }

  if (req.method === 'POST' && pathname === '/api/auth/login') {
    if (rateLimited(req, RL_AUTH)) return sendJson(req, res, 429, { error: 'Too many requests, please try again later' })
    const { username, password } = body
    if (!username || !password)    return sendJson(req, res, 400, { error: 'Username and password are required' })
    if (username.length > 64)      return sendJson(req, res, 400, { error: 'Invalid credentials' })
    const user = stmts.getUserByUsername.get(username)
    if (!user)                     return sendJson(req, res, 401, { error: 'Invalid credentials' })
    let valid = false
    try { valid = await verifyPassword(password, user.password_hash) } catch {}
    if (!valid)                    return sendJson(req, res, 401, { error: 'Invalid credentials' })
    req.session.user = { id: user.id, username: user.username, role: user.role }
    saveSession(req, res)
    return sendJson(req, res, 200, req.session.user)
  }

  if (req.method === 'POST' && pathname === '/api/auth/logout') {
    if (!requireAuth(req, res)) return
    destroySession(req, res)
    return sendJson(req, res, 200, { ok: true })
  }

  if (req.method === 'POST' && pathname === '/api/auth/change-password') {
    if (!requireAuth(req, res))    return
    if (rateLimited(req, RL_AUTH)) return sendJson(req, res, 429, { error: 'Too many requests, please try again later' })
    const { currentPassword, newPassword } = body
    if (!currentPassword || !newPassword) return sendJson(req, res, 400, { error: 'currentPassword and newPassword are required' })
    if (newPassword.length < 8)           return sendJson(req, res, 400, { error: 'New password must be at least 8 characters' })
    const user = stmts.getUserById.get(req.session.user.id)
    if (!user) return sendJson(req, res, 404, { error: 'User not found' })
    if (!await verifyPassword(currentPassword, user.password_hash)) return sendJson(req, res, 401, { error: 'Current password is incorrect' })
    stmts.updatePassword.run(await hashPassword(newPassword), user.id)
    return sendJson(req, res, 200, { ok: true })
  }

  if (req.method === 'GET' && pathname === '/api/settings') {
    if (!requireAdmin(req, res))    return
    if (rateLimited(req, RL_READ)) return sendJson(req, res, 429, { error: 'Too many requests, please try again later' })
    return sendJson(req, res, 200, getSettings())
  }

  if (req.method === 'POST' && pathname === '/api/settings') {
    if (!requireAdmin(req, res))     return
    if (rateLimited(req, RL_WRITE)) return sendJson(req, res, 429, { error: 'Too many requests, please try again later' })
    if (body.media_file) {
      const resolved = path.resolve(MEDIA_DIR, body.media_file)
      if (!resolved.startsWith(MEDIA_DIR + path.sep)) return sendJson(req, res, 400, { error: 'Invalid media file path' })
    }
    const oldMedia = getSettings().media_file
    db.transaction(() => { for (const [k, v] of Object.entries(body)) stmts.upsertSetting.run(k, String(v)) })()
    invalidateSettings()
    if (body.media_file && body.media_file !== oldMedia) {
      channel.currentTime = 0
      broadcast({ type: 'authoritative', message: { 'server-time': new Date().toISOString(), 'video-seek-time': 0 } })
    }
    return sendJson(req, res, 200, { ok: true })
  }

  if (req.method === 'GET' && pathname === '/api/users') {
    if (!requireAdmin(req, res))    return
    if (rateLimited(req, RL_READ)) return sendJson(req, res, 429, { error: 'Too many requests, please try again later' })
    return sendJson(req, res, 200, stmts.listUsers.all())
  }

  if (req.method === 'POST' && pathname === '/api/users') {
    if (!requireAdmin(req, res))     return
    if (rateLimited(req, RL_WRITE)) return sendJson(req, res, 429, { error: 'Too many requests, please try again later' })
    const { username, password, role = 'user' } = body
    if (!username || !password)               return sendJson(req, res, 400, { error: 'username and password are required' })
    if (!['user', 'admin'].includes(role))    return sendJson(req, res, 400, { error: 'role must be user or admin' })
    try {
      const result = stmts.insertUser.run(username, await hashPassword(password), role)
      return sendJson(req, res, 200, { id: result.lastInsertRowid, username, role })
    } catch (e) {
      if (e.code === 'SQLITE_CONSTRAINT_UNIQUE') return sendJson(req, res, 409, { error: 'Username already exists' })
      throw e
    }
  }

  if (req.method === 'DELETE' && pathname.startsWith('/api/users/')) {
    if (!requireAdmin(req, res))     return
    if (rateLimited(req, RL_WRITE)) return sendJson(req, res, 429, { error: 'Too many requests, please try again later' })
    const id = parseInt(pathname.split('/').pop(), 10)
    if (!id)                             return sendJson(req, res, 400, { error: 'Invalid user id' })
    if (id === req.session.user.id)      return sendJson(req, res, 400, { error: 'Cannot delete your own account' })
    const result = stmts.deleteUser.run(id)
    if (result.changes === 0)            return sendJson(req, res, 404, { error: 'User not found' })
    return sendJson(req, res, 200, { ok: true })
  }

  if (req.method === 'GET' && pathname === '/api/media') {
    if (!requireAdmin(req, res))    return
    if (rateLimited(req, RL_READ)) return sendJson(req, res, 429, { error: 'Too many requests, please try again later' })
    try {
      return sendJson(req, res, 200, (await fs.promises.readdir(MEDIA_DIR)).filter(f => !f.startsWith('.')))
    } catch {
      return sendJson(req, res, 200, [])
    }
  }

  sendJson(req, res, 404, { error: 'Not found' })
}

// ---------------------------------------------------------------------------
// HTTP server — one flat async handler, no middleware stack
// ---------------------------------------------------------------------------
const httpServer = createServer(async (req, res) => {
  let pathname
  try { pathname = new URL(req.url, 'http://x').pathname }
  catch { res.writeHead(400); return res.end('Bad request') }

  setSecurityHeaders(res)

  // Video stream — rate-limited, no body parsing, no session needed
  if (pathname === '/stream') {
    if (rateLimited(req, RL_STREAM)) { res.writeHead(429); return res.end('Too many requests') }
    if (!mediaFileExists) { res.writeHead(404); return res.end('Media file not found. Add it to the /media directory.') }
    return send(req, cachedMediaFile, { root: MEDIA_DIR }).pipe(res)
  }

  // JSON API
  if (pathname.startsWith('/api/')) {
    let body = {}
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) body = await parseJsonBody(req)
    await loadSession(req)
    return handleApi(req, res, pathname, body)
  }

  // Static files + SPA fallback
  if (rateLimited(req, RL_STATIC)) { res.writeHead(429); return res.end('Too many requests') }
  serveStatic(req, res, pathname)
})

// ---------------------------------------------------------------------------
// WebSocket server — shares the HTTP server, no separate port
// ---------------------------------------------------------------------------

// Per-IP connection cap (5) — prevents socket-flood DoS
const wsClientsByIp = new Map()

httpServer.on('upgrade', async (req, socket, head) => {
  const ip = req.socket.remoteAddress || 'unknown'
  if ((wsClientsByIp.get(ip) ?? 0) >= 5) {
    socket.write('HTTP/1.1 429 Too Many Connections\r\n\r\n')
    socket.destroy()
    return
  }
  await loadSession(req)
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

wss.on('connection', (ws) => {
  ws.send(buildWelcomeFrame())

  // Per-connection message rate limit — max 10/s, drops excess silently
  let msgCount = 0
  const msgReset = setInterval(() => { msgCount = 0 }, 1000)
  ws.on('close', () => clearInterval(msgReset))

  ws.on('message', (raw) => {
    if (++msgCount > 10) return
    let packet
    try { packet = JSON.parse(raw) } catch { return }

    switch (packet.type) {
      case 'admin-seek-time-update':
        if (ws.user?.role !== 'admin') return
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

// Heartbeat every second — skip when no clients to avoid pointless work
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

// Warm caches before first request
getSettings()
rebuildMediaCache()
rebuildWelcomePrefix()

if (!mediaFileExists) {
  console.warn(`\x1b[33mWarning: media file "${cachedMediaFile}" not found in /media\x1b[0m`)
}

httpServer.listen(PORT, () => {
  console.log(`\x1b[32m✓ Movie Night listening on http://localhost:${PORT}\x1b[0m`)
})
