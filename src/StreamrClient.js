import qs from 'qs'
import EventEmitter from 'eventemitter3'
import uniqueId from 'lodash.uniqueid'
import { Wallet } from 'ethers'
import { ControlLayer, MessageLayer } from 'streamr-client-protocol'
import Debug from 'debug'

import { getVersionString } from './utils'
import { iteratorFinally } from './utils/iterators'
import Connection from './Connection'
import Session from './Session'
import Publisher from './publish'
import Subscriber from './subscribe'

const { ControlMessage } = ControlLayer

const { StreamMessage } = MessageLayer

function emitterMixin(obj) {
    const emitter = new EventEmitter()
    return Object.assign(obj, {
        once: emitter.once.bind(emitter),
        emit: emitter.emit.bind(emitter),
        on: emitter.on.bind(emitter),
        off: emitter.off.bind(emitter),
        removeListener: emitter.removeListener.bind(emitter),
        addListener: emitter.addListener.bind(emitter),
        removeAllListeners: emitter.removeAllListeners.bind(emitter),
    })
}

export default class StreamrClient extends EventEmitter {
    constructor(options, connection) {
        super()
        this.id = uniqueId('StreamrClient')
        this.debug = Debug(this.id)
        // Default options
        this.options = {
            debug: this.debug,
            // The server to connect to
            url: 'wss://streamr.network/api/v1/ws',
            restUrl: 'https://streamr.network/api/v1',
            // Automatically connect on first subscribe
            autoConnect: true,
            // Automatically disconnect on last unsubscribe
            autoDisconnect: true,
            orderMessages: true,
            auth: {},
            publishWithSignature: 'auto',
            verifySignatures: 'auto',
            retryResendAfter: 5000,
            gapFillTimeout: 5000,
            maxPublishQueueSize: 10000,
            streamrNodeAddress: '0xf3E5A65851C3779f468c9EcB32E6f25D9D68601a',
            streamrOperatorAddress: '0xc0aa4dC0763550161a6B59fa430361b5a26df28C',
            tokenAddress: '0x0Cf0Ee63788A0849fE5297F3407f701E122cC023',
        }

        Object.assign(this.options, options || {})

        const parts = this.options.url.split('?')
        if (parts.length === 1) { // there is no query string
            const controlLayer = `controlLayerVersion=${ControlMessage.LATEST_VERSION}`
            const messageLayer = `messageLayerVersion=${StreamMessage.LATEST_VERSION}`
            this.options.url = `${this.options.url}?${controlLayer}&${messageLayer}`
        } else {
            const queryObj = qs.parse(parts[1])
            if (!queryObj.controlLayerVersion) {
                this.options.url = `${this.options.url}&controlLayerVersion=1`
            }

            if (!queryObj.messageLayerVersion) {
                this.options.url = `${this.options.url}&messageLayerVersion=31`
            }
        }

        // always add streamrClient version
        this.options.url = `${this.options.url}&streamrClient=${getVersionString()}`

        // Backwards compatibility for option 'authKey' => 'apiKey'
        if (this.options.authKey && !this.options.apiKey) {
            this.options.apiKey = this.options.authKey
        }

        if (this.options.apiKey) {
            this.options.auth.apiKey = this.options.apiKey
        }

        if (this.options.auth.privateKey && !this.options.auth.privateKey.startsWith('0x')) {
            this.options.auth.privateKey = `0x${this.options.auth.privateKey}`
        }

        // bind event handlers
        this.getUserInfo = this.getUserInfo.bind(this)
        this.onConnectionConnected = this.onConnectionConnected.bind(this)
        this.onConnectionDisconnected = this.onConnectionDisconnected.bind(this)
        this._onError = this._onError.bind(this)
        this.onConnectionError = this.onConnectionError.bind(this)
        this.getErrorEmitter = this.getErrorEmitter.bind(this)
        this.onConnectionMessage = this.onConnectionMessage.bind(this)

        this.on('error', this._onError) // attach before creating sub-components incase they fire error events

        this.session = new Session(this, this.options.auth)
        this.connection = connection || new Connection(this.options)

        this.connection
            .on('message', this.onConnectionMessage)
            .on('connected', this.onConnectionConnected)
            .on('disconnected', this.onConnectionDisconnected)
            .on('error', this.onConnectionError)

        this.publisher = new Publisher(this)
        this.subscriber = new Subscriber(this)
    }

