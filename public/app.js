document.addEventListener('DOMContentLoaded', main)

let page = {}
function main() {
    renderPage()

    page.ws = new WebSocket("ws://" + location.hostname + ":8080")

    page.ws.onmessage = function (event) {
        let parsed_data = JSON.parse(event.data)
        switch (parsed_data.type) {
            case 'welcome':
                handleWelcomeMessage(parsed_data.message)
                break
            case 'heartbeat':
                handleHeartbeatMessage(parsed_data.message)
                break
            case 'authoritative':
                handleAuthoritativeMessage(parsed_data.message)
                break
            case 'incoming-chat-message':
                handleChatMessage(parsed_data.message)
                break
        }
    }

    let video_container = document.querySelector(".video-container")
    let video = document.querySelector('video')

    video_container.addEventListener("click", function (event) {
        event.stopPropagation()
        if (video.paused || video.ended) {
            video.play()
            let video_controls = document.querySelector('.video-controls')
            video_controls.classList.toggle("animated")
            video_controls.classList.toggle("zoomIn")
            document.querySelector('.play').style.display = 'initial'
            document.querySelector('.pause').style.display = 'none'
        }
        else {
            video.pause()
            let video_controls = document.querySelector('.video-controls')
            video_controls.classList.toggle("animated")
            video_controls.classList.toggle("zoomIn")
            document.querySelector('.pause').style.display = 'initial'
            document.querySelector('.play').style.display = 'none'
        }
    })

    document.querySelector("button.fullscreen").addEventListener("click", function (event) {
        if (video.requestFullscreen) video.requestFullscreen()
        else if (video.mozRequestFullScreen) video.mozRequestFullScreen()
        else if (video.webkitRequestFullScreen) video.webkitRequestFullScreen()
        else if (video.msRequestFullscreen) video.msRequestFullscreen()
        event.stopPropagation()
    })

    document.querySelector("button.close-button").addEventListener("click", function () {
        document.querySelector(".info-message-container").style.display = 'none'
    })

    page.chat_mode = "pick username"

    document.querySelector("button.chat-button").addEventListener("click", handleChatInput)
    document.querySelector("input[name=chat]").addEventListener("keyup", handleChatInput)
    document.querySelector("input[name=name]").addEventListener("keyup", handleChatInput)
}

function handleChatInput(event) {
    if (event.type === "keyup") {
        event.which = event.which || event.keyCode
        if (event.which != 13) //enter key 
            return
    }
    let chat_message_input = document.querySelector("input[name=chat]")
    let chat_name_input = document.querySelector("input[name=name]")
    if (page.chat_mode === "pick username") {
        page.chat_name = chat_name_input.value
        chat_name_input.value = ''
        page.chat_mode = "chat"
        chat_name_input.classList.add("animated")
        chat_name_input.classList.add("bounceIn")
        setTimeout(function () {
            chat_name_input.style.display = 'none'
            chat_message_input.style.display = 'initial'
            chat_message_input.focus()
        }, 100)
    }
    else if (page.chat_mode === "chat") {
        page.ws.send(JSON.stringify(
            {
                "type": "chat-message",
                message: {
                    "chat-message": chat_message_input.value,
                    "chat-message-owner": page.chat_name
                }
            }))
        chat_message_input.value = ''
        chat_message_input.focus()
    }
}

function renderPage() {
    let timestamp_element = document.createElement('pre')
    timestamp_element.className = "timestamp"

    document.querySelector('footer').appendChild(timestamp_element)
}

function handleWelcomeMessage(message) {
    page.server_launch_time = new Date(message['server-launch-time'])
    let uptime_element = document.createElement('pre')
    uptime_element.className = "uptime"
    uptime_element.textContent = 'Uptime: ' + new Date(new Date() - page.server_launch_time)

    document.querySelector('footer').appendChild(uptime_element)

    document.querySelector('.motd').textContent = message['message-of-the-day']

    document.querySelector("video").currentTime = message['video-seek-time']
}

function handleHeartbeatMessage(message) {
    page.server_time = new Date(message['server-time'])
    document.querySelector('.timestamp').textContent = 'Server time: ' + page.server_time.toTimeString()
    let date_diff = Math.floor((Date.now() - page.server_launch_time.getTime()) / 1000 / 60)
    document.querySelector('.uptime').textContent = 'Uptime: ' + date_diff + ' minutes'

    let video_element = document.querySelector("video")
    if (Math.abs(message['video-seek-time'] - video_element.currentTime) > 1) {
        video_element.currentTime = message['video-seek-time']

        displayInfoMessage("Video synchronised with channel time!")
    }
}

function handleAuthoritativeMessage(message) {
    let video_element = document.querySelector("video")
    video_element.currentTime = message['video-seek-time']
    video_element.pause()
    video_element.load()
    video_element.play()
    displayInfoMessage("Loaded new movie!")
}

function handleChatMessage(message) {
    let chatBox = document.querySelector('.chat-box')
    let chatMessageElement = document.createElement('p')
    chatMessageElement.classList.add('chat-message')

    let chatMessageOwnerElement = document.createElement('span')
    chatMessageOwnerElement.classList.add('chat-message-owner')
    chatMessageOwnerElement.textContent = message['chat-message-owner']

    chatMessageElement.appendChild(chatMessageOwnerElement)
    chatMessageElement.innerHTML += '&nbsp;' + message['chat-message']

    chatBox.appendChild(chatMessageElement)
    
    chatBox.scrollTop = chatBox.scrollHeight
}

function displayInfoMessage(message) {
    let info_message_container = document.querySelector(".info-message-container")

    info_message_container.querySelector(".info-message").textContent = message
    info_message_container.classList.remove("animated")
    info_message_container.classList.remove("bounceIn")
    setTimeout(function () {
        info_message_container.style.display = 'inline-block'
        info_message_container.classList.add("animated")
        info_message_container.classList.add("bounceIn")
    }, 100)
}