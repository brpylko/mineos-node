const async = require('async')
const auth = exports

auth.authenticate_shadow = function(user, plaintext, callback) {
    const hash = require('sha512crypt-node')
    const fs = require('fs-extra')

    function etc_shadow(inner_callback) {
    // return true if error, false if auth failed, string for user if successful
        const passwd = require('etc-passwd')

        fs.stat('/etc/shadow', (err, stat_info) => {
            if (err) {
                inner_callback(true)
            } else {
                passwd.getShadow({username: user}, (err, shadow_info) => {
                    if (shadow_info && shadow_info.password == '!') {
                        inner_callback(false)
                    } else if (shadow_info) {
                        const password_parts = shadow_info['password'].split(/\$/)
                        const salt = password_parts[2]
                        const new_hash = hash.sha512crypt(plaintext, salt)

                        const passed = (new_hash == shadow_info['password'] ? user : false)
                        inner_callback(passed)
                    } else {
                        inner_callback(true)
                    }
                })
            }
        })
    }

    function posix(inner_callback) {
    // return true if error, false if auth failed, string for user if successful
        try {
            var crypt = require('apache-crypt')
            var posix = require('posix')
        } catch (e) {
            inner_callback(true)
            return
        }

        try {
            const user_data = posix.getpwnam(user)
            if (crypt(plaintext, user_data.passwd) == user_data.passwd) {
                inner_callback(user)
            } else if (user_data) {
                // the crypt hash method fails on FreeNAS so try the sha512
                const password_parts = user_data.passwd.split(/\$/)
                const salt = password_parts[2]
                const new_hash = hash.sha512crypt(plaintext, salt)

                const passed = (new_hash == user_data.passwd ? user : false)
                inner_callback(passed)
	  } else {
                inner_callback(false)
            }
        } catch (e) {
            inner_callback(true)
        }
    }

    function pam(inner_callback) {
    // return true if error, false if auth failed, string for user if successful
        try {
            var pam = require('authenticate-pam')
        } catch (e) {
            inner_callback(true)
            return
        }

        pam.authenticate(user, plaintext, (err) => {
            if (err) {
                inner_callback(false)
            } else {
                inner_callback(user)
            }
        })
    }

    pam((pam_passed) => {
    //due to the stack of different auths, a false if auth failed is largely ignored
        if (typeof pam_passed == 'string') {
            callback(pam_passed)
        } else {
            etc_shadow((etc_passed) => {
                if (typeof etc_passed == 'string') {
                    callback(etc_passed)
                } else {
                    posix((posix_passed) => {
                        if (typeof posix_passed == 'string') {
                            callback(posix_passed)
                        } else {
                            callback(false)
                        }
                    })
                }
            })
        }
    })
}

auth.test_membership = function(username, group, callback) {
    const passwd = require('etc-passwd')
    const userid = require('userid')

    let membership_valid = false
    const gg = passwd.getGroups()
        .on('group', (group_data) => {
            if (group == group_data.groupname) {
                try {
                    if (group_data.users.indexOf(username) >= 0 || group_data.gid == userid.gids(username)[0]) {
                        membership_valid = true
                    }
                } catch (e) {}
            }
        })
        .on('end', () => {
            callback(membership_valid)
        })
}

auth.verify_ids = function(uid, gid, callback) {
    const passwd = require('etc-passwd')

    let uid_present = false
    let gid_present = false

    async.series([
        function(cb) {
            const gg = passwd.getUsers()
                .on('user', (user_data) => {
                    if (user_data.uid == uid) {
                        uid_present = true
                    }
                })
                .on('end', () => {
                    if (!uid_present) {
                        cb(`UID ${ uid } does not exist on this system`)
                    } else {
                        cb()
                    }
                })
        },
        function(cb) {
            const gg = passwd.getGroups()
                .on('group', (group_data) => {
                    if (group_data.gid == gid) {
                        gid_present = true
                    }
                })
                .on('end', () => {
                    if (!gid_present) {
                        cb(`GID ${ gid } does not exist on this system`)
                    } else {
                        cb()
                    }
                })
        }
    ], callback)
}
