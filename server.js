'use strict'
const fs = require('fs')
const path = require('path')
const uuid = require('uuid')
const send = require('send') // express middleware
const express = require('express')
const session = require('express-session') // express middleware
// const sessionFileStore = require('session-file-store')(session)
const bodyParser = require('body-parser') // express middleware
const compression = require('compression') // express middleware


// express.js
var express_server = express()

let adm_login_route = uuid.v4()
let adm_route = uuid.v4()
let adm_pass = uuid.v4()

console.dir({ login_route: adm_login_route, route: adm_route, password: adm_pass })

// @Todo: formalise property and variable names to thisKindOfCase 
express_server.globals = require('./config/globals.json')

function Channel() {
    this['server-launch-time'] = new Date().toJSON()
    this.currentTime = 0
}
express_server.active_channel = new Channel()

express_server.use(compression())
express_server.use(session({
    store: new sessionFileStore(),
    secret: uuid.v4(),
    resave: false,
    saveUninitialized: true
}))

express_server.set('views', path.join(__dirname, 'views'))
express_server.set('view engine', 'slm')

express_server.get('/', function (request, response) {
    response.render('index', {
        loggedIn: (request.sessions || {}).loggedIn,
        authorised: request.session.authorised,
        admin_link: (request.session.authorised ? adm_route : "")
    })
})

express_server.route('/' + adm_login_route)
    .get(function (request, response) {
        response.render('login')
    })
    .post(bodyParser.json(), function (request, response) {
        if (request.body.password == adm_pass) {
            request.session.authorised = true
            response.sendStatus(200)
        }
        else
        {
            response.sendStatus(500)
        }
    })

express_server.get('/' + adm_route, function (request, response) {
    if ((request.session || {}).authorised === true)
        response.render('admin', { express_server_settings: express_server.globals })
    else
        response.send(
            'Cannot ' + request.method + ' '
            + request.originalUrl || request.url + '\n')
})

express_server.post('/settings-inbox', bodyParser.json(), function (request, response) {
    if (express_server.globals.media_file != request.body.media_file) {
        express_server.active_channel.currentTime = 0
        websocket_server.clients.forEach((client) => {
            let authoritative_message = {
                'server-time': new Date().toJSON(),
                'video-seek-time': express_server.active_channel.currentTime
            }
            let authoritative_packet = { type: 'authoritative', message: authoritative_message }
            client.send(JSON.stringify(authoritative_packet))
        })
    }
    express_server.globals = request.body
    response.sendStatus(200)
})

express_server.use('/stream', function serveStatic(request, res, next) {
    send(request,
        express_server.globals.media_file,
        { root: path.join(__dirname, 'media') })
        .pipe(res)
})

express_server.use(express.static('public'))

express_server.listen(3016, function () {
    require('child_process').exec('git describe --always', function (err, stdout) {
        console.log(
            'listening on port *:3016 \n' +
            'version ' + stdout
        )
    })

})

// WebSocket server
const ws_server = require('ws').Server
const websocket_server = new ws_server({ express_server, port: 8080 })

websocket_server.on('connection', (ws) => {
    let welcome_message = {
        'server-launch-time': express_server.active_channel['server-launch-time'],
        'message-of-the-day': express_server.globals['message-of-the-day'],
        'video-seek-time': express_server.active_channel.currentTime
    }
    let welcome_packet = { type: 'welcome', message: welcome_message }
    ws.send(JSON.stringify(welcome_packet))
    ws.on('message', (data, flags) => {
        let parsed_data = JSON.parse(data)
        if (parsed_data.type === "admin-seek-time-update") {
            express_server.active_channel.currentTime = parsed_data.message['video-seek-time']
        }
        else if (parsed_data.type === "chat-message") {
            websocket_server.clients.forEach((client) => {
                let chat_message = {
                    'server-time': new Date().toJSON(),
                    'chat-message': parsed_data.message['chat-message'],
                    'chat-message-owner': parsed_data.message['chat-message-owner']
                }
                let chat_packet = { type: 'incoming-chat-message', message: chat_message }
                client.send(JSON.stringify(chat_packet))
            })
        }
    })
    setInterval(() => {
        websocket_server.clients.forEach((client) => {
            let heartbeat_message = {
                'server-time': new Date().toJSON(),
                'video-seek-time': express_server.active_channel.currentTime
            }
            let heartbeat_packet = { type: 'heartbeat', message: heartbeat_message }
            client.send(JSON.stringify(heartbeat_packet))
        })
    }, 1000)
})



