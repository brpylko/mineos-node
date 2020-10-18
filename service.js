#!/usr/bin/env node

const daemon = require("daemonize2").setup({
    main: "webui.js",
    name: "mineos",
    pidfile: "/var/run/mineos.pid"
})

if (process.getuid() != 0) {
    console.log("Expected to run as root")
    process.exit(1)
}

const actions = {
    start: daemon.start.bind(daemon),
    stop: daemon.stop.bind(daemon),
    restart: daemon.stop.bind(daemon, daemon.start.bind(daemon)),
    status: () => {
        const pid = daemon.status()
        if (pid) {
            console.log(`MineOS running. PID: ${pid}`)
        } else {
            console.log("MineOS is not running.")
        }
    }
}

if (process.argv[2] in actions) {
    actions[process.argv[2]]()
} else {
    console.log("Usage: [start|stop|restart|status]")
}
