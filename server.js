const mineos = require('./mineos')
const async = require('async')
const path = require('path')
const os = require('os')
const logging = require('winston')
const fs = require('fs-extra')

logging.add(logging.transports.File, {
    filename: '/var/log/mineos.log',
    handleExceptions: true
})

function server_container(server_name, user_config, socket_io) {
    // when evoked, creates a permanent 'mc' instance, namespace, and place for file tails.
    const self = this
    const HEARTBEAT_INTERVAL_MS = 5000
    const instance = new mineos.mc(server_name, user_config.base_directory)
    const nsp = socket_io.of('/{0}'.format(server_name))
    const tails = {}
    const notices = []
    let cron = {}
    const intervals = {}
    let COMMIT_INTERVAL_MIN = null

    logging.info('[{0}] Discovered server'.format(server_name))

    // check that awd and bwd also exist alongside cwd or create and chown
    let missing_dir = false
    try {
        fs.accessSync(instance.env.bwd, fs.F_OK) 
    } catch (e) {
        missing_dir = true 
    }
    try {
        fs.accessSync(instance.env.awd, fs.F_OK) 
    } catch (e) {
        missing_dir = true 
    }

    if (missing_dir) {
        async.series([
            async.apply(fs.ensureDir, instance.env.bwd),
            async.apply(fs.ensureDir, instance.env.awd),
            async.apply(instance.sync_chown)
        ])
    }

    //async.series([ async.apply(instance.sync_chown) ]);
    //uncomment sync_chown to correct perms on server discovery
    //commenting out for high cpu usage on startup

    let files_to_tail = ['logs/latest.log', 'server.log', 'proxy.log.0', 'logs/fml-server-latest.log']
    if ( (user_config || {}).additional_logfiles ) { //if additional_logfiles key:value pair exists, use it
        let additional = user_config['additional_logfiles'].split(',')
        additional = additional.filter((e) => {
            return e
        }) //remove non-truthy entries like ''
        additional = additional.map((e) => {
            return e.trim()
        }) //remove trailing and tailing whitespace
        additional = additional.map((e) => {
            return path.normalize(e).replace(/^(\.\.[\/\\])+/, '') // ]/this comment is for my syntax highlighter
        }) //normalize path, remove traversal

        logging.info('Explicitly added files to tail are:', additional)
        files_to_tail = files_to_tail.concat(additional)
    }
    
    function make_tail(rel_filepath) {
    /* makes a file tail relative to the CWD, e.g., /var/games/minecraft/servers/myserver.
       tails are used to get live-event reads on files.

       if the server does not exist, a watch is made in the interim, waiting for its creation.
       once the watch is satisfied, the watch is closed and a tail is finally created.
    */
        const tail = require('tail').Tail
        const abs_filepath = path.join(instance.env.cwd, rel_filepath)

        if (rel_filepath in tails) {
            logging.warn('[{0}] Tail already exists for {1}'.format(server_name, rel_filepath))
            return
        }

        try {
            const new_tail = new tail(abs_filepath)
            logging.info('[{0}] Created tail on {1}'.format(server_name, rel_filepath))
            new_tail.on('line', (data) => {
                //logging.info('[{0}] {1}: transmitting new tail data'.format(server_name, rel_filepath));
                nsp.emit('tail_data', {'filepath': rel_filepath, 'payload': data})
            })
            tails[rel_filepath] = new_tail
        } catch (e) {
            logging.error('[{0}] Create tail on {1} failed'.format(server_name, rel_filepath))
            if (e.errno != -2) {
                logging.error(e)
                return //exit execution to perhaps curb a runaway process
            }
            logging.info('[{0}] Watching for file generation: {1}'.format(server_name, rel_filepath))

            const fireworm = require('fireworm')
            const default_skips = ['world', 'world_the_end', 'world_nether', 'dynmap', 'plugins', 'web', 'region', 'playerdata', 'stats', 'data']
            const fw = fireworm(instance.env.cwd, {skipDirEntryPatterns: default_skips})

            fw.add('**/{0}'.format(rel_filepath))
            fw.on('add', (fp) => {
                if (abs_filepath == fp) {
                    fw.clear()
                    logging.info('[{0}] {1} created! Watchfile {2} closed'.format(server_name, path.basename(fp), rel_filepath))
                    async.nextTick(() => {
                        make_tail(rel_filepath) 
                    })
                }
            })
        }
    }

    for (const i in files_to_tail) {
        make_tail(files_to_tail[i])
    }

    function broadcast_cy() {
    // function to broadcast raw config.yml from bungeecord
        const filepath = path.join(instance.env.cwd, 'config.yml')
        fs.readFile(filepath, (err, data) => {
            if (!err) {
                nsp.emit('config.yml', Buffer.from(data).toString())
            }
        })
    }

    function broadcast_icon() {
    // function to encode file data to base64 encoded string
    //http://www.hacksparrow.com/base64-encoding-decoding-in-node-js.html
        const filepath = path.join(instance.env.cwd, 'server-icon.png')
        fs.readFile(filepath, (err, data) => {
            //magic number for png first 4B
            if (!err && data.toString('hex',0,4) == '89504e47') {
                nsp.emit('server-icon.png', Buffer.from(data).toString('base64'))
            }
        })
    }

    function emit_eula() {
        async.waterfall([
            async.apply(instance.property, 'eula'),
            function(accepted, cb) {
                logging.info('[{0}] eula.txt detected: {1} (eula={2})'.format(server_name,
                    (accepted ? 'ACCEPTED' : 'NOT YET ACCEPTED'),
                    accepted))
                nsp.emit('eula', accepted)
                cb()
            },
        ])
    }

    function broadcast_notices() {
        nsp.emit('notices', notices)
    }

    function broadcast_sp() {
        instance.sp((err, sp_data) => {
            logging.debug('[{0}] broadcasting server.properties'.format(server_name))
            nsp.emit('server.properties', sp_data)
        })
    }

    function broadcast_sc() {
        instance.sc((err, sc_data) => {
            logging.debug('[{0}] broadcasting server.config'.format(server_name))
            if (!err) {
                nsp.emit('server.config', sc_data)
            }
        })
    }

    function broadcast_cc() {
        instance.crons((err, cc_data) => {
            logging.debug('[{0}] broadcasting cron.config'.format(server_name))
            if (!err) {
                nsp.emit('cron.config', cc_data)
            }
        })
    }

    (function() {
        const fireworm = require('fireworm')

        let skip_dirs = fs.readdirSync(instance.env.cwd).filter((p) => {
            try {
                return fs.statSync(path.join(instance.env.cwd, p)).isDirectory()
            } catch (e) {
                logging.error(e)
                return false
            }
        })

        const default_skips = ['world', 'world_the_end', 'world_nether', 'dynmap', 'plugins', 'web', 'region', 'playerdata', 'stats', 'data']
        for (const i in default_skips) {
            if (skip_dirs.indexOf(default_skips[i]) == -1) {
                skip_dirs.push(default_skips[i])
            }
        }

        skip_dirs = skip_dirs.filter((e) => {
            return e !== 'logs' 
        }) // remove 'logs' from blacklist!

        logging.info('[{0}] Using skipDirEntryPatterns: {1}'.format(server_name, skip_dirs))

        const fw = fireworm(instance.env.cwd, {skipDirEntryPatterns: skip_dirs})

        for (const i in skip_dirs) {
            fw.ignore(skip_dirs[i])
        }
        fw.add('**/server.properties')
        fw.add('**/server.config')
        fw.add('**/cron.config')
        fw.add('**/eula.txt')
        fw.add('**/server-icon.png')
        fw.add('**/config.yml')

        const FS_DELAY = 250 
        function handle_event(fp) {
            // because it is unknown when fw triggers on add/change and
            // further because if it catches DURING the write, it will find
            // the file has 0 size, adding arbitrary delay.
            // process.nexttick didnt work.
            const file_name = path.basename(fp)
            switch (file_name) {
            case 'server.properties':
                setTimeout(broadcast_sp, FS_DELAY)
                break
            case 'server.config':
                setTimeout(broadcast_sc, FS_DELAY)
                break
            case 'cron.config':
                setTimeout(broadcast_cc, FS_DELAY)
                break
            case 'eula.txt':
                setTimeout(emit_eula, FS_DELAY)
                break
            case 'server-icon.png':
                setTimeout(broadcast_icon, FS_DELAY)
                break
            case 'config.yml':
                setTimeout(broadcast_cy, FS_DELAY)
                break
            }
        }

        fw.on('add', handle_event)
        fw.on('change', handle_event)
    })()

    function heartbeat() {
        clearInterval(intervals['heartbeat'])
        intervals['heartbeat'] = setInterval(heartbeat, HEARTBEAT_INTERVAL_MS * 3)

        async.parallel({
            'up': function(cb) {
                instance.property('up', (err, is_up) => {
                    cb(null, is_up) 
                }) 
            },
            'memory': function(cb) {
                instance.property('memory', (err, mem) => {
                    cb(null, err ? {} : mem) 
                }) 
            },
            'ping': function(cb) {
                instance.property('unconventional', (err, is_unconventional) => {
                    if (is_unconventional) {
                        cb(null, {})
                    } else {
                        //ignore ping--wouldn't respond in any meaningful way
                        instance.property('ping', (pingError, ping) => {
                            cb(null, pingError ? {} : ping) 
                        })
                    }
                })
            },
            'query': function(cb) {
                instance.property('server.properties', (err, dict) => {
                    if ((dict || {})['enable-query']) {
                        instance.property('query', cb)
                    } else {
                        cb(null, {})
                    } //ignore query--wouldn't respond in any meaningful way
                })
            }
        }, (err, retval) => {
            clearInterval(intervals['heartbeat'])
            intervals['heartbeat'] = setInterval(heartbeat, HEARTBEAT_INTERVAL_MS)

            nsp.emit('heartbeat', {
                'server_name': server_name,
                'timestamp': Date.now(),
                'payload': retval
            })
        })
    }

    intervals['heartbeat'] = setInterval(heartbeat, HEARTBEAT_INTERVAL_MS)

    function world_committer() {
        async.waterfall([
            async.apply(instance.property, 'commit_interval'),
            function(minutes) {
                if (minutes != COMMIT_INTERVAL_MIN) { //upon change or init
                    COMMIT_INTERVAL_MIN = minutes
                    if (minutes > 0) {
                        logging.info('[{0}] committing world to disk every {1} minutes.'.format(server_name, minutes))
                        intervals['commit'] = setInterval(instance.saveall, minutes * 60 * 1000)
                    } else {
                        logging.info('[{0}] not committing world to disk automatically (interval set to {1})'.format(server_name, minutes))
                        clearInterval(intervals['commit'])
                    }
                }
            }
        ])
    }
    
    intervals['world_commit'] = setInterval(world_committer, 1 * 60 * 1000)

    (() => {
        const CronJob = require('cron').CronJob

        function cron_dispatcher(args) {
            const introspect = require('introspect')
            const arg_array = []

            const fn = instance[args.command]
            const required_args = introspect(fn)

            for (const i in required_args) {
                // all callbacks expected to follow the pattern (success, payload).
                if (required_args[i] == 'callback') {
                    arg_array.push((err) => {
                        args.success = !err
                        args.err = err
                        args.time_resolved = Date.now()
                        if (err) {
                            logging.error('[{0}] command "{1}" errored out:'.format(server_name, args.command), args)
                        }
                    })
                } else if (required_args[i] in args) {
                    arg_array.push(args[required_args[i]])
                }
            }

            fn.apply(instance, arg_array)
        }

        instance.crons((err, cron_dict) => {
            for (const cronhash in cron_dict) {
                if (cron_dict[cronhash].enabled) {
                    try {
                        cron[cronhash] = new CronJob({
                            cronTime: cron_dict[cronhash].source,
                            onTick: function() {
                                cron_dispatcher(this)
                            },
                            start: true,
                            context: cron_dict[cronhash]
                        })
                    } catch (e) {
                        // catches invalid cron expressions
                        logging.warn('[{0}] invalid cron expression:'.format(server_name), cronhash, cron_dict[cronhash])
                        instance.set_cron(cronhash, false, () => 0)
                    }
                }
            }
        })
    })()

    self.broadcast_to_lan = function(callback) {
        async.waterfall([
            async.apply(instance.verify, 'exists'),
            async.apply(instance.verify, 'up'),
            async.apply(instance.sc),
            function(sc_data, cb) {
                const broadcast_value = (sc_data.minecraft || {}).broadcast
                cb(!broadcast_value) //logically notted to make broadcast:true pass err cb
            },
            async.apply(instance.sp)
        ], (err, sp_data) => {
            if (err) {
                callback(null)
            } else {
                const msg = Buffer.from(`[MOTD]${ sp_data.motd }[/MOTD][AD]${ sp_data['server-port'] }[/AD]`)
                const server_ip = sp_data['server-ip']
                callback(msg, server_ip)
            }
        })
    }

    self.onreboot_start = function(callback) {
        async.waterfall([
            async.apply(instance.property, 'onreboot_start'),
            function(autostart, cb) {
                logging.info('[{0}] autostart = {1}'.format(server_name, autostart))
                cb(!autostart) //logically NOT'ing so that autostart = true continues to next func
            },
            async.apply(instance.start)
        ], (err) => {
            callback(err)
        })
    }

    self.cleanup = function () {
        for (const t in tails) {
            tails[t].unwatch()
        }

        for (const i in intervals) {
            clearInterval(intervals[i])
        }

        nsp.removeAllListeners()
    }

    self.direct_dispatch = function(user, args) {
        const introspect = require('introspect')
        let fn; let required_args
        const arg_array = []

        async.waterfall([
            async.apply(instance.property, 'owner'),
            function(ownership_data, cb) {
                const auth = require('./auth')
                auth.test_membership(user, ownership_data.groupname, (is_valid) => {
                    cb(null, is_valid)
                })
            },
            function(is_valid, cb) {
                cb(!is_valid) //logical NOT'ted:  is_valid ? falsy error, !is_valid ? truthy error
            }
        ], (err) => {
            if (err) {
                logging.error('User "{0}" does not have permissions on [{1}]:'.format(user, args.server_name), args)
            } else {
                try {
                    fn = instance[args.command]
                    required_args = introspect(fn)
                    // receives an array of all expected arguments, using introspection.
                    // they are in order as listed by the function definition, which makes iteration possible.
                } catch (e) {
                    args.success = false
                    args.error = e
                    args.time_resolved = Date.now()
                    nsp.emit('server_fin', args)
                    logging.error('server_fin', args)

                    return
                }

                for (const i in required_args) {
                    // all callbacks expected to follow the pattern (success, payload).
                    if (required_args[i] == 'callback') {
                        arg_array.push((argError) => {
                            args.success = !argError
                            args.err = argError
                            args.time_resolved = Date.now()
                            nsp.emit('server_fin', args)
                            if (argError) {
                                logging.error('[{0}] command "{1}" errored out:'.format(server_name, args.command), args)
                            }
                            logging.log('server_fin', args)
                        })
                    } else if (required_args[i] in args) {
                        arg_array.push(args[required_args[i]])
                    } else {
                        args.success = false
                        logging.error('Provided values missing required argument', required_args[i])
                        args.error = 'Provided values missing required argument: {0}'.format(required_args[i])
                        nsp.emit('server_fin', args)
                        return
                    }
                }

                if (args.command == 'delete') {
                    self.cleanup()
                }

                logging.info('[{0}] received request "{1}"'.format(server_name, args.command))
                fn.apply(instance, arg_array)
            }
        })
    }

    nsp.on('connection', (socket) => {
        const ip_address = socket.request.connection.remoteAddress
        const username = socket.request.user.username
        const NOTICES_QUEUE_LENGTH = 10 // 0 < q <= 10

        function server_dispatcher(args) {
            const introspect = require('introspect')
            let fn; let required_args
            const arg_array = []

            try {
                fn = instance[args.command]
                required_args = introspect(fn)
                // receives an array of all expected arguments, using introspection.
                // they are in order as listed by the function definition, which makes iteration possible.
            } catch (e) {
                args.success = false
                args.error = e
                args.time_resolved = Date.now()
                nsp.emit('server_fin', args)
                logging.error('server_fin', args)

                while (notices.length > NOTICES_QUEUE_LENGTH) {
                    notices.shift()
                }
                notices.push(args)
                return
            }

            for (const i in required_args) {
                // all callbacks expected to follow the pattern (success, payload).
                if (required_args[i] == 'callback') {
                    arg_array.push((err) => {
                        args.success = !err
                        args.err = err
                        args.time_resolved = Date.now()
                        nsp.emit('server_fin', args)
                        if (err) {
                            logging.error('[{0}] command "{1}" errored out:'.format(server_name, args.command), args)
                        }
                        logging.log('server_fin', args)

                        while (notices.length > NOTICES_QUEUE_LENGTH) {
                            notices.shift()
                        }

                        if (args.command != 'delete') {
                            notices.push(args)
                        }
                    })
                } else if (required_args[i] in args) {
                    arg_array.push(args[required_args[i]])
                } else {
                    args.success = false
                    logging.error('Provided values missing required argument', required_args[i])
                    args.error = 'Provided values missing required argument: {0}'.format(required_args[i])
                    nsp.emit('server_fin', args)
                    return
                }
            }

            if (args.command == 'delete') {
                self.cleanup()
            }

            logging.info('[{0}] received request "{1}"'.format(server_name, args.command))
            fn.apply(instance, arg_array)
        }

        function produce_receipt(args) {
            /* when a command is received, immediately respond to client it has been received */
            const uuid = require('node-uuid')
            logging.info('[{0}] {1} issued command : "{2}"'.format(server_name, ip_address, args.command))
            args.uuid = uuid.v1()
            args.time_initiated = Date.now()
            nsp.emit('server_ack', args)

            switch (args.command) {
            case 'chown':
                async.waterfall([
                    async.apply(instance.property, 'owner'),
                    function(owner_data, cb) {
                        if (owner_data.username != username) {
                            cb('Only the current user owner may reassign server ownership.')
                        } else if (owner_data.uid != args.uid) {
                            cb('You may not change the user owner of the server.')
                        } else {
                            cb()
                        }
                    }
                ], (err) => {
                    if (err) {
                        args.success = false
                        args.err = err
                        args.time_resolved = Date.now()
                        logging.error('[{0}] command "{1}" errored out:'.format(server_name, args.command), args)
                        nsp.emit('server_fin', args)
                    } else {
                        server_dispatcher(args)
                    }
                })
                break
            default:
                server_dispatcher(args)
                break
            }

        }

        function get_file_contents(rel_filepath) {
            if (rel_filepath in tails) { //this is the protection from malicious client
                const abs_filepath = path.join(instance.env['cwd'], rel_filepath)
                const FILESIZE_LIMIT_THRESHOLD = 256000

                async.waterfall([
                    async.apply(fs.stat, abs_filepath),
                    function(stat_data, cb) {
                        cb(stat_data.size > FILESIZE_LIMIT_THRESHOLD)
                    },
                    async.apply(fs.readFile, abs_filepath),
                    function(data, cb) {
                        logging.info('[{0}] transmittting existing file contents: {1} ({2} bytes)'.format(server_name, rel_filepath, data.length))
                        nsp.emit('file head', {filename: rel_filepath, payload: data.toString()})
                        cb()
                    }
                ], (err) => {
                    if (err) {
                        const msg = "File is too large (> {0} KB).  Only newly added lines will appear here.".format(FILESIZE_LIMIT_THRESHOLD/1000)
                        nsp.emit('file head', {filename: rel_filepath, payload: msg })
                    }
                })
            }
        }

        function get_available_tails() {
            for (t in tails) {
                get_file_contents(tails[t].filename.replace(`${instance.env.cwd }/`, ''))
            }
        }

        function get_prop(requested) {
            logging.info('[{0}] {1} requesting property: {2}'.format(server_name, ip_address, requested.property))
            instance.property(requested.property, (err, retval) => {
                logging.info('[{0}] returned to {1}: {2}'.format(server_name, ip_address, retval))
                nsp.emit('server_fin', {'server_name': server_name, 'property': requested.property, 'payload': retval})
            })
        }

        function get_page_data(page) {
            switch (page) {
            case 'glance':
                logging.debug('[{0}] {1} requesting server at a glance info'.format(server_name, username))

                async.parallel({
                    'increments': async.apply(instance.list_increments),
                    'archives': async.apply(instance.list_archives),
                    'du_awd': async.apply(instance.property, 'du_awd'),
                    'du_bwd': async.apply(instance.property, 'du_bwd'),
                    'du_cwd': async.apply(instance.property, 'du_cwd'),
                    'owner': async.apply(instance.property, 'owner'),
                    'server_files': async.apply(instance.property, 'server_files'),
                    'ftb_installer': async.apply(instance.property, 'FTBInstall.sh'),
                    'eula': async.apply(instance.property, 'eula'),
                    'base_dir': function(cb) {
                        cb(null, user_config.base_directory)
                    }
                }, (err, results) => {
                    if (err instanceof Object) {
                        logging.error('[{0}] Error with get_page_data'.format(server_name), err, results)
                    }
                    nsp.emit('page_data', {page: page, payload: results})
                })
                break
            default:
                nsp.emit('page_data', {page: page})
                break
            }
        }

        function manage_cron(opts) {
            const hash = require('object-hash')
            const CronJob = require('cron').CronJob

            function reload_cron(callback) {
                for (const c in cron) {
                    try {
                        cron[c].stop()
                    } catch (e) {
                        console.error(e)
                    }
                }
                cron = {}

                instance.crons((err, cron_dict) => {
                    for (const cronhash in cron_dict) {
                        if (cron_dict[cronhash].enabled) {
                            try {
                                cron[cronhash] = new CronJob({
                                    cronTime: cron_dict[cronhash].source,
                                    onTick: function() {
                                        server_dispatcher(this)
                                    },
                                    start: true,
                                    context: cron_dict[cronhash]
                                })
                            } catch (e) {
                                //catches invalid cron pattern, disables cron
                                logging.warn('[{0}] {1} invalid cron expression submitted:'.format(server_name, ip_address), cron_dict[cronhash].source)
                                instance.set_cron(opts.hash, false, () => 0)
                            }
                        }
                    }
                    callback()
                })
            }

            const operation = opts.operation
            delete opts.operation

            switch (operation) {
            case 'create': {
                const cron_hash = hash(opts)
                logging.log('[{0}] {1} requests cron creation:'.format(server_name, ip_address), cron_hash, opts)

                opts['enabled'] = false

                async.series([
                    async.apply(instance.add_cron, cron_hash, opts),
                    async.apply(reload_cron)
                ])
                break
            }
            case 'delete':
                logging.log('[{0}] {1} requests cron deletion: {2}'.format(server_name, ip_address, opts.hash))

                try {
                    cron[opts.hash].stop()
                } catch (e) {
                    console.error(e)
                }

                try {
                    delete cron[opts.hash]
                } catch (e) {
                    console.error(e)
                }

                async.series([
                    async.apply(instance.delete_cron, opts.hash),
                    async.apply(reload_cron)
                ])
                break
            case 'start':
            case 'suspend':
                logging.log(`[{0}] {1} ${operation}ing cron: {2}`.format(server_name, ip_address, opts.hash))

                async.series([
                    async.apply(instance.set_cron, opts.hash, operation === "start"),
                    async.apply(reload_cron)
                ])
            default:
                logging.warn('[{0}] {1} requested unexpected cron operation: {2}'.format(server_name, ip_address, operation), opts)
            }
        }

        async.waterfall([
            async.apply(instance.property, 'owner'),
            function(ownership_data, cb) {
                const auth = require('./auth')
                auth.test_membership(username, ownership_data.groupname, (is_valid) => {
                    cb(null, is_valid)
                })
            },
            function(is_valid, cb) {
                cb(!is_valid) //logical NOT'ted:  is_valid ? falsy error, !is_valid ? truthy error
            }
        ], (err) => {
            if (err) {
                socket.disconnect()
            } else {
                logging.info('[{0}] {1} ({2}) joined server namespace'.format(server_name, username, ip_address))

                socket.on('command', produce_receipt)
                socket.on('get_file_contents', get_file_contents)
                socket.on('get_available_tails', get_available_tails)
                socket.on('property', get_prop)
                socket.on('page_data', get_page_data)
                socket.on('cron', manage_cron)
                socket.on('server.properties', broadcast_sp)
                socket.on('server.config', broadcast_sc)
                socket.on('cron.config', broadcast_cc)
                socket.on('server-icon.png', broadcast_icon)
                socket.on('config.yml', broadcast_cy)
                socket.on('req_server_activity', broadcast_notices)
            }
        })

    }) //nsp on connect container ends
}

