// ---------------------------------------------------------------------------
// Movie Night – modern client (ES module)
// ---------------------------------------------------------------------------

// Constants
const VIDEO_SYNC_THRESHOLD_S  = 2    // seconds of drift before force-syncing
const WS_RECONNECT_BASE_MS    = 1000 // initial reconnect delay
const WS_RECONNECT_MAX_MS     = 30000 // cap on reconnect delay
// STUN servers for WebRTC — override via window.MN_STUN_SERVERS if needed
const STUN_SERVERS = (typeof window !== 'undefined' && window.MN_STUN_SERVERS)
  ? window.MN_STUN_SERVERS
  : [{ urls: 'stun:stun.l.google.com:19302' }]

const state = {
  user: null,         // logged-in user object from /api/auth/me
  chatName: null,     // guest chat name (for unauthenticated users)
  chatMode: 'pick-name', // 'pick-name' | 'chat'
  serverLaunchTime: null,
  ws: null,
  adminView: false,
  csrfToken: null,    // synchronizer CSRF token
  wsReconnectDelay: WS_RECONNECT_BASE_MS,
  onlineUsers: [],    // logged-in usernames currently connected
}

// ---------------------------------------------------------------------------
// Utility helpers
// ---------------------------------------------------------------------------
function $(sel) { return document.querySelector(sel) }
function show(el) { el?.classList.remove('hidden') }
function hide(el) { el?.classList.add('hidden') }

function formatTime(secs) {
  const s = Math.floor(secs || 0)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`
    : `${m}:${String(sec).padStart(2, '0')}`
}

// Fixed-point integer comparison avoids redundant DOM writes and toFixed() string allocation.
// pct100 is 0–10000 (two decimal places of precision).
let _lastProgressPct100 = -1

function updateProgress() {
  const video = $('video')
  const fill  = $('#video-progress-fill')
  const label = $('#video-progress-time')
  if (!video || !fill) return
  const dur = video.duration
  if (dur > 0) {
    const pct100 = (video.currentTime / dur * 10000 | 0)
    if (pct100 !== _lastProgressPct100) {
      _lastProgressPct100 = pct100
      fill.style.width = (pct100 / 100) + '%'
    }
    if (label) label.textContent = `${formatTime(video.currentTime)} / ${formatTime(dur)}`
  } else {
    if (_lastProgressPct100 !== 0) { _lastProgressPct100 = 0; fill.style.width = '0%' }
    if (label) label.textContent = formatTime(video.currentTime)
  }
}

async function initCsrf() {
  const res = await fetch('/api/csrf-token')
  const data = await res.json().catch(() => null)
  state.csrfToken = data?.csrfToken || null
}

async function apiFetch(path, options = {}) {
  const headers = {
    'Content-Type': 'application/json',
    'X-Requested-With': 'XMLHttpRequest'
  }
  if (state.csrfToken) headers['X-CSRF-Token'] = state.csrfToken

  const res = await fetch(path, { headers, ...options })
  const data = await res.json().catch(() => null)
  return { ok: res.ok, status: res.status, data }
}

// ---------------------------------------------------------------------------
// WebSocket – with status indicator and exponential backoff
// ---------------------------------------------------------------------------
function setWsStatus(status) {
  const dot = $('#ws-status')
  if (!dot) return
  dot.className = `ws-dot ws-dot--${status}`
  dot.title = status === 'online' ? 'Connected' : status === 'offline' ? 'Disconnected' : 'Connecting…'
}

function connectWebSocket() {
  setWsStatus('connecting')
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
  const ws = new WebSocket(`${proto}//${location.host}/ws`)
  state.ws = ws

  ws.addEventListener('open', () => {
    state.wsReconnectDelay = WS_RECONNECT_BASE_MS  // reset on success
    setWsStatus('online')
  })

  ws.addEventListener('message', (event) => {
    let packet
    try { packet = JSON.parse(event.data) } catch { return }
    switch (packet.type) {
      case 'welcome':         handleWelcome(packet.message); break
      case 'heartbeat':       handleHeartbeat(packet.message); break
      case 'authoritative':   handleAuthoritative(packet.message); break
      case 'play-pause':      handlePlayPause(packet); break
      case 'incoming-chat-message': appendChatMessage(packet.message); break
      case 'chat-history':    handleChatHistory(packet); break
      case 'online-count':    handleOnlineCount(packet); break
      case 'typing':          handleTyping(packet.username); break
      case 'dm-offer':        handleDmOffer(packet).catch(console.error); break
      case 'dm-answer':       handleDmAnswer(packet).catch(console.error); break
      case 'dm-ice':          handleDmIce(packet).catch(console.error); break
    }
  })

  ws.addEventListener('close', () => {
    setWsStatus('offline')
    setTimeout(() => {
      // Exponential backoff: 1 s → 2 s → 4 s … capped at 30 s
      state.wsReconnectDelay = Math.min(state.wsReconnectDelay * 2, WS_RECONNECT_MAX_MS)
      connectWebSocket()
    }, state.wsReconnectDelay)
  })
}

