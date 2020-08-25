import EventEmitter from 'eventemitter3'
import debugFactory from 'debug'
import uniqueId from 'lodash.uniqueid'
import WebSocket from 'ws'

/**
 * Wraps WebSocket open/close with promise methods
 * adds events
 * handles simultaneous calls to open/close
 * waits for pending close/open before continuing
 */

export default class SocketConnection extends EventEmitter {
    constructor(options) {
        super()
        this.options = options
        this.options.autoConnect = !!this.options.autoConnect
        this.options.maxRetries = this.options.maxRetries != null ? this.options.maxRetries : 10
        this.options.retryBackoffFactor = this.options.retryBackoffFactor != null ? this.options.retryBackoffFactor : 1.2
        this.options.maxRetryWait = this.options.maxRetryWait != null ? this.options.maxRetryWait : 10000
        this.shouldConnect = false
        this.retryCount = 1
        this._isReconnecting = false
        const id = uniqueId('SocketConnection')
        /* istanbul ignore next */
        if (options.debug) {
            this.debug = options.debug.extend(id)
        } else {
            this.debug = debugFactory(`StreamrClient::${id}`)
        }
    }

    async backoffWait() {
        return new Promise((resolve) => {
            const timeout = Math.min(
                this.options.maxRetryWait, // max wait time
                Math.round((this.retryCount * 10) ** this.options.retryBackoffFactor)
            )
            this.debug('waiting %sms', timeout)
            setTimeout(resolve, timeout)
        })
    }

    emit(event, ...args) {
        if (event === 'error') {
            return super.emit(event, ...args)
        }

        // note if event handler is async and it rejects we're kinda hosed
        // until node lands unhandledrejection support
        // in eventemitter
        try {
            return super.emit(event, ...args)
        } catch (err) {
            super.emit('error', err)
            return true
        }
    }

    async reconnect(...args) {
        await this.reconnectTask
        this.reconnectTask = (async () => {
            // closed, noop
            if (!this.shouldConnect) {
                this._isReconnecting = false
                return Promise.resolve()
            }
            this._isReconnecting = true
            // wait for a moment
            await this.backoffWait()

            // re-check if closed or closing
            if (!this.shouldConnect) {
                this._isReconnecting = false
                return Promise.resolve()
            }

            return this._connect(...args).then((value) => {
                // reset retry state
                this.reconnectTask = undefined
                this.retryCount = 1
                this._isReconnecting = false
                return value
            }, (err) => {
                this.debug('attempt to reconnect %s of %s failed', this.retryCount, this.options.maxRetries, err)
                this.reconnectTask = undefined
                this.retryCount += 1
                if (this.retryCount > this.options.maxRetries) {
                    // no more retries
                    this._isReconnecting = false
                    throw err
                }
                // try again
                this.debug('attempting to reconnect %s of %s', this.retryCount, this.options.maxRetries)
                this.emit('reconnecting')
                return this.reconnect()
            })
        })()
        return this.reconnectTask
    }

    async connect() {
        this.shouldConnect = true
        return this._connect()
    }

    async _connect() {
        return new Promise((resolve, reject) => {
            try {
                if (!this.shouldConnect) {
                    reject(new Error('disconnected before connected'))
                    return
                }
                let { socket } = this
                const isNew = !socket

                // create new socket
                if (!socket) {
                    if (!this.options.url) {
                        throw new Error('URL is not defined!')
                    }
                    socket = new WebSocket(this.options.url)
                    socket.binaryType = 'arraybuffer'
                    this.socket = socket
                }
                socket.addEventListener('close', () => {
                    if (!this.shouldConnect) {
                        return // expected close
                    }

                    // try reconnect on close if should be connected
                    this.reconnect().then(resolve).catch((error) => {
                        this.debug('failed reconnect', error)
                        this.emit('error', error)
                        reject(error)
                    })
                })

                socket.addEventListener('open', () => {
                    if (this.shouldConnect) {
                        resolve() // expected open
                        return
                    }

                    // was disconnected while connecting
                    reject(new Error('disconnected before connected'))
                })

                socket.addEventListener('error', (err) => {
                    const error = err.error || new Error(err)
                    reject(error)
                })

                if (socket.readyState === WebSocket.OPEN) {
                    resolve()
                }

                if (isNew) {
                    /// convert WebSocket events to emitter events
                    this.emit('connecting')
                    socket.addEventListener('message', (...args) => {
                        if (this.socket !== socket) { return }
                        this.emit('message', ...args)
                    })
                    socket.addEventListener('open', (event) => {
                        if (this.socket !== socket) { return }
                        this.emit('connected', event)
                    })
                    socket.addEventListener('close', (event) => {
                        if (this.socket === socket) {
                            this.socket = undefined
                            this.emit('disconnected', event)
                        }
                    })
                    socket.addEventListener('error', (err) => {
                        if (this.socket !== socket) { return }
                        const error = err.error || new Error(err)
                        this.emit('error', error)
                    })
                }
            } catch (err) {
                reject(err)
            }
        })
    }

    async disconnect() {
        this.shouldConnect = false
        return this._disconnect()
    }

    async _disconnect() {
        return new Promise((resolve, reject) => {
            try {
                if (this.shouldConnect) {
                    reject(new Error('connected before disconnected'))
                    return
                }

                const { socket } = this
                if (!socket || socket.readyState === WebSocket.CLOSED) {
                    resolve()
                    return
                }

                socket.addEventListener('open', () => {
                    if (!this.shouldConnect) {
                        resolve(this._disconnect())
                    }
                })

                socket.addEventListener('error', (err) => {
                    const error = err.error || new Error(err)
                    reject(error)
                })
                socket.addEventListener('close', () => {
                    if (this.shouldConnect) {
                        reject(new Error('connected before disconnected'))
                        return
                    }
                    resolve()
                })

                if (socket.readyState === WebSocket.OPEN) {
                    this.emit('disconnecting')
                    socket.close()
                }
            } catch (err) {
                reject(err)
            }
        })
    }

    async send(msg) {
        if (this.options.autoConnect || this.shouldConnect) {
            // should be open, so wait for open or trigger new open
            await this.connect()
        }

        if (!this.shouldConnect || !this.socket) {
            throw new Error('connection closed or closing')
        }

        return new Promise((resolve, reject) => {
            // promisify send
            this.socket.send(msg, (err) => {
                /* istanbul ignore next */
                if (err) {
                    reject(err)
                    return
                }
                resolve(msg)
            })
            // send callback doesn't exist with browser websockets, just resolve
            /* istanbul ignore next */
            if (process.isBrowser) {
                resolve(msg)
            }
        })
    }

    isReconnecting() {
        return this._isReconnecting
    }

    isConnected() {
        if (!this.socket) {
            return false
        }

        return this.socket.readyState === WebSocket.OPEN
    }

    isDisconnected() {
        if (!this.socket) {
            return true
        }

        return this.socket.readyState === WebSocket.CLOSED
    }

    isDisconnecting() {
        if (!this.socket) {
            return false
        }
        return this.socket.readyState === WebSocket.CLOSING
    }

    isConnecting() {
        if (!this.socket) {
            return false
        }
        return this.socket.readyState === WebSocket.CONNECTING
    }
}