exports.backend = class {
    constructor(base_dir, socket_emitter, user_config) {

        this.servers = {}
        this.profiles = []
        this.front_end = socket_emitter
        this.commit_msg = ''
        this.base_dir = base_dir

        process.umask('0002')

        fs.ensureDirSync(base_dir)
        fs.ensureDirSync(path.join(base_dir, mineos.DIRS['servers']))
        fs.ensureDirSync(path.join(base_dir, mineos.DIRS['backup']))
        fs.ensureDirSync(path.join(base_dir, mineos.DIRS['archive']))
        fs.ensureDirSync(path.join(base_dir, mineos.DIRS['import']))
        fs.ensureDirSync(path.join(base_dir, mineos.DIRS['profiles']))

        fs.chmod(path.join(base_dir, mineos.DIRS['import']), '0777')
    
        const which = require('which')

        async.waterfall([
            async.apply(which, 'git'),
            (gitPath, cb) => {
                const child = require('child_process')
                const opts = {cwd: __dirname}
                child.execFile(gitPath, [ 'show', '--oneline', '-s' ], opts, cb)
            },
            (stdout, stderr, cb) => {
                this.commit_msg = (stdout ? stdout : '')
                logging.info('Starting up server, using commit:', this.commit_msg)
                cb()
            }
        ])

        //thanks to https://github.com/flareofghast/node-advertiser/blob/master/advert.js
        const dgram = require('dgram')
        const udp_broadcaster = {}
        const UDP_DEST = '255.255.255.255'
        const UDP_PORT = 4445
        const BROADCAST_DELAY_MS = 4000

        async.forever(
            (next) => {
                for (const s of Object.values(this.servers)) {
                    s.broadcast_to_lan((msg, server_ip) => {
                        if (msg) {
                            if (udp_broadcaster[server_ip]) {
                                udp_broadcaster[server_ip].send(msg, 0, msg.length, UDP_PORT, UDP_DEST)
                            } else {
                                udp_broadcaster[server_ip] = dgram.createSocket('udp4')
                                udp_broadcaster[server_ip].bind(UDP_PORT, server_ip)
                                udp_broadcaster[server_ip].on("listening", () => {
                                    udp_broadcaster[server_ip].setBroadcast(true)
                                    udp_broadcaster[server_ip].send(msg, 0, msg.length, UDP_PORT, UDP_DEST)
                                })
                                udp_broadcaster[server_ip].on("error", () => {
                                    logging.error(`Cannot bind broadcaster to ip ${ server_ip}`)
                                })
                            }
                        }
                    })
                }
                setTimeout(next, BROADCAST_DELAY_MS)
            }
        )

        const procfs = require('procfs-stats')
        const HOST_HEARTBEAT_DELAY_MS = 1000

        const host_heartbeat = () => {
            async.waterfall([
                async.apply(procfs.meminfo)
            ], (err, meminfo) => {
                this.front_end.emit('host_heartbeat', {
                    'uptime': os.uptime(),
                    'freemem': ((meminfo && meminfo['MemAvailable']) ? meminfo['MemAvailable'] * 1024 : os.freemem()),
                    'loadavg': os.loadavg()
                })
            })
        }

        setInterval(host_heartbeat, HOST_HEARTBEAT_DELAY_MS)

        const server_path = path.join(base_dir, mineos.DIRS['servers'])

        //http://stackoverflow.com/a/24594123/1191579
        const discover = () =>
            fs.readdirSync(server_path).filter((p) => {
                try {
                    return fs.statSync(path.join(server_path, p)).isDirectory()
                } catch (e) {
                    logging.warn("Filepath {0} does not point to an existing directory".format(path.join(server_path,p)))
                }
                return false
            })

        const track = (sn) => {
            this.servers[sn] = null
            //if new server_container() isn't instant, double broadcast might trigger this if/then twice
            //setting to null is immediate and prevents double execution
            this.servers[sn] = new server_container(sn, user_config, this.front_end)
            this.front_end.emit('track_server', sn)
        }

        const untrack = (sn) => {
            try {
                this.servers[sn].cleanup()
                delete this.servers[sn]
            } catch (e) {
                //if server has already been deleted and this is running for reasons unknown, catch and ignore
            } finally {
                this.front_end.emit('untrack_server', sn)
            }
        }

        const discovered_servers = discover()
        for (const i in discovered_servers) {
            track(discovered_servers[i])
        }

        fs.watch(server_path, () => {
            const current_servers = discover()

            for (const i in current_servers) {
                //if detected directory not a discovered server, track
                if (!(current_servers[i] in this.servers)) {
                    track(current_servers[i])
                }
            }

            for (const s in this.servers) {
                if (current_servers.indexOf(s) < 0) {
                    untrack(s)
                }
            }

        })

        const fireworm = require('fireworm')
        const importable_archives = path.join(base_dir, mineos.DIRS['import'])

        const fw = fireworm(importable_archives)
        fw.add('**/*.zip')
        fw.add('**/*.tar')
        fw.add('**/*.tgz')
        fw.add('**/*.tar.gz')

        fw
            .on('add', (fp) => {
                logging.info('[WEBUI] New file found in import directory', fp)
                this.send_importable_list()
            })
            .on('remove', (fp) => {
                logging.info('[WEBUI] File removed from import directory', fp)
                this.send_importable_list()
            })
        
        setTimeout(this.start_servers.bind(this), 5000)
        
        this.front_end.on('connection', (socket) => {
            const userid = require('userid')

            const ip_address = socket.request.connection.remoteAddress
            const username = socket.request.user.username

            this.OWNER_CREDS = {
                uid: userid.uid(username),
                gid: userid.gids(username)[0]
            }

            this.send_user_list = function() {
                const passwd = require('etc-passwd')
                const users = []
                const groups = []

                passwd.getUsers()
                    .on('user', (user_data) => {
                        if (user_data.username == username) {
                            users.push({
                                username: user_data.username,
                                uid: user_data.uid,
                                gid: user_data.gid,
                                home: user_data.home
                            })
                        }
                    })
                    .on('end', () => {
                        socket.emit('user_list', users)
                    })

                passwd.getGroups()
                    .on('group', (group_data) => {
                        if (group_data.users.indexOf(username) >= 0 || group_data.gid == userid.gids(username)[0]) {
                            if (group_data.gid > 0) {
                                groups.push({
                                    groupname: group_data.groupname,
                                    gid: group_data.gid
                                })
                            }
                        }
                    })
                    .on('end', () => {
                        socket.emit('group_list', groups)
                    })
            }

            logging.info('[WEBUI] {0} connected from {1}'.format(username, ip_address))
            socket.emit('whoami', username)
            socket.emit('commit_msg', this.commit_msg)
            socket.emit('change_locale', (user_config || {})['webui_locale'])
            socket.emit('optional_columns', (user_config || {})['optional_columns'])

            for (const server_name of Object.keys(this.servers)) {
                socket.emit('track_server', server_name)
            }

            socket.on('command', this.webui_dispatcher.bind(this))
            this.send_user_list()
            this.send_profile_list(true)
            this.send_spigot_list()
            this.send_importable_list()
            this.send_locale_list()

        })
    }
    
    start_servers() {
        const MS_TO_PAUSE = 10000

        async.eachLimit(
            Object.keys(this.servers),
            1,
            (server_name, callback) => {
                this.servers[server_name].onreboot_start((err) => {
                    if (err) {
                        logging.error('[{0}] Aborted server startup; condition not met:'.format(server_name), err)
                    } else {
                        logging.info('[{0}] Server started. Waiting {1} ms...'.format(server_name, MS_TO_PAUSE))
                    }

                    setTimeout(callback, (err ? 1 : MS_TO_PAUSE))
                })
            }, () => 0)
    }


    shutdown() {
        for (const running_server of Object.values(this.servers)) {
            running_server.cleanup()
        }
    }

    send_profile_list(send_existing) {
        //if requesting to just send what you already have AND they are already present
        if (send_existing && this.profiles.length) {
            this.front_end.emit('profile_list', this.profiles)
        } else {
            const request = require('request')
            const profile_dir = path.join(this.base_dir, mineos.DIRS['profiles'])
            const SIMULTANEOUS_DOWNLOADS = 3
            let SOURCES = []
            let profiles = []

            try {
                SOURCES = require('./profiles.js')['profile_manifests']
            } catch (e) {
                logging.error('Unable to parse profiles.js--no profiles loaded!')
                logging.error(e)
                return // just bail out if profiles.js cannot be required for syntax issues
            }

            async.forEachOfLimit(
                SOURCES,
                SIMULTANEOUS_DOWNLOADS,
                (collection, key, outer_cb) => {
                    if ('request_args' in collection) {
                        async.waterfall([
                            async.apply(request, collection.request_args),
                            function(response, body, cb) {
                                cb(response.statusCode != 200, body)
                            },
                            function(body, cb) {
                                collection.handler(profile_dir, body, cb)
                            }
                        ], (err, output) => {
                            if (err || typeof output == 'undefined') {
                                logging.error("Unable to retrieve profile: {0}. The definition for this profile may be improperly formed or is pointing to an invalid URI.".format(key))
                            } else {
                                logging.info("Downloaded information for collection: {0} ({1} entries)".format(collection.name, output.length))
                                profiles = profiles.concat(output)
                            }
                            outer_cb()
                        }) //end waterfall
                    } else { //for profiles like paperspigot which are hardcoded
                        async.waterfall([
                            function(cb) {
                                collection.handler(profile_dir, cb)
                            }
                        ], (err, output) => {
                            if (err || typeof output == 'undefined') {
                                logging.error("Unable to retrieve profile: {0}. The definition for this profile may be improperly formed or is pointing to an invalid URI.".format(key))
                            } else {
                                logging.info("Downloaded information for collection: {0} ({1} entries)".format(collection.name, output.length))
                                profiles = profiles.concat(output)
                            }
                            outer_cb()
                        }) //end waterfall
                    }
                },
                () => {
                    this.profiles = profiles
                    this.front_end.emit('profile_list', this.profiles)
                }
            ) //end forEachOfLimit
        }
    }

    send_spigot_list() {
        const profiles_dir = path.join(this.base_dir, mineos.DIRS['profiles'])
        const spigot_profiles = {}

        async.waterfall([
            async.apply(fs.readdir, profiles_dir),
            (listing, cb) => {
                for (const i in listing) {
                    const match = listing[i].match(/(paper)?spigot_([\d\.]+)/)
                    if (match) {
                        spigot_profiles[match[0]] = {
                            'directory': match[0],
                            'jarfiles': fs.readdirSync(path.join(profiles_dir, match[0])).filter((a) => {
                                return a.match(/.+\.jar/i) 
                            })
                        }
                    }
                }
                cb()
            }
        ], () => this.front_end.emit('spigot_list', spigot_profiles))
    }

    send_locale_list() {
        async.waterfall([
            async.apply(fs.readdir, path.join(__dirname, 'html', 'locales')),
            function (locale_paths, cb) {
                const locales = locale_paths.map((r) => {
                    return r.match(/^locale-([a-z]{2}_[A-Z]{2}).json$/)[1]
                })
                cb(null, locales)
            }
        ], (err, output) => {
            logging.info(output)
            if (!err) {
                this.front_end.emit('locale_list', output)
            } else {
                this.front_end.emit('locale_list', ['en_US'])
            }
        })
    }
    
    download_profiles(args) {
        for (const idx in this.profiles) {
            if (this.profiles[idx].id == args.profile.id) {
                const SOURCES = require('./profiles.js')['profile_manifests']
                const profile_dir = path.join(this.base_dir, 'profiles', args.profile.id)
                const dest_filepath = path.join(profile_dir, args.profile.filename)

                async.series([
                    async.apply(fs.ensureDir, profile_dir),
                    (cb) => {
                        const progress = require('request-progress')
                        const request = require('request')

                        progress(request(args.profile.url), { throttle: 250, delay: 100 })
                            .on('error', (err) => {
                                logging.error(err)
                            })
                            .on('progress', (state) => {
                                args.profile.progress = state
                                this.front_end.emit('file_progress', args.profile)
                            })
                            .on('complete', (response) => {
                                if (response.statusCode == 200) {
                                    logging.info('[WEBUI] Successfully downloaded {0} to {1}'.format(args.profile.url, dest_filepath))
                                } else {
                                    logging.error('[WEBUI] Server was unable to download file:', args.profile.url)
                                    logging.error('[WEBUI] Remote server returned status {0} with headers:'.format(response.statusCode), response.headers)
                                }
                                cb(response.statusCode != 200)
                            })
                            .pipe(fs.createWriteStream(dest_filepath))
                    },
                    (cb) => {
                        switch(path.extname(args.profile.filename).toLowerCase()) {
                        case '.jar':
                            cb()
                            break
                        case '.zip': {
                            const unzip = require('unzip')
                            fs.createReadStream(dest_filepath)
                                .pipe(unzip.Extract({ path: profile_dir })
                                    .on('close', () => {
                                        cb() 
                                    })
                                    .on('error', () => {
                                        //Unzip error occurred, falling back to adm-zip
                                        const admzip = require('adm-zip')
                                        const zip = new admzip(dest_filepath)
                                        zip.extractAllTo(profile_dir, true) //true => overwrite
                                        cb()
                                    })
                                )
                            break
                        }
                        default:
                            cb()
                            break
                        }
                    },
                    function(cb) {
                        if ('postdownload' in SOURCES[args.profile['group']]) {
                            SOURCES[args.profile['group']].postdownload(profile_dir, dest_filepath, cb)
                        } else {
                            cb()
                        }
                    }
                ], () => this.send_profile_list())
                break
            }
        }
    }

    webui_dispatcher (args) {
        logging.info('[WEBUI] Received emit command from {0}:{1}'.format(ip_address, username), args)
        switch (args.command) {
        case 'create': {
            const instance = new mineos.mc(args.server_name, this.base_dir)

            async.series([
                async.apply(instance.verify, '!exists'),
                function(cb) {
                    let whitelisted_creators = [username] //by default, accept create attempt by current user
                    if ( (user_config || {}).creators ) { //if creators key:value pair exists, use it
                        whitelisted_creators = user_config['creators'].split(',')
                        whitelisted_creators = whitelisted_creators.filter((e) => {
                            return e
                        }) //remove non-truthy entries like ''
                        whitelisted_creators = whitelisted_creators.map((e) => {
                            return e.trim()
                        }) //remove trailing and tailing whitespace

                        logging.info('Explicitly authorized server creators are:', whitelisted_creators)
                    }
                    cb(!(whitelisted_creators.indexOf(username) >= 0))
                },
                async.apply(instance.create, this.OWNER_CREDS),
                async.apply(instance.overlay_sp, args.properties),
            ], (err) => {
                if (!err) {
                    logging.info('[{0}] Server created in filesystem.'.format(args.server_name))
                } else {
                    logging.info('[{0}] Failed to create server in filesystem as user {1}.'.format(args.server_name, username))
                    logging.error(err)
                }
            })
            break
        }
        case 'create_unconventional_server': {
            const unconventional_instance = new mineos.mc(args.server_name, this.base_dir)

            async.series([
                async.apply(unconventional_instance.verify, '!exists'),
                async.apply(unconventional_instance.create_unconventional_server, this.OWNER_CREDS),
            ], (err) => {
                if (!err) {
                    logging.info('[{0}] Server (unconventional) created in filesystem.'.format(args.server_name))
                } else {
                    logging.error(err)
                }
            })
            break
        }
        case 'download':
            download_profiles(args)
            break
        case 'build_jar': {
            const which = require('which')
            const child_process = require('child_process')

            try {
                const profile_path = path.join(this.base_dir, mineos.DIRS['profiles'])
                const working_dir = path.join(profile_path, '{0}_{1}'.format(args.builder.group, args.version))
                const bt_path = path.join(profile_path, args.builder.id, args.builder.filename)
                const dest_path = path.join(working_dir, args.builder.filename)
                const params = { cwd: working_dir }

                async.series([
                    async.apply(fs.mkdir, working_dir),
                    async.apply(fs.copy, bt_path, dest_path),
                    (cb) => {
                        const binary = which.sync('java')
                        const proc = child_process.spawn(binary, ['-Xms512M', '-jar', dest_path, '--rev', args.version], params)

                        proc.stdout.on('data', (data) => {
                            this.front_end.emit('build_jar_output', data.toString())
                            //logging.log('stdout: ' + data);
                        })

                        logging.info('[WEBUI] BuildTools starting with arguments:', args)

                        proc.stderr.on('data', (data) => {
                            this.front_end.emit('build_jar_output', data.toString())
                            logging.error(`stderr: ${ data}`)
                        })

                        proc.on('close', (code) => {
                            cb(code)
                        })
                    }
                ], (err) => {
                    logging.info('[WEBUI] BuildTools jar compilation finished {0} in {1}'.format( (err ? 'unsuccessfully' : 'successfully'), working_dir))
                    logging.info('[WEBUI] Buildtools used: {0}'.format(dest_path))

                    const retval = {
                        'command': 'BuildTools jar compilation',
                        'success': true,
                        'help_text': ''
                    }

                    if (err) {
                        retval['success'] = false
                        retval['help_text'] = "Error {0} ({1}): {2}".format(err.errno, err.code, err.path)
                    }

                    this.front_end.emit('host_notice', retval)
                    this.send_spigot_list()
                })
                break
                
            } catch (e) {
                logging.error('[WEBUI] Could not build jar; insufficient/incorrect arguments provided:', args)
                logging.error(e)
                return
            }
        }
        case 'delete_build': {
            if (args.type != 'spigot') {
                logging.error('[WEBUI] Unknown type of craftbukkit server -- potential modified webui request?')
                return
            }
            const spigot_path = path.join(this.base_dir, mineos.DIRS['profiles'], `spigot_${ args.version}`)

            fs.remove(spigot_path, (err) => {
                const retval = {
                    'command': 'Delete BuildTools jar',
                    'success': true,
                    'help_text': ''
                }

                if (err) {
                    retval['success'] = false
                    retval['help_text'] = "Error {0}".format(err)
                }

                this.front_end.emit('host_notice', retval)
                this.send_spigot_list()
            })
            break
        }
        case 'copy_to_server': {
            const rsync = require('rsync')

            if (args.type != 'spigot') {
                logging.error('[WEBUI] Unknown type of craftbukkit server -- potential modified webui request?')
                return
            }
            const spigot_path = `${path.join(this.base_dir, mineos.DIRS['profiles'], `spigot_${ args.version}`) }/` //`this comment fixes my syntax highlighting
                    
            const dest_path = `${path.join(this.base_dir, mineos.DIRS['servers'], args.server_name) }/`

            const obj = rsync.build({
                source: spigot_path,
                destination: dest_path,
                flags: 'au',
                shell:'ssh'
            })

            obj.set('--include', '*.jar')
            obj.set('--exclude', '*')
            obj.set('--prune-empty-dirs')
            obj.set('--chown', '{0}:{1}'.format(this.OWNER_CREDS.uid, this.OWNER_CREDS.gid))

            obj.execute((error, code) => {
                const retval = {
                    'command': 'BuildTools jar copy',
                    'success': true,
                    'help_text': ''
                }

                if (error) {
                    retval['success'] = false
                    retval['help_text'] = "Error {0} ({1})".format(error, code)
                }

                this.front_end.emit('host_notice', retval)
                for (const s of Object.keys(this.servers)) {
                    this.front_end.emit('track_server', s)
                }
            })

            break
        }
        case 'refresh_server_list':
            for (const s of Object.keys(this.servers)) {
                this.front_end.emit('track_server', s)
            }
            break
        case 'refresh_profile_list':
            this.send_profile_list()
            this.send_spigot_list()
            break
        case 'create_from_archive': {
            const archive_instance = new mineos.mc(args.new_server_name, this.base_dir)

            const filepath = args.awd_dir ?
                path.join(archive_instance.env.base_dir, mineos.DIRS['archive'], args.awd_dir, args.filename)
                : path.join(archive_instance.env.base_dir, mineos.DIRS['import'], args.filename)

            async.series([
                async.apply(archive_instance.verify, '!exists'),
                async.apply(archive_instance.create_from_archive, this.OWNER_CREDS, filepath)
            ], (err) => {
                if (!err) {
                    logging.info('[{0}] Server created in filesystem.'.format(args.new_server_name))
                    setTimeout(() => {
                        this.front_end.emit('track_server', args.new_server_name) 
                    }, 1000)
                } else {
                    logging.error(err)
                }
            })
            break
        }
        default:
            logging.warn('Command ignored: no such command {0}'.format(args.command))
            break
        }
    }

    send_importable_list() {
        const importable_archives = path.join(this.base_dir, mineos.DIRS['import'])
        const all_info = []

        fs.readdir(importable_archives, (err, files) => {
            if (!err) {
                const fullpath = files.map((value) => path.join(importable_archives, value))

                const stat = fs.stat
                async.map(fullpath, stat, (inner_err, results) => {
                    results.forEach((value, index) => {
                        all_info.push({
                            time: value.mtime,
                            size: value.size,
                            filename: files[index]
                        })
                    })

                    all_info.sort((a, b) => {
                        return a.time.getTime() - b.time.getTime()
                    })

                    this.front_end.emit('archive_list', all_info)
                })
            }
        })
    }
}