function wsSend(packet) {
  if (state.ws?.readyState === WebSocket.OPEN) {
    state.ws.send(JSON.stringify(packet))
  }
}

// ---------------------------------------------------------------------------
// WS message handlers
// ---------------------------------------------------------------------------
function handleWelcome(msg) {
  state.serverLaunchTime = new Date(msg['server-launch-time'])
  $('#motd').textContent = msg['message-of-the-day'] || ''
  const video = $('video')
  if (video) {
    video.currentTime = msg['video-seek-time'] || 0
    if (msg.playing) video.play().catch(() => {})
  }
}

function handleHeartbeat(msg) {
  // Skip DOM updates and video sync when the tab is hidden (Page Visibility API)
  if (document.hidden) return

  const serverTime = new Date(msg['server-time'])
  $('#server-time').textContent = `Server time: ${serverTime.toTimeString()}`

  if (state.serverLaunchTime) {
    const mins = Math.floor((Date.now() - state.serverLaunchTime.getTime()) / 60000)
    $('#uptime').textContent = `Uptime: ${mins} minutes`
  }

  const video = $('video')
  if (video && Math.abs((msg['video-seek-time'] || 0) - video.currentTime) > VIDEO_SYNC_THRESHOLD_S) {
    video.currentTime = msg['video-seek-time']
    displayToast('Video synchronised with channel time!')
  }
}

function handleAuthoritative(msg) {
  const video = $('video')
  if (!video) return
  video.pause()
  video.load()
  video.currentTime = msg['video-seek-time'] || 0
  video.play().catch(() => {})
  displayToast('Loaded new movie!')
}

function handlePlayPause(msg) {
  if (state.user?.role === 'admin') return  // admin drives their own player
  const video = $('video')
  if (!video) return
  video.currentTime = msg['video-seek-time'] || 0
  if (msg.playing) video.play().catch(() => {})
  else video.pause()
}

function handleChatMessage(msg) {
  appendChatMessage(msg)
}

// ---------------------------------------------------------------------------
// Shared chat message renderer — used for both live messages and history replay
// ---------------------------------------------------------------------------

// Build a <p> DOM node for a single chat message. Pure function — no side effects.
function buildChatMessageNode(msg) {
  const p = document.createElement('p')
  p.className = 'chat-message'

  const owner = document.createElement('span')
  owner.className = 'chat-message-owner'
  owner.textContent = msg['chat-message-owner'] || 'Anonymous'

  // Logged-in users in the online list get a clickable DM link
  if (state.user && state.onlineUsers.includes(msg['chat-message-owner']) &&
      msg['chat-message-owner'] !== state.user.username) {
    owner.classList.add('chat-message-owner--dm')
    owner.title = `Click to DM ${msg['chat-message-owner']}`
    owner.addEventListener('click', () => startDm(msg['chat-message-owner']))
  }

  p.appendChild(owner)
  p.appendChild(document.createTextNode('\u00a0' + msg['chat-message']))

  // Timestamp (visible on hover)
  if (msg['server-time']) {
    const d  = new Date(msg['server-time'])
    const ts = document.createElement('time')
    ts.className = 'chat-message-time'
    ts.dateTime  = msg['server-time']
    ts.textContent = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
    p.appendChild(ts)
  }

  return p
}

