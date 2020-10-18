#!/usr/bin/env node

const mineos = require('./mineos')
const server = require('./server')
const async = require('async')
const fs = require('fs-extra')

const express = require('express')
const compression = require('compression')
const passport = require('passport')
const LocalStrategy = require('passport-local')
const passportSocketIO = require("passport.socketio")
const expressSession = require('express-session')
const bodyParser = require('body-parser')
const methodOverride = require('method-override')
const cookieParser = require('cookie-parser')

const sessionStore = new expressSession.MemoryStore()
const app = express()
const http = require('http').Server(app)

const response_options = {root: __dirname}

// Authorization
const localAuth = function (username, password) {
    const Q = require('q')
    const auth = require('./auth')
    const deferred = Q.defer()

    auth.authenticate_shadow(username, password, (authed_user) => {
        if (authed_user) {
            deferred.resolve({ username: authed_user })
        } else {
            deferred.reject(new Error('incorrect password'))
        }
    })

    return deferred.promise
}

// Passport init
passport.serializeUser((user, done) => {
    //console.log("serializing " + user.username);
    done(null, user)
})

passport.deserializeUser((obj, done) => {
    //console.log("deserializing " + obj);
    done(null, obj)
})

// Use the LocalStrategy within Passport to login users.
passport.use('local-signin', new LocalStrategy(
    {passReqToCallback : true}, //allows us to pass back the request to the callback
    ((req, username, password, done) => {
        localAuth(username, password)
            .then((user) => {
                if (user) {
                    console.log('Successful login attempt for username:', username)
                    const logstring = `${new Date().toString() } - success from: ${ req.connection.remoteAddress } user: ${ username }\n`
                    fs.appendFileSync('/var/log/mineos.auth.log', logstring)
                    done(null, user)
                }
            })
            .fail(() => {
                console.log('Unsuccessful login attempt for username:', username)
                const logstring = `${new Date().toString() } - failure from: ${ req.connection.remoteAddress } user: ${ username }\n`
                fs.appendFileSync('/var/log/mineos.auth.log', logstring)
                done(null)
            })
    })
))

// clean up sessions that go stale over time
function session_cleanup() {
    //http://stackoverflow.com/a/10761522/1191579
    sessionStore.all((err, sessions) => {
        for (let i = 0; i < sessions.length; i++) {
            sessionStore.get(sessions[i], () => 0 )
        }
    })
}

// Simple route middleware to ensure user is authenticated.
function ensureAuthenticated(req, res, next) {
    if (req.isAuthenticated()) {
        return next() 
    }
    req.session.error = 'Please sign in!'
    res.redirect('/admin/login.html')
    return false
}

const token = require('crypto').randomBytes(48).toString('hex')

app.use(bodyParser.urlencoded({extended: false}))
app.use(methodOverride())
app.use(compression())
app.use(expressSession({ 
    secret: token,
    key: 'express.sid',
    store: sessionStore,
    resave: false,
    saveUninitialized: false
}))
app.use(passport.initialize())
app.use(passport.session())

const io = require('socket.io')(http)
io.use(passportSocketIO.authorize({
    cookieParser: cookieParser, // the same middleware you registrer in express
    key:          'express.sid', // the name of the cookie where express/connect stores its session_id
    secret:       token, // the session_secret to parse the cookie
    store:        sessionStore // we NEED to use a sessionstore. no memorystore please
}))

function tally() {
    const os = require('os')
    const urllib = require('urllib')
    const child_process = require('child_process')

    const tally_info = {
        sysname: os.type(), 
        release: os.release(), 
        nodename: os.hostname(),
        version: '',
        machine: process.arch
    }

    child_process.execFile('uname', ['-v'], (err, output) => {
        if (!err) {
            tally_info['version'] = output.replace(/\n/,'')
        }
        urllib.request('http://minecraft.codeemo.com/tally/tally-node.py', {data: tally_info}, () => 0)
    })
}

function read_ini(filepath) {
    const ini = require('ini')
    try {
        const data = fs.readFileSync(filepath)
        return ini.parse(data.toString())
    } catch (e) {
        return null
    }
}

