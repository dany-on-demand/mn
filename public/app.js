// ---------------------------------------------------------------------------
// Movie Night – modern client (ES module)
// ---------------------------------------------------------------------------

// Constants
const WS_RECONNECT_DELAY_MS = 3000
const VIDEO_SYNC_THRESHOLD_S = 2  // seconds before we force-sync the video

const state = {
  user: null,         // logged-in user object from /api/auth/me
  chatName: null,     // guest chat name (for unauthenticated users)
  chatMode: 'pick-name', // 'pick-name' | 'chat'
  serverLaunchTime: null,
  ws: null,
  adminView: false
}

// ---------------------------------------------------------------------------
// Utility helpers
// ---------------------------------------------------------------------------
function $(sel) { return document.querySelector(sel) }
function show(el) { el?.classList.remove('hidden') }
function hide(el) { el?.classList.add('hidden') }

async function apiFetch(path, options = {}) {
  const res = await fetch(path, {
    headers: {
      'Content-Type': 'application/json',
      'X-Requested-With': 'XMLHttpRequest'
    },
    ...options
  })
  const data = await res.json().catch(() => null)
  return { ok: res.ok, status: res.status, data }
}

// ---------------------------------------------------------------------------
// WebSocket
// ---------------------------------------------------------------------------
function connectWebSocket() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
  const ws = new WebSocket(`${proto}//${location.host}`)
  state.ws = ws

  ws.addEventListener('message', (event) => {
    let packet
    try { packet = JSON.parse(event.data) } catch { return }
    switch (packet.type) {
      case 'welcome':         handleWelcome(packet.message); break
      case 'heartbeat':       handleHeartbeat(packet.message); break
      case 'authoritative':   handleAuthoritative(packet.message); break
      case 'incoming-chat-message': handleChatMessage(packet.message); break
    }
  })

  ws.addEventListener('close', () => {
    setTimeout(connectWebSocket, WS_RECONNECT_DELAY_MS)
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
  if (video) video.currentTime = msg['video-seek-time'] || 0
}

function handleHeartbeat(msg) {
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

function handleChatMessage(msg) {
  const box = $('#chat-box')
  const p = document.createElement('p')
  p.className = 'chat-message'

  const owner = document.createElement('span')
  owner.className = 'chat-message-owner'
  owner.textContent = msg['chat-message-owner'] || 'Anonymous'

  p.appendChild(owner)
  // Use textContent on a separate node to avoid XSS
  const text = document.createTextNode('\u00a0' + msg['chat-message'])
  p.appendChild(text)

  box.appendChild(p)
  box.scrollTop = box.scrollHeight
}

// ---------------------------------------------------------------------------
// Video controls
// ---------------------------------------------------------------------------
function initVideo() {
  const container = $('.video-container')
  const video = $('video')
  if (!container || !video) return

  container.addEventListener('click', (e) => {
    e.stopPropagation()
    const controls = $('.play-pause-container')
    if (video.paused || video.ended) {
      video.play().catch(() => {})
      controls?.classList.add('animated', 'zoomIn')
      $('.play').style.display = 'initial'
      $('.pause').style.display = 'none'
    } else {
      video.pause()
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

  // Admin: broadcast seek time updates
  video.addEventListener('timeupdate', () => {
    if (state.user?.role === 'admin') {
      wsSend({ type: 'admin-seek-time-update', message: { 'video-seek-time': video.currentTime } })
    }
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

  updateChatState()
}

// ---------------------------------------------------------------------------
// Toast notification
// ---------------------------------------------------------------------------
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
}

$('#close-toast')?.addEventListener('click', () => hide($('#info-toast')))

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
    if (state.user.role === 'admin') show(btnAdmin)
    else hide(btnAdmin)
  } else {
    show(btnLogin)
    hide(navUser)
    hide(btnLogout)
    hide(btnAdmin)
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
  } else {
    hide($('#view-admin'))
    show($('#view-main'))
  }
})

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
  // Check current auth state
  const { data: user } = await apiFetch('/api/auth/me')
  state.user = user || null

  updateNavBar()
  initVideo()
  initChat()
  connectWebSocket()
}

main()