import EventEmitter from 'eventemitter3'
import debugFactory from 'debug'
import qs from 'qs'
import once from 'once'
import { ControlLayer, MessageLayer, Errors } from 'streamr-client-protocol'

const {
    BroadcastMessage,
    UnicastMessage,
    SubscribeRequest,
    SubscribeResponse,
    UnsubscribeRequest,
    UnsubscribeResponse,
    ResendResponseResending,
    ResendResponseNoResend,
    ResendResponseResent,
    ResendLastRequest,
    ResendFromRequest,
    ResendRangeRequest,
    ErrorResponse,
    ControlMessage,
} = ControlLayer
const { StreamMessage } = MessageLayer
const debug = debugFactory('StreamrClient')

import HistoricalSubscription from './HistoricalSubscription'
import Connection from './Connection'
import Session from './Session'
import Signer from './Signer'
import SubscribedStream from './SubscribedStream'
import Stream from './rest/domain/Stream'
import FailedToPublishError from './errors/FailedToPublishError'
import MessageCreationUtil from './MessageCreationUtil'
import { waitFor } from './utils'
import RealTimeSubscription from './RealTimeSubscription'
import CombinedSubscription from './CombinedSubscription'
import Subscription from './Subscription'

export default class StreamrClient extends EventEmitter {
    constructor(options, connection) {
        super()

        // Default options
        this.options = {
            // The server to connect to
            url: 'wss://www.streamr.com/api/v1/ws',
            restUrl: 'https://www.streamr.com/api/v1',
            // Automatically connect on first subscribe
            autoConnect: true,
            // Automatically disconnect on last unsubscribe
            autoDisconnect: true,
            auth: {},
            publishWithSignature: 'auto',
            verifySignatures: 'auto',
            retryResendAfter: 5000,
            gapFillTimeout: 5000,
            maxPublishQueueSize: 10000,
            publisherGroupKeys: {}, // {streamId: groupKey}
            subscriberGroupKeys: {}, // {streamId: {publisherId: groupKey}}
        }
        this.subscribedStreams = {}

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

        this.publishQueue = []
        this.session = new Session(this, this.options.auth)
        this.signer = Signer.createSigner(this.options.auth, this.options.publishWithSignature)
        // Event handling on connection object
        this.connection = connection || new Connection(this.options)

        if (this.session.isUnauthenticated()) {
            this.msgCreationUtil = null
        } else {
            this.msgCreationUtil = new MessageCreationUtil(
                this.options.auth, this.signer, this.getUserInfo()
                    .catch((err) => this.emit('error', err)),
                (streamId) => this.getStream(streamId)
                    .catch((err) => this.emit('error', err)), this.options.publisherGroupKeys,
            )
        }

        this.on('error', (error) => {
            console.error(error)
            this.ensureDisconnected()
        })

        // Broadcast messages to all subs listening on stream
        this.connection.on(BroadcastMessage.TYPE, (msg) => {
            const stream = this.subscribedStreams[msg.streamMessage.getStreamId()]
            if (stream) {
                const verifyFn = once(() => stream.verifyStreamMessage(msg.streamMessage)) // ensure verification occurs only once
                // sub.handleBroadcastMessage never rejects: on any error it emits an 'error' event on the Subscription
                stream.getSubscriptions().forEach((sub) => sub.handleBroadcastMessage(msg.streamMessage, verifyFn))
            } else {
                debug('WARN: message received for stream with no subscriptions: %s', msg.streamMessage.getStreamId())
            }
        })

        // Unicast messages to a specific subscription only
        this.connection.on(UnicastMessage.TYPE, async (msg) => {
            const stream = this.subscribedStreams[msg.streamMessage.getStreamId()]
            if (stream) {
                const sub = stream.getSubscription(msg.subId)
                if (sub) {
                    // sub.handleResentMessage never rejects: on any error it emits an 'error' event on the Subscription
                    sub.handleResentMessage(
                        msg.streamMessage,
                        once(() => stream.verifyStreamMessage(msg.streamMessage)), // ensure verification occurs only once
                    )
                } else {
                    debug('WARN: subscription not found for stream: %s, sub: %s', msg.streamMessage.getStreamId(), msg.subId)
                }
            } else {
                debug('WARN: message received for stream with no subscriptions: %s', msg.streamMessage.getStreamId())
            }
        })

        this.connection.on(SubscribeResponse.TYPE, (response) => {
            const stream = this.subscribedStreams[response.streamId]
            if (stream) {
                stream.setSubscribing(false)
                stream.getSubscriptions().filter((sub) => !sub.resending)
                    .forEach((sub) => sub.setState(Subscription.State.subscribed))
            }
            debug('Client subscribed: streamId: %s, streamPartition: %s', response.streamId, response.streamPartition)
        })

        this.connection.on(UnsubscribeResponse.TYPE, (response) => {
            debug('Client unsubscribed: streamId: %s, streamPartition: %s', response.streamId, response.streamPartition)
            const stream = this.subscribedStreams[response.streamId]
            if (stream) {
                stream.getSubscriptions().forEach((sub) => {
                    this._removeSubscription(sub)
                    sub.setState(Subscription.State.unsubscribed)
                })
            }

            this._checkAutoDisconnect()
        })

        // Route resending state messages to corresponding Subscriptions
        this.connection.on(ResendResponseResending.TYPE, (response) => {
            const stream = this.subscribedStreams[response.streamId]
            if (stream && stream.getSubscription(response.subId)) {
                stream.getSubscription(response.subId).handleResending(response)
            } else {
                debug('resent: Subscription %s is gone already', response.subId)
            }
        })

        this.connection.on(ResendResponseNoResend.TYPE, (response) => {
            const stream = this.subscribedStreams[response.streamId]
            if (stream && stream.getSubscription(response.subId)) {
                stream.getSubscription(response.subId).handleNoResend(response)
            } else {
                debug('resent: Subscription %s is gone already', response.subId)
            }
        })

        this.connection.on(ResendResponseResent.TYPE, (response) => {
            const stream = this.subscribedStreams[response.streamId]
            if (stream && stream.getSubscription(response.subId)) {
                stream.getSubscription(response.subId).handleResent(response)
            } else {
                debug('resent: Subscription %s is gone already', response.subId)
            }
        })

        // On connect/reconnect, send pending subscription requests
        this.connection.on('connected', () => {
            debug('Connected!')
            this.emit('connected')

            // Check pending subscriptions
            Object.keys(this.subscribedStreams)
                .forEach((streamId) => {
                    this.subscribedStreams[streamId].getSubscriptions().forEach((sub) => {
                        if (sub.getState() !== Subscription.State.subscribed) {
                            this._resendAndSubscribe(sub)
                        }
                    })
                })

            // Check pending publish requests
            const publishQueueCopy = this.publishQueue.slice(0)
            this.publishQueue = []
            publishQueueCopy.forEach((publishFn) => publishFn())
        })

        this.connection.on('disconnected', () => {
            debug('Disconnected.')
            this.emit('disconnected')

            Object.keys(this.subscribedStreams)
                .forEach((streamId) => {
                    const stream = this.subscribedStreams[streamId]
                    stream.setSubscribing(false)
                    stream.getSubscriptions().forEach((sub) => {
                        sub.setState(Subscription.State.unsubscribed)
                    })
                })
        })

        this.connection.on(ErrorResponse.TYPE, (err) => {
            const errorObject = new Error(err.errorMessage)
            this.emit('error', errorObject)
            console.error(errorObject)
        })

        this.connection.on('error', (err) => {
            // If there is an error parsing a json message in a stream, fire error events on the relevant subs
            if (err instanceof Errors.InvalidJsonError) {
                const stream = this.subscribedStreams[err.streamId]
                if (stream) {
                    stream.getSubscriptions().forEach((sub) => sub.handleError(err))
                } else {
                    debug('WARN: InvalidJsonError received for stream with no subscriptions: %s', err.streamId)
                }
            } else {
                // if it looks like an error emit as-is, otherwise wrap in new Error
                const errorObject = (err && err.stack && err.message) ? err : new Error(err)
                this.emit('error', errorObject)
                console.error(errorObject)
            }
        })
    }

    _addSubscription(sub) {
        if (!this.subscribedStreams[sub.streamId]) {
            this.subscribedStreams[sub.streamId] = new SubscribedStream(this, sub.streamId)
        }
        this.subscribedStreams[sub.streamId].addSubscription(sub)
    }

    _removeSubscription(sub) {
        const stream = this.subscribedStreams[sub.streamId]
        if (stream) {
            stream.removeSubscription(sub)
            if (stream.getSubscriptions().length === 0) {
                delete this.subscribedStreams[sub.streamId]
            }
        }
    }

    getSubscriptions(streamId) {
        const stream = this.subscribedStreams[streamId]
        return stream ? stream.getSubscriptions() : []
    }

    async publish(streamObjectOrId, data, timestamp = Date.now(), partitionKey = null, groupKey) {
        if (this.session.isUnauthenticated()) {
            throw new Error('Need to be authenticated to publish.')
        }
        // Validate streamObjectOrId
        let streamId
        if (streamObjectOrId instanceof Stream) {
            streamId = streamObjectOrId.id
        } else if (typeof streamObjectOrId === 'string') {
            streamId = streamObjectOrId
        } else {
            throw new Error(`First argument must be a Stream object or the stream id! Was: ${streamObjectOrId}`)
        }

        const [sessionToken, streamMessage] = await Promise.all([
            this.session.getSessionToken(),
            this.msgCreationUtil.createStreamMessage(streamObjectOrId, data, timestamp, partitionKey, groupKey),
        ])

        if (this.isConnected()) {
            // If connected, emit a publish request
            return this._requestPublish(streamMessage, sessionToken)
        }

        if (this.options.autoConnect) {
            if (this.publishQueue.length >= this.options.maxPublishQueueSize) {
                throw new FailedToPublishError(
                    streamId,
                    data,
                    `publishQueue exceeded maxPublishQueueSize=${this.options.maxPublishQueueSize}`,
                )
            }

            const published = new Promise((resolve, reject) => {
                this.publishQueue.push(async () => {
                    let publishRequest
                    try {
                        publishRequest = await this._requestPublish(streamMessage, sessionToken)
                    } catch (err) {
                        debug(`Error: ${err}`)
                        this.emit('error', err)
                        reject(err)
                        return
                    }
                    resolve(publishRequest)
                })
            })
            // be sure to trigger connection *after* queueing publish
            await this.ensureConnected() // await to ensure connection error fails publish
            return published
        }

        throw new FailedToPublishError(
            streamId,
            data,
            'Wait for the "connected" event before calling publish, or set autoConnect to true!',
        )
    }

    async resend(optionsOrStreamId, callback) {
        const options = this._validateParameters(optionsOrStreamId, callback)

        if (!options.stream) {
            throw new Error('subscribe: Invalid arguments: options.stream is not given')
        }

        await this.ensureConnected()

        const sub = new HistoricalSubscription(options.stream, options.partition || 0, callback, options.resend)

        // TODO remove _addSubscription after uncoupling Subscription and Resend
        this._addSubscription(sub)
        await this._requestResend(sub)

        return sub
    }

    // eslint-disable-next-line class-methods-use-this
    _validateParameters(optionsOrStreamId, callback) {
        if (!optionsOrStreamId) {
            throw new Error('subscribe/resend: Invalid arguments: options is required!')
        } else if (!callback) {
            throw new Error('subscribe/resend: Invalid arguments: callback is required!')
        }

        // Backwards compatibility for giving a streamId as first argument
        let options
        if (typeof optionsOrStreamId === 'string') {
            options = {
                stream: optionsOrStreamId,
            }
        } else if (typeof optionsOrStreamId === 'object') {
            options = optionsOrStreamId
        } else {
            throw new Error(`subscribe/resend: options must be an object! Given: ${optionsOrStreamId}`)
        }

        return options
    }

    subscribe(optionsOrStreamId, callback, legacyOptions) {
        const options = this._validateParameters(optionsOrStreamId, callback)

        // Backwards compatibility for giving an options object as third argument
        Object.assign(options, legacyOptions)

        if (!options.stream) {
            throw new Error('subscribe: Invalid arguments: options.stream is not given')
        }

        if (options.groupKeys) {
            this.options.subscriberGroupKeys[options.stream] = options.groupKeys
        }

        // Create the Subscription object and bind handlers
        let sub
        if (options.resend) {
            sub = new CombinedSubscription(
                options.stream, options.partition || 0, callback, options.resend,
                this.options.subscriberGroupKeys[options.stream], this.options.gapFillTimeout, this.options.retryResendAfter,
            )
        } else {
            sub = new RealTimeSubscription(options.stream, options.partition || 0, callback,
                this.options.subscriberGroupKeys[options.stream], this.options.gapFillTimeout, this.options.retryResendAfter)
        }
        sub.on('gap', (from, to, publisherId, msgChainId) => {
            if (!sub.resending) {
                this._requestResend(sub, {
                    from, to, publisherId, msgChainId,
                })
            }
        })
        sub.on('done', () => {
            debug('done event for sub %d', sub.id)
            this.unsubscribe(sub)
        })

        // Add to lookups
        this._addSubscription(sub)

        // If connected, emit a subscribe request
        if (this.isConnected()) {
            this._resendAndSubscribe(sub)
        } else if (this.options.autoConnect) {
            this.ensureConnected()
        }

        return sub
    }

    unsubscribe(sub) {
        if (!sub || !sub.streamId) {
            throw new Error('unsubscribe: please give a Subscription object as an argument!')
        }

        // If this is the last subscription for this stream, unsubscribe the client too
        if (this.subscribedStreams[sub.streamId] !== undefined && this.subscribedStreams[sub.streamId].getSubscriptions().length === 1
            && this.isConnected()
            && sub.getState() === Subscription.State.subscribed) {
            sub.setState(Subscription.State.unsubscribing)
            this._requestUnsubscribe(sub.streamId)
        } else if (sub.getState() !== Subscription.State.unsubscribing && sub.getState() !== Subscription.State.unsubscribed) {
            // Else the sub can be cleaned off immediately
            this._removeSubscription(sub)
            sub.setState(Subscription.State.unsubscribed)
            this._checkAutoDisconnect()
        }
    }

    unsubscribeAll(streamId) {
        if (!streamId) {
            throw new Error('unsubscribeAll: a stream id is required!')
        } else if (typeof streamId !== 'string') {
            throw new Error('unsubscribe: stream id must be a string!')
        }

        const stream = this.subscribedStreams[streamId]
        if (stream) {
            stream.getSubscriptions().forEach((sub) => {
                this.unsubscribe(sub)
            })
        }
    }

    isConnected() {
        return this.connection.state === Connection.State.CONNECTED
    }

    isConnecting() {
        return this.connection.state === Connection.State.CONNECTING
    }

    isDisconnecting() {
        return this.connection.state === Connection.State.DISCONNECTING
    }

    isDisconnected() {
        return this.connection.state === Connection.State.DISCONNECTED
    }

    reconnect() {
        return this.connect()
    }

    connect() {
        if (this.isConnected()) {
            return Promise.reject(new Error('Already connected!'))
        }

        if (this.connection.state === Connection.State.CONNECTING) {
            return Promise.reject(new Error('Already connecting!'))
        }

        debug('Connecting to %s', this.options.url)
        return this.connection.connect()
    }

    pause() {
        return this.connection.disconnect()
    }

    disconnect() {
        if (this.msgCreationUtil) {
            this.msgCreationUtil.stop()
        }

        this.subscribedStreams = {}
        return this.connection.disconnect()
    }

    logout() {
        return this.session.logout()
    }

    getPublisherId() {
        return this.msgCreationUtil.getPublisherId()
    }

    /**
     * Starts new connection if disconnected.
     * Waits for connection if connecting.
     * No-op if already connected.
     */

    async ensureConnected() {
        if (this.isConnected()) { return Promise.resolve() }

        if (this.isConnecting()) {
            return waitFor(this, 'connected')
        }
        return this.connect()
    }

    /**
     * Starts disconnection if connected.
     * Waits for disconnection if disconnecting.
     * No-op if already disconnected.
     */

    async ensureDisconnected() {
        if (this.isDisconnected()) { return Promise.resolve() }

        if (this.isDisconnecting()) {
            return waitFor(this, 'disconnected')
        }
        return this.disconnect()
    }

    _checkAutoDisconnect() {
        // Disconnect if no longer subscribed to any streams
        if (this.options.autoDisconnect && Object.keys(this.subscribedStreams).length === 0) {
            debug('Disconnecting due to no longer being subscribed to any streams')
            this.disconnect()
        }
    }

    _resendAndSubscribe(sub) {
        if (sub.getState() !== Subscription.State.subscribing && !sub.resending) {
            sub.setState(Subscription.State.subscribing)
            this._requestSubscribe(sub)

            // Once subscribed, ask for a resend
            sub.once('subscribed', async () => {
                if (sub.hasResendOptions()) {
                    await this._requestResend(sub)
                    // the requested messages might not have been stored yet, so retry if no answer after 'retryResendAfter' seconds
                    const secondResend = setTimeout(() => this._requestResend(sub), this.options.retryResendAfter)
                    // once a message is received, gap filling in Subscription.js will check if this satisfies the resend and request
                    // another resend if it doesn't. So we can anyway clear this resend request.
                    const handler = () => {
                        clearTimeout(secondResend)
                        sub.removeListener('message received', handler)
                        sub.removeListener('unsubscribed', handler)
                        sub.removeListener('error', handler)
                    }
                    sub.once('message received', handler)
                    sub.once('unsubscribed', handler)
                    sub.once('error', handler)
                }
            })
        }
    }

    _requestSubscribe(sub) {
        const stream = this.subscribedStreams[sub.streamId]
        const subscribedSubs = stream.getSubscriptions().filter((it) => it.getState() === Subscription.State.subscribed)

        return this.session.getSessionToken().then((sessionToken) => {
            // If this is the first subscription for this stream, send a subscription request to the server
            if (!stream.isSubscribing() && subscribedSubs.length === 0) {
                const request = SubscribeRequest.create(sub.streamId, undefined, sessionToken)
                debug('_requestSubscribe: subscribing client: %o', request)
                stream.setSubscribing(true)
                this.connection.send(request)
            } else if (subscribedSubs.length > 0) {
                // If there already is a subscribed subscription for this stream, this new one will just join it immediately
                debug('_requestSubscribe: another subscription for same stream: %s, insta-subscribing', sub.streamId)

                setTimeout(() => {
                    sub.setState(Subscription.State.subscribed)
                })
            }
        })
    }

    _requestUnsubscribe(streamId) {
        debug('Client unsubscribing stream %o', streamId)
        this.connection.send(UnsubscribeRequest.create(streamId))
    }

    async _requestResend(sub, resendOptions) {
        sub.setResending(true)
        const options = resendOptions || sub.getResendOptions()
        const sessionToken = await this.session.getSessionToken()
        // don't bother requesting resend if not connected
        if (!this.isConnected()) { return }
        let request
        if (options.last > 0) {
            request = ResendLastRequest.create(sub.streamId, sub.streamPartition, sub.id, options.last, sessionToken)
        } else if (options.from && !options.to) {
            request = ResendFromRequest.create(
                sub.streamId, sub.streamPartition, sub.id, [options.from.timestamp, options.from.sequenceNumber],
                options.publisherId || null, options.msgChainId || null, sessionToken,
            )
        } else if (options.from && options.to) {
            request = ResendRangeRequest.create(
                sub.streamId, sub.streamPartition, sub.id, [options.from.timestamp, options.from.sequenceNumber],
                [options.to.timestamp, options.to.sequenceNumber],
                options.publisherId || null, options.msgChainId || null, sessionToken,
            )
        }
        debug('_requestResend: %o', request)
        this.connection.send(request)
    }

    _requestPublish(streamMessage, sessionToken) {
        const request = ControlLayer.PublishRequest.create(streamMessage, sessionToken)
        debug('_requestPublish: %o', request)
        return this.connection.send(request)
    }

    handleError(msg) {
        debug(msg)
        this.emit('error', msg)
    }
}