// Append a single live message. Smart-scrolls only when already near the bottom
// so users reading chat history aren't disturbed by new arrivals.
function appendChatMessage(msg) {
  const box = $('#chat-box')
  const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 80
  box.appendChild(buildChatMessageNode(msg))
  if (atBottom) box.scrollTop = box.scrollHeight
}

// ---------------------------------------------------------------------------
// WS message handlers
// ---------------------------------------------------------------------------
function handleChatHistory(packet) {
  const msgs = packet.messages || []
  if (!msgs.length) return
  const box  = $('#chat-box')
  // DocumentFragment batches all DOM inserts into a single reflow
  const frag = document.createDocumentFragment()
  for (const msg of msgs) frag.appendChild(buildChatMessageNode(msg))
  const motd = box.querySelector('.motd')
  if (motd?.nextSibling) box.insertBefore(frag, motd.nextSibling)
  else box.insertBefore(frag, box.firstChild)
  box.scrollTop = box.scrollHeight
}

function handleOnlineCount(packet) {
  state.onlineUsers = packet.users || []
  const el = $('#online-count')
  if (!el) return
  el.textContent = `${packet.total} online`
  el.title = state.onlineUsers.length
    ? `Logged in: ${state.onlineUsers.join(', ')}`
    : `${packet.total} viewer${packet.total !== 1 ? 's' : ''}`
}

// Typing indicator — debounced display per username
const _typingTimers = new Map()  // username → clearTimeout handle
function handleTyping(username) {
  if (!username || username === state.user?.username) return
  const prev = _typingTimers.get(username)
  if (prev) clearTimeout(prev)
  _typingTimers.set(username, setTimeout(() => {
    _typingTimers.delete(username)
    renderTypingIndicator()
  }, 3000))
  renderTypingIndicator()
}
function renderTypingIndicator() {
  const el = $('#typing-indicator')
  if (!el) return
  const names = [..._typingTimers.keys()]
  el.textContent = names.length === 0 ? ''
    : names.length === 1 ? `${names[0]} is typing…`
    : `${names.slice(0, 2).join(', ')} are typing…`
}

// ---------------------------------------------------------------------------
// P2P Direct Messages via WebRTC data channels.
// The server only relays SDP offer/answer and ICE candidates — the actual
// message payloads travel peer-to-peer and never touch the server.
// ---------------------------------------------------------------------------
const _dmPeers    = new Map()   // username → {pc, dc, msgs:[]}
let   _activeDm   = null        // currently open DM peer username

function openDmPanel(username) {
  _activeDm = username
  const panel = $('#dm-panel')
  const title = $('#dm-peer-name')
  if (title) title.textContent = username
  renderDmMessages(username)
  show(panel)
  $('#dm-input')?.focus()
}

function closeDmPanel() {
  _activeDm = null
  hide($('#dm-panel'))
}

function renderDmMessages(username) {
  const peer = _dmPeers.get(username)
  const box  = $('#dm-messages')
  if (!box || !peer) return
  box.innerHTML = ''
  for (const m of peer.msgs) {
    const p = document.createElement('p')
    p.className = 'dm-message' + (m.from === state.user?.username ? ' dm-message--mine' : '')
    const owner = document.createElement('span')
    owner.className = 'chat-message-owner'
    owner.textContent = m.from
    p.appendChild(owner)
    p.appendChild(document.createTextNode('\u00a0' + m.text))
    box.appendChild(p)
  }
  box.scrollTop = box.scrollHeight
}

function receiveDmMessage(fromUser, text) {
  const peer = _dmPeers.get(fromUser)
  if (!peer) return
  peer.msgs.push({ from: fromUser, text })
  if (_activeDm === fromUser) renderDmMessages(fromUser)
  else displayToast(`💬 ${fromUser}: ${text.length > 40 ? text.slice(0, 40) + '…' : text}`)
}

function sendDmMessage() {
  if (!_activeDm) return
  const input = $('#dm-input')
  const text  = input?.value.trim()
  if (!text) return
  const peer = _dmPeers.get(_activeDm)
  if (!peer?.dc || peer.dc.readyState !== 'open') { displayToast('DM not connected yet'); return }
  peer.dc.send(text)
  peer.msgs.push({ from: state.user.username, text })
  if (input) input.value = ''
  renderDmMessages(_activeDm)
}