    onConnectionMessage(messageEvent) {
        if (!this.connection.isConnected()) { return } // ignore messages if not connected
        let controlMessage
        try {
            controlMessage = ControlLayer.ControlMessage.deserialize(messageEvent.data)
        } catch (err) {
            this.connection.debug('<< %o', messageEvent && messageEvent.data)
            this.debug('deserialize error', err)
            this.emit('error', err)
            return
        }

        this.connection.debug('<< %o', controlMessage)
        this.connection.emit(controlMessage.type, controlMessage)
    }

    async onConnectionConnected() {
        this.debug('Connected!')
        this.emit('connected')
    }

    async onConnectionDisconnected() {
        this.debug('Disconnected.')
        this.emit('disconnected')
    }

    onConnectionError(err) {
        this.emit('error', new Connection.ConnectionError(err))
    }

    getErrorEmitter(source) {
        return (err) => {
            if (!(err instanceof Connection.ConnectionError || err.reason instanceof Connection.ConnectionError)) {
                // emit non-connection errors
                this.emit('error', err)
            } else {
                source.debug(err)
            }
        }
    }

    _onError(err, ...args) {
        this.onError(err, ...args)
    }

    async send(request) {
        return this.connection.send(request)
    }

    /**
     * Override to control output
     */

    onError(error) { // eslint-disable-line class-methods-use-this
        console.error(error)
    }

    isConnected() {
        return this.connection.isConnected()
    }

    isConnecting() {
        return this.connection.isConnecting()
    }

    isDisconnecting() {
        return this.connection.isDisconnecting()
    }

    isDisconnected() {
        return this.connection.isDisconnected()
    }

    async connect() {
        return this.connection.connect()
    }

    async nextConnection() {
        return this.connection.nextConnection()
    }

    pause() {
        return this.connection.disconnect()
    }

    disconnect() {
        this.publisher.stop()
        return this.connection.disconnect()
    }

    getSubscriptions(...args) {
        return this.subscriber.getAll(...args)
    }

    getSubscription(...args) {
        return this.subscriber.get(...args)
    }

    async ensureConnected() {
        return this.connect()
    }

    async ensureDisconnected() {
        return this.disconnect()
    }

    logout() {
        return this.session.logout()
    }

    async publish(...args) {
        return this.publisher.publish(...args)
    }

    getPublisherId() {
        return this.publisher.getPublisherId()
    }

    async subscribe(opts, onMessage) {
        let subTask
        let sub
        const hasResend = !!(opts.resend || opts.from || opts.to || opts.last)
        const onEnd = () => {
            if (sub && typeof onMessage === 'function') {
                sub.off('message', onMessage)
            }
        }

        if (hasResend) {
            subTask = this.subscriber.resendSubscribe(opts, onEnd)
        } else {
            subTask = this.subscriber.subscribe(opts, onEnd)
        }

        if (typeof onMessage === 'function') {
            Promise.resolve(subTask).then(async (s) => {
                sub = s
                sub.on('message', onMessage)
                for await (const msg of sub) {
                    sub.emit('message', msg.getParsedContent(), msg)
                }
                return sub
            }).catch((err) => {
                this.emit('error', err)
            })
        }
        return subTask
    }

    async unsubscribe(opts) {
        await this.subscriber.unsubscribe(opts)
    }

    async resend(opts, fn) {
        const task = this.subscriber.resend(opts)
        if (!fn) {
            return task
        }

        Promise.resolve(task).then(async (sub) => {
            sub.emit('resending')
            for await (const msg of sub) {
                await fn(msg.getParsedContent(), msg)
            }

            sub.emit('resent')
            return sub
        }).catch((err) => {
            this.emit('error', err)
        })

        return task
    }

    enableAutoConnect(...args) {
        return this.connection.enableAutoConnect(...args)
    }

    enableAutoDisonnect(...args) {
        return this.connection.enableAutoDisconnect(...args)
    }

    static generateEthereumAccount() {
        const wallet = Wallet.createRandom()
        return {
            address: wallet.address,
            privateKey: wallet.privateKey,
        }
    }
}