mineos.dependencies((dependencyError, binaries) => {
    if (dependencyError) {
        console.error('MineOS is missing dependencies:', dependencyError)
        console.log(binaries)
        process.exit(1)
    } 

    const mineos_config = read_ini('/etc/mineos.conf') || read_ini('/usr/local/etc/mineos.conf') || {}
    let base_directory = '/var/games/minecraft'

    if ('base_directory' in mineos_config) {
        try {
            if (mineos_config['base_directory'].length < 2) {
                throw new error('Invalid base_directory length.')
            }

            base_directory = mineos_config['base_directory']
            fs.ensureDirSync(base_directory)

        } catch (e) {
            console.error(e.message, 'Aborting startup.')
            process.exit(2) 
        }

        console.info('base_directory found in mineos.conf, using:', base_directory)
    } else {
        console.error('base_directory not specified--missing mineos.conf?')
        console.error('Aborting startup.')
        process.exit(4) 
    }

    const be = new server.backend(base_directory, io, mineos_config)

    tally()
    setInterval(tally, 7200000) //7200000 == 120min

    app.get('/', (req, res) => {
        res.redirect('/admin/index.html')
    })

    app.get('/admin/index.html', ensureAuthenticated, (req, res) => {
        res.sendFile('/html/index.html', response_options)
    })

    app.get('/login', (req, res) => {
        res.sendFile('/html/login.html')
    })

    app.post('/auth', passport.authenticate('local-signin', {
        successRedirect: '/admin/index.html',
        failureRedirect: '/admin/login.html'
    })
    )

    app.all('/api/:server_name/:command', ensureAuthenticated, (req, res) => {
        const target_server = req.params.server_name
        const user = req.user.username
        const instance = be.servers[target_server]

        const args = req.body
        args['command'] = req.params.command

        if (instance) {
            instance.direct_dispatch(user, args)
        } else {
            console.error('Ignoring request by "', user, '"; no server found named [', target_server, ']')
        }

        res.end()
    })

    app.post('/admin/command', ensureAuthenticated, (req, res) => {
        const target_server = req.body.server_name
        const instance = be.servers[target_server]
        const user = req.user.username
    
        if (instance) {
            instance.direct_dispatch(user, req.body)
        } else {
            console.error('Ignoring request by "', user, '"; no server found named [', target_server, ']')
        }
    
        res.end()
    })

    app.get('/logout', (req, res) => {
        req.logout()
        res.redirect('/admin/login.html')
    })

    app.use('/socket.io', express.static(`${__dirname }/node_modules/socket.io`))
    app.use('/angular', express.static(`${__dirname }/node_modules/angular`))
    app.use('/angular-translate', express.static(`${__dirname }/node_modules/angular-translate/dist`))
    app.use('/moment', express.static(`${__dirname }/node_modules/moment`))
    app.use('/angular-moment', express.static(`${__dirname }/node_modules/angular-moment`))
    app.use('/angular-moment-duration-format', express.static(`${__dirname }/node_modules/moment-duration-format/lib`))
    app.use('/angular-sanitize', express.static(`${__dirname }/node_modules/angular-sanitize`))
    app.use('/admin', express.static(`${__dirname }/html`))

    process.on('SIGINT', () => {
        console.log("Caught interrupt signal; closing webui....")
        be.shutdown()
        process.exit()
    })

    let SOCKET_PORT = null
    let SOCKET_HOST = '0.0.0.0'
    let USE_HTTPS = true

    if ('use_https' in mineos_config) {
        USE_HTTPS = mineos_config['use_https']
    }

    if ('socket_host' in mineos_config) {
        SOCKET_HOST = mineos_config['socket_host']
    }

    if ('socket_port' in mineos_config) {
        SOCKET_PORT = mineos_config['socket_port']
    } else
    if (USE_HTTPS) {
        SOCKET_PORT = 8443
    } else {
        SOCKET_PORT = 8080
    }

    if (USE_HTTPS) {
        keyfile = mineos_config['ssl_private_key'] || '/etc/ssl/certs/mineos.key'
        certfile = mineos_config['ssl_certificate'] || '/etc/ssl/certs/mineos.crt'
        async.parallel({
            key: async.apply(fs.readFile, keyfile),
            cert: async.apply(fs.readFile, certfile)
        }, (err, ssl) => {
            if (err) {
                console.error(`Could not locate required SSL files ${ keyfile 
	              } and/or ${ certfile }, aborting server start.`)
                process.exit(3)
            } else {
                const https = require('https')

                if ('ssl_cert_chain' in mineos_config) {
                    try {
                        const cert_chain_data = fs.readFileSync(mineos_config['ssl_cert_chain'])
                        if (cert_chain_data.length) {
                            ssl['ca'] = cert_chain_data
                        }
                    } catch (e) {}
                }

                const https_server = https.createServer(ssl, app).listen(SOCKET_PORT, SOCKET_HOST, () => {
                    io.attach(https_server)
                    console.log(`MineOS webui listening on HTTPS://${ SOCKET_HOST }:${ SOCKET_PORT}`)
                })
            }
        })
    } else {
        console.warn('mineos.conf set to host insecurely: starting HTTP server.')
        http.listen(SOCKET_PORT, SOCKET_HOST, () => {
            console.log(`MineOS webui listening on HTTP://${ SOCKET_HOST }:${ SOCKET_PORT}`)
        })
    }

    setInterval(session_cleanup, 3600000) //check for expired sessions every hour

})