async function startDm(toUser) {
  if (!state.user) { displayToast('Log in to use DMs'); return }
  if (toUser === state.user.username) return
  if (_dmPeers.has(toUser)) { openDmPanel(toUser); return }

  const pc = new RTCPeerConnection({ iceServers: STUN_SERVERS })
  const dc = pc.createDataChannel('dm', { ordered: true })
  dc.onopen    = () => { openDmPanel(toUser); displayToast(`Connected to ${toUser}`) }
  dc.onmessage = (e) => receiveDmMessage(toUser, e.data)
  pc.onicecandidate = (e) => {
    if (e.candidate) wsSend({ type: 'dm-ice', to: toUser, candidate: e.candidate.toJSON() })
  }

  const offer = await pc.createOffer()
  await pc.setLocalDescription(offer)
  wsSend({ type: 'dm-offer', to: toUser, sdp: offer.sdp })
  _dmPeers.set(toUser, { pc, dc, msgs: [] })
}

async function handleDmOffer(packet) {
  const from = packet.from
  if (_dmPeers.has(from)) return

  const pc = new RTCPeerConnection({ iceServers: STUN_SERVERS })
  pc.ondatachannel = (e) => {
    const dc = e.channel
    dc.onopen    = () => { openDmPanel(from); displayToast(`Connected to ${from}`) }
    dc.onmessage = (ev) => receiveDmMessage(from, ev.data)
    const peer = _dmPeers.get(from)
    if (peer) peer.dc = dc
  }
  pc.onicecandidate = (e) => {
    if (e.candidate) wsSend({ type: 'dm-ice', to: from, candidate: e.candidate.toJSON() })
  }

  _dmPeers.set(from, { pc, dc: null, msgs: [] })
  await pc.setRemoteDescription({ type: 'offer', sdp: packet.sdp })
  const answer = await pc.createAnswer()
  await pc.setLocalDescription(answer)
  wsSend({ type: 'dm-answer', to: from, sdp: answer.sdp })
  displayToast(`💬 DM request from ${from}`)
}

async function handleDmAnswer(packet) {
  const peer = _dmPeers.get(packet.from)
  if (!peer) return
  await peer.pc.setRemoteDescription({ type: 'answer', sdp: packet.sdp })
}

async function handleDmIce(packet) {
  const peer = _dmPeers.get(packet.from)
  if (!peer || !packet.candidate) return
  try { await peer.pc.addIceCandidate(packet.candidate) } catch { /* stale candidate */ }
}

// ---------------------------------------------------------------------------
// Video controls
// ---------------------------------------------------------------------------
function updateVolumeUI() {
  const slider = $('#volume-slider')
  const icon   = $('#volume-icon')
  const video  = $('video')
  if (!video || !slider || !icon) return
  slider.value     = video.muted ? 0 : video.volume
  icon.textContent = (video.muted || video.volume === 0) ? '🔇' : video.volume < 0.5 ? '🔉' : '🔊'
  icon.title       = video.muted ? 'Unmute (M)' : 'Mute (M)'
}

function initVolumeControl() {
  const slider = $('#volume-slider')
  const icon   = $('#volume-icon')
  const video  = $('video')
  if (!slider || !video) return
  slider.value = video.volume
  slider.addEventListener('input', () => {
    video.volume = parseFloat(slider.value)
    video.muted  = video.volume === 0
    updateVolumeUI()
  })
  icon?.addEventListener('click', () => {
    video.muted = !video.muted
    updateVolumeUI()
  })
  video.addEventListener('volumechange', updateVolumeUI)
}

function initVideo() {
  const container = $('.video-container')
  const video = $('video')
  if (!container || !video) return

  container.addEventListener('click', (e) => {
    e.stopPropagation()
    const controls = $('.play-pause-container')
    if (video.paused || video.ended) {
      video.play().catch(() => {})
      if (state.user?.role === 'admin')
        wsSend({ type: 'admin-play-pause', playing: true,  'video-seek-time': video.currentTime })
      controls?.classList.add('animated', 'zoomIn')
      $('.play').style.display = 'initial'
      $('.pause').style.display = 'none'
    } else {
      video.pause()
      if (state.user?.role === 'admin')
        wsSend({ type: 'admin-play-pause', playing: false, 'video-seek-time': video.currentTime })
      controls?.classList.add('animated', 'zoomIn')
      $('.pause').style.display = 'initial'
      $('.play').style.display = 'none'
    }
  })

  $('button.fullscreen')?.addEventListener('click', (e) => {
    e.stopPropagation()
    if (video.requestFullscreen) video.requestFullscreen()
    else if (video.webkitRequestFullScreen) video.webkitRequestFullScreen()
  })

  // Progress bar: update every timeupdate (fires ~4×/s during playback)
  video.addEventListener('timeupdate', updateProgress)
  video.addEventListener('loadedmetadata', updateProgress)

  // Admin: click on progress bar to seek
  $('#video-progress')?.addEventListener('click', (e) => {
    if (state.user?.role !== 'admin') return
    e.stopPropagation()
    const bar = e.currentTarget
    const ratio = e.offsetX / bar.offsetWidth
    if (!video.duration) return
    video.currentTime = ratio * video.duration
    // The timeupdate event will broadcast the new seek time via the existing throttled handler
  })

  // Admin: broadcast seek time updates, throttled to ≤1/s
  let lastTimeupdateSent = 0
  video.addEventListener('timeupdate', () => {
    if (state.user?.role !== 'admin') return
    const now = performance.now()
    if (now - lastTimeupdateSent < 1000) return
    lastTimeupdateSent = now
    wsSend({ type: 'admin-seek-time-update', message: { 'video-seek-time': video.currentTime } })
  })
}

// ---------------------------------------------------------------------------
// Chat
// ---------------------------------------------------------------------------
function updateChatState() {
  const nameInput = $('#chat-name-input')
  const msgInput  = $('#chat-msg-input')

  // If the user is logged-in, skip the name-picking step
  if (state.user) {
    state.chatName = state.user.username
    state.chatMode = 'chat'
    hide(nameInput)
    show(msgInput)
    msgInput?.focus()
  } else if (state.chatMode === 'pick-name') {
    show(nameInput)
    hide(msgInput)
  }
}

// Set up chat event listeners once on page load
function initChat() {
  const nameInput = $('#chat-name-input')
  const msgInput  = $('#chat-msg-input')
  const sendBtn   = $('#chat-send-btn')

  function handleChatInput(event) {
    if (event.type === 'keyup' && event.key !== 'Enter') return

    if (state.chatMode === 'pick-name') {
      const name = nameInput.value.trim()
      if (!name) return
      state.chatName = name
      nameInput.value = ''
      state.chatMode = 'chat'
      nameInput.classList.add('animated', 'bounceIn')
      setTimeout(() => {
        hide(nameInput)
        show(msgInput)
        msgInput?.focus()
      }, 100)
    } else if (state.chatMode === 'chat') {
      const text = msgInput.value.trim()
      if (!text) return
      wsSend({
        type: 'chat-message',
        message: { 'chat-message': text, 'chat-message-owner': state.chatName }
      })
      msgInput.value = ''
      msgInput.focus()
    }
  }

  sendBtn?.addEventListener('click', handleChatInput)
  nameInput?.addEventListener('keyup', handleChatInput)
  msgInput?.addEventListener('keyup', handleChatInput)

  // Emit typing indicator while the user is composing (throttled to once per 2 s)
  let _lastTypingSent = 0
  msgInput?.addEventListener('input', () => {
    if (!state.user) return
    const now = performance.now()
    if (now - _lastTypingSent < 2000) return
    _lastTypingSent = now
    wsSend({ type: 'typing' })
  })

  updateChatState()
}

// ---------------------------------------------------------------------------
// Toast notification – auto-dismisses after 4 s
// ---------------------------------------------------------------------------
let toastTimer = null
function displayToast(message) {
  const toast = $('#info-toast')
  const text  = $('#info-message-text')
  if (!toast || !text) return
  text.textContent = message
  toast.classList.remove('animated', 'bounceIn')
  setTimeout(() => {
    show(toast)
    toast.classList.add('animated', 'bounceIn')
  }, 50)
  if (toastTimer) clearTimeout(toastTimer)
  toastTimer = setTimeout(() => hide(toast), 4000)
}

