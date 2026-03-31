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
const MAX_WS_CONNECTIONS           = parseInt(process.env.MAX_WS_CONNECTIONS || '200', 10)  // configurable via env
const MAX_WS_PER_IP                = 5

// ---------------------------------------------------------------------------
// Token-bucket rate limit policy IDs and configs
// Using integer enum avoids string key assembly on every call.
// Config: [capacity, refillWindowMs]
// ---------------------------------------------------------------------------
const RL = Object.freeze({ AUTH: 0, READ: 1, WRITE: 2, STREAM: 3, STATIC: 4 })
const RL_CONFIGS = [
  [20,  15 * 60 * 1000],  // AUTH
  [120, 60_000],           // READ
  [60,  60_000],           // WRITE
  [30,  60_000],           // STREAM
  [300, 60_000],           // STATIC
]

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

// Fast targeted scan for the session cookie — no object allocation, no full split.
// Scans cookie header bytes until it finds "mn.sid=", then returns the value.
function parseSidCookie(header) {
  if (!header) return null
  const pfx = SESSION_COOKIE + '='
  let i = 0
  while (i < header.length) {
    while (header.charCodeAt(i) === 32) i++   // skip spaces after ';'
    if (header.startsWith(pfx, i)) {
      const start = i + pfx.length
      const end   = header.indexOf(';', start)
      const raw   = end < 0 ? header.slice(start) : header.slice(start, end)
      try { return decodeURIComponent(raw.trim()) } catch { return raw.trim() }
    }
    const next = header.indexOf(';', i)
    if (next < 0) break
    i = next + 1
  }
  return null
}

async function loadSession(request) {
  const sid = parseSidCookie(request.headers.cookie)
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
// Token-bucket rate limiting — one dedicated Map per policy.
// No string key assembly per call → fewer allocations, better cache locality.
// Each entry: [tokensLeft, lastCheckMs]
// ---------------------------------------------------------------------------
const _rlMaps = /** @type {Map<string,number[]>[]} */ (Array.from({ length: 5 }, () => new Map()))
setInterval(() => {
  const now = Date.now()
  for (let p = 0; p < 5; p++) {
    const [, wMs] = RL_CONFIGS[p]
    for (const [ip, e] of _rlMaps[p]) if (now - e[1] > wMs * 2) _rlMaps[p].delete(ip)
  }
}, 60_000).unref()

/** Returns true when the IP has exhausted its budget for the given policy. */
function rateLimited(ip, policy) {
  const [cap, wMs] = RL_CONFIGS[policy]
  const map = _rlMaps[policy]
  const now = Date.now()
  let e = map.get(ip)
  if (!e) { map.set(ip, [cap - 1, now]); return false }
  // Refill proportionally to elapsed time (continuous token bucket)
  const refilled = Math.min(cap, e[0] + (now - e[1]) / wMs * cap)
  e[1] = now
  if (refilled >= 1) { e[0] = refilled - 1; return false }
  e[0] = 0
  return true
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
const channel = { launchTime: new Date().toISOString(), currentTime: 0, playing: false }

let heartbeatFrame = ''
function buildHeartbeatFrame() {
  heartbeatFrame = `{"type":"heartbeat","message":{"server-time":"${new Date().toISOString()}","video-seek-time":${channel.currentTime}}}`
}

let welcomePrefix = ''
function rebuildWelcomePrefix() {
  const motd = JSON.stringify(getSettings()['message-of-the-day'] || '')
  welcomePrefix = `{"type":"welcome","message":{"server-launch-time":"${channel.launchTime}","message-of-the-day":${motd},"video-seek-time":`
}
function buildWelcomeFrame() { return `${welcomePrefix}${channel.currentTime},"playing":${channel.playing}}}` }

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
// Chat history ring buffer — data-oriented flat array of message objects.
// O(1) push, sequential read, no linked-list / GC pressure.
// _chatHistoryFrame is kept pre-serialized: new connections pay zero JSON cost.
// ---------------------------------------------------------------------------
const CHAT_RING_CAP = 50
const _chatRing = /** @type {object[]} */ (new Array(CHAT_RING_CAP).fill(null))
let   _chatHead = 0   // next write slot (wraps at CHAT_RING_CAP)
let   _chatLen  = 0   // valid entries (saturates at CHAT_RING_CAP)
let   _chatHistoryFrame = '{"type":"chat-history","messages":[]}'

function chatRingPush(msgObject) {
  _chatRing[_chatHead] = msgObject
  _chatHead = (_chatHead + 1) % CHAT_RING_CAP
  if (_chatLen < CHAT_RING_CAP) _chatLen++
  // Rebuild once per push — amortised cost; new connections pay zero serialization
  _chatHistoryFrame = JSON.stringify({ type: 'chat-history', messages: chatRingSnapshot() })
}

/** Returns message objects oldest→newest. Allocates only the output array. */
function chatRingSnapshot() {
  if (_chatLen === 0) return []
  const out   = new Array(_chatLen)
  const start = _chatLen < CHAT_RING_CAP ? 0 : _chatHead
  for (let i = 0; i < _chatLen; i++) out[i] = _chatRing[(start + i) % CHAT_RING_CAP]
  return out
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
  reply.header('Content-Security-Policy',
    "default-src 'self'; " +
    "style-src 'self' https://fonts.googleapis.com; " +
    "font-src https://fonts.gstatic.com; " +
    "media-src 'self'; " +
    "connect-src 'self' ws: wss:; " +
    "img-src 'self' data:; " +
    "frame-ancestors 'none'")
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
    if (rateLimited(request.ip, RL.STATIC)) {
      reply.code(429).send('Too many requests')
    }
  }
})

// ---------------------------------------------------------------------------
// Video stream — `send` handles byte-range natively
// ---------------------------------------------------------------------------
app.get('/stream', async (request, reply) => {
  if (rateLimited(request.ip, RL.STREAM)) return reply.code(429).send('Too many requests')
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
const wsClientsByIp  = new Map()
const connectedUsers = new Map()  // username → socket (logged-in users only)

// Pending-flag deduplication: rapid connect/disconnect storms collapse to one
// broadcast per event-loop tick. Zero extra allocations on the hot path.
let _onlineCountPending = false
function broadcastOnlineCount() {
  if (_onlineCountPending) return
  _onlineCountPending = true
  setImmediate(() => {
    _onlineCountPending = false
    if (!wss) return
    broadcastRaw(JSON.stringify({
      type:  'online-count',
      total: wss.clients.size,
      users: [...connectedUsers.keys()],
    }))
  })
}

app.get('/ws', { websocket: true }, (socket, request) => {
  // Global connection cap — hard limit to resist exhaustion attacks
  if (wss.clients.size > MAX_WS_CONNECTIONS) {
    socket.close(1008, 'Server at capacity')
    return
  }
  const ip = request.ip
  if ((wsClientsByIp.get(ip) ?? 0) >= MAX_WS_PER_IP) {
    socket.close(1008, 'Too many connections from this IP')
    return
  }

  // Validate Origin header to block cross-site WebSocket hijacking
  const wsOrigin = request.headers.origin
  if (wsOrigin) {
    const host = request.headers.host || ''
    if (wsOrigin !== 'http://' + host && wsOrigin !== 'https://' + host) {
      socket.close(1008, 'Invalid origin')
      return
    }
  }

  wsClientsByIp.set(ip, (wsClientsByIp.get(ip) ?? 0) + 1)

  const sessionUser = request.session?.user || null
  socket.user = sessionUser
  if (sessionUser) connectedUsers.set(sessionUser.username, socket)

  // Send welcome frame + pre-serialized chat history in a single burst
  socket.send(buildWelcomeFrame())
  if (_chatLen > 0) socket.send(_chatHistoryFrame)

  // Let everyone (including this new socket) know the updated head count
  broadcastOnlineCount()

  // Per-socket flood guard: ≤10 messages/s, timestamp-based — no setInterval needed
  let _wsMsg = 0, _wsMsgStart = Date.now()

  socket.on('close', () => {
    const n = wsClientsByIp.get(ip) ?? 1
    if (n <= 1) wsClientsByIp.delete(ip)
    else wsClientsByIp.set(ip, n - 1)
    if (sessionUser) connectedUsers.delete(sessionUser.username)
    broadcastOnlineCount()
  })

  socket.on('message', (raw) => {
    const _now = Date.now()
    if (_now - _wsMsgStart >= 1000) { _wsMsg = 0; _wsMsgStart = _now }
    if (++_wsMsg > 10) return
    let packet
    try { packet = JSON.parse(raw) } catch { return }

    switch (packet.type) {
      case 'admin-seek-time-update':
        if (socket.user?.role !== 'admin') return
        channel.currentTime = Number(packet.message?.['video-seek-time']) || 0
        break

      case 'admin-play-pause': {
        if (socket.user?.role !== 'admin') return
        channel.playing = !!packet.playing
        const seekTime = typeof packet['video-seek-time'] === 'number'
          ? packet['video-seek-time'] : channel.currentTime
        channel.currentTime = seekTime
        broadcast({ type: 'play-pause', playing: channel.playing, 'video-seek-time': seekTime })
        break
      }

      case 'chat-message': {
        const msg       = packet.message || {}
        const chatText  = String(msg['chat-message']        || '').trim().slice(0, MAX_CHAT_MESSAGE_LENGTH)
        const chatOwner = String(msg['chat-message-owner'] || 'Anonymous').trim().slice(0, MAX_CHAT_USERNAME_LENGTH)
        if (!chatText) return
        const msgObj = { 'server-time': new Date().toISOString(), 'chat-message': chatText, 'chat-message-owner': chatOwner }
        chatRingPush(msgObj)
        broadcast({ type: 'incoming-chat-message', message: msgObj })
        break
      }

      // WebRTC signaling — relay between authenticated users for P2P private DMs.
      // The server only sees encrypted SDP/ICE; actual DM payloads go peer-to-peer.
      case 'dm-offer':
      case 'dm-answer':
      case 'dm-ice': {
        if (!socket.user) return
        const to = String(packet.to || '').slice(0, MAX_CHAT_USERNAME_LENGTH)
        const target = connectedUsers.get(to)
        if (!target || target.readyState !== 1) return
        target.send(JSON.stringify({
          type: packet.type,
          from: socket.user.username,
          ...(packet.sdp       !== undefined && { sdp:       packet.sdp }),
          ...(packet.candidate !== undefined && { candidate: packet.candidate }),
        }))
        break
      }

      // Typing indicator — relay to everyone except sender
      case 'typing': {
        if (!socket.user) return
        const frame = JSON.stringify({ type: 'typing', username: socket.user.username })
        for (const c of wss.clients) if (c !== socket && c.readyState === 1) c.send(frame)
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
  if (rateLimited(request.ip, RL.AUTH)) return reply.code(429).send({ error: 'Too many requests, please try again later' })
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
  if (rateLimited(request.ip, RL.AUTH)) return reply.code(429).send({ error: 'Too many requests, please try again later' })
  if (!requireAuth(request, reply)) return
  if (!csrfCheck(request, reply)) return
  destroySession(request, reply)
  return { ok: true }
})

app.post('/api/auth/change-password', async (request, reply) => {
  if (!requireAuth(request, reply))    return
  if (!csrfCheck(request, reply))      return
  if (rateLimited(request.ip, RL.AUTH)) return reply.code(429).send({ error: 'Too many requests, please try again later' })
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
  if (rateLimited(request.ip, RL.READ)) return reply.code(429).send({ error: 'Too many requests, please try again later' })
  return getSettings()
})

app.post('/api/settings', async (request, reply) => {
  if (!requireAdmin(request, reply))     return
  if (!csrfCheck(request, reply))        return
  if (rateLimited(request.ip, RL.WRITE)) return reply.code(429).send({ error: 'Too many requests, please try again later' })
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
  if (rateLimited(request.ip, RL.READ)) return reply.code(429).send({ error: 'Too many requests, please try again later' })
  return stmts.listUsers.all()
})

app.post('/api/users', async (request, reply) => {
  if (!requireAdmin(request, reply))     return
  if (!csrfCheck(request, reply))        return
  if (rateLimited(request.ip, RL.WRITE)) return reply.code(429).send({ error: 'Too many requests, please try again later' })
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
  if (rateLimited(request.ip, RL.WRITE)) return reply.code(429).send({ error: 'Too many requests, please try again later' })
  const id = parseInt(request.params.id, 10)
  if (!id)                          return reply.code(400).send({ error: 'Invalid user id' })
  if (id === request.session.user.id) return reply.code(400).send({ error: 'Cannot delete your own account' })
  const result = stmts.deleteUser.run(id)
  if (result.changes === 0)          return reply.code(404).send({ error: 'User not found' })
  return { ok: true }
})

app.get('/api/media', async (request, reply) => {
  if (!requireAdmin(request, reply))    return
  if (rateLimited(request.ip, RL.READ)) return reply.code(429).send({ error: 'Too many requests, please try again later' })
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