$('#close-toast')?.addEventListener('click', () => {
  if (toastTimer) clearTimeout(toastTimer)
  hide($('#info-toast'))
})

// DM panel controls
$('#dm-close-btn')?.addEventListener('click', closeDmPanel)
$('#dm-send-btn')?.addEventListener('click', sendDmMessage)
$('#dm-input')?.addEventListener('keyup', (e) => { if (e.key === 'Enter') sendDmMessage() })

// ---------------------------------------------------------------------------
// Keyboard shortcuts
// ---------------------------------------------------------------------------
document.addEventListener('keydown', (e) => {
  // Don't fire while typing in an input/textarea
  if (['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName)) return
  const video = $('video')

  switch (e.key) {
    case ' ': {
      if (!video) break
      e.preventDefault()
      const willPlay = video.paused || video.ended
      if (willPlay) video.play().catch(() => {})
      else video.pause()
      if (state.user?.role === 'admin')
        wsSend({ type: 'admin-play-pause', playing: willPlay, 'video-seek-time': video.currentTime })
      break
    }
    case 'f': case 'F':
      if (!video) break
      e.preventDefault()
      if (video.requestFullscreen) video.requestFullscreen()
      else if (video.webkitRequestFullScreen) video.webkitRequestFullScreen()
      break
    case 'm': case 'M':
      if (!video) break
      e.preventDefault()
      video.muted = !video.muted
      updateVolumeUI()
      break
    case 'ArrowLeft':
      if (!video || state.user?.role !== 'admin') break
      e.preventDefault()
      video.currentTime = Math.max(0, video.currentTime - 5)
      break
    case 'ArrowRight':
      if (!video || state.user?.role !== 'admin') break
      e.preventDefault()
      video.currentTime = Math.min(video.duration || 0, video.currentTime + 5)
      break
    case 'Escape':
      hide($('#login-modal'))
      closeDmPanel()
      break
  }
})

// ---------------------------------------------------------------------------
// Auth UI
// ---------------------------------------------------------------------------
function updateNavBar() {
  const btnLogin  = $('#btn-login')
  const btnLogout = $('#btn-logout')
  const btnAdmin  = $('#btn-admin')
  const navUser   = $('#nav-user')

  if (state.user) {
    hide(btnLogin)
    show(navUser)
    navUser.textContent = state.user.username
    show(btnLogout)
    if (state.user.role === 'admin') {
      show(btnAdmin)
      $('#video-progress')?.classList.add('admin-seekable')
      show($('#kbd-hints'))
    } else {
      hide(btnAdmin)
      $('#video-progress')?.classList.remove('admin-seekable')
      hide($('#kbd-hints'))
    }
  } else {
    show(btnLogin)
    hide(navUser)
    hide(btnLogout)
    hide(btnAdmin)
    hide($('#kbd-hints'))
    $('#video-progress')?.classList.remove('admin-seekable')
  }
}

// Login modal
$('#btn-login')?.addEventListener('click', () => show($('#login-modal')))
$('#login-modal')?.addEventListener('click', (e) => {
  if (e.target === $('#login-modal')) hide($('#login-modal'))
})

$('#login-form')?.addEventListener('submit', async (e) => {
  e.preventDefault()
  const username = $('#login-username').value.trim()
  const password = $('#login-password').value
  const errEl = $('#login-error')

  hide(errEl)
  const { ok, data } = await apiFetch('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ username, password })
  })

  if (ok) {
    state.user = data
    hide($('#login-modal'))
    $('#login-form').reset()
    updateNavBar()
    updateChatState()
    displayToast(`Welcome back, ${data.username}!`)
  } else {
    errEl.textContent = data?.error || 'Login failed'
    show(errEl)
  }
})

$('#btn-logout')?.addEventListener('click', async () => {
  await apiFetch('/api/auth/logout', { method: 'POST' })
  state.user = null
  state.chatMode = 'pick-name'
  state.chatName = null
  state.adminView = false
  updateNavBar()
  hide($('#view-admin'))
  show($('#view-main'))
  updateChatState()
  displayToast('Logged out.')
})

// ---------------------------------------------------------------------------
// Admin panel
// ---------------------------------------------------------------------------
$('#btn-admin')?.addEventListener('click', () => {
  state.adminView = !state.adminView
  if (state.adminView) {
    show($('#view-admin'))
    hide($('#view-main'))
    loadSettings()
    loadUsers()
    loadMediaFiles()
  } else {
    hide($('#view-admin'))
    show($('#view-main'))
  }
})

async function loadMediaFiles() {
  const { ok, data } = await apiFetch('/api/media')
  if (!ok) return
  const list = $('#media-files-list')
  if (!list) return
  list.innerHTML = ''
  for (const file of data) {
    const opt = document.createElement('option')
    opt.value = file
    list.appendChild(opt)
  }
}

async function loadSettings() {
  const { ok, data } = await apiFetch('/api/settings')
  if (!ok) return
  $('#settings-media-file').value = data['media_file'] || ''
  $('#settings-motd').value = data['message-of-the-day'] || ''
}

$('#settings-form')?.addEventListener('submit', async (e) => {
  e.preventDefault()
  const msgEl = $('#settings-msg')
  hide(msgEl)
  const payload = {
    media_file: $('#settings-media-file').value.trim(),
    'message-of-the-day': $('#settings-motd').value.trim()
  }
  const { ok, data } = await apiFetch('/api/settings', { method: 'POST', body: JSON.stringify(payload) })
  msgEl.textContent = ok ? 'Saved!' : (data?.error || 'Error saving settings')
  msgEl.className = ok ? 'form-feedback success' : 'form-feedback error'
  show(msgEl)
})

async function loadUsers() {
  const { ok, data } = await apiFetch('/api/users')
  if (!ok) return
  const tbody = $('#users-tbody')
  tbody.innerHTML = ''
  for (const u of data) {
    const tr = document.createElement('tr')
    const created = new Date(u.created_at).toLocaleDateString()
    tr.innerHTML = `<td>${escapeHtml(u.username)}</td><td>${escapeHtml(u.role)}</td><td>${created}</td>`
    const td = document.createElement('td')
    if (u.id !== state.user?.id) {
      const btn = document.createElement('button')
      btn.textContent = 'delete'
      btn.className = 'btn-delete'
      btn.addEventListener('click', async () => {
        if (!confirm(`Delete user "${u.username}"?`)) return
        const { ok } = await apiFetch(`/api/users/${u.id}`, { method: 'DELETE' })
        if (ok) loadUsers()
      })
      td.appendChild(btn)
    }
    tr.appendChild(td)
    tbody.appendChild(tr)
  }
}

$('#add-user-form')?.addEventListener('submit', async (e) => {
  e.preventDefault()
  const form = e.target
  const msgEl = $('#add-user-msg')
  hide(msgEl)
  const payload = {
    username: form.elements['username'].value.trim(),
    password: form.elements['password'].value,
    role: form.elements['role'].value
  }
  const { ok, data } = await apiFetch('/api/users', { method: 'POST', body: JSON.stringify(payload) })
  if (ok) {
    form.reset()
    loadUsers()
    msgEl.textContent = 'User created.'
    msgEl.className = 'form-feedback success'
  } else {
    msgEl.textContent = data?.error || 'Error creating user'
    msgEl.className = 'form-feedback error'
  }
  show(msgEl)
})

$('#change-password-form')?.addEventListener('submit', async (e) => {
  e.preventDefault()
  const form = e.target
  const msgEl = $('#change-password-msg')
  hide(msgEl)
  const payload = {
    currentPassword: form.elements['currentPassword'].value,
    newPassword: form.elements['newPassword'].value
  }
  const { ok, data } = await apiFetch('/api/auth/change-password', { method: 'POST', body: JSON.stringify(payload) })
  msgEl.textContent = ok ? 'Password updated!' : (data?.error || 'Error updating password')
  msgEl.className = ok ? 'form-feedback success' : 'form-feedback error'
  show(msgEl)
  if (ok) form.reset()
})

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------
function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------
async function main() {
  // Fetch CSRF token first (before any state-changing requests)
  await initCsrf()

  // Check current auth state
  const { data: user } = await apiFetch('/api/auth/me')
  state.user = user || null

  updateNavBar()
  initVideo()
  initVolumeControl()
  initChat()
  connectWebSocket()
}

main()