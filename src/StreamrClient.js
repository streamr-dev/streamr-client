import EventEmitter from 'eventemitter3'
import debugFactory from 'debug'
import { ControlLayer, Errors } from 'streamr-client-protocol'

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
} = ControlLayer
const debug = debugFactory('StreamrClient')

import Subscription from './Subscription'
import Connection from './Connection'
import Session from './Session'
import Signer from './Signer'
import InvalidSignatureError from './errors/InvalidSignatureError'
import SubscribedStream from './SubscribedStream'
import Publisher from './Publisher'

export default class StreamrClient extends EventEmitter {
    constructor(options, connection) {
        super()

        // Default options
        this.options = {
            // The server to connect to
            url: 'wss://www.streamr.com/api/v1/ws?controlLayerVersion=0&messageLayerVersion=29',
            restUrl: 'https://www.streamr.com/api/v1',
            // Automatically connect on first subscribe
            autoConnect: true,
            // Automatically disconnect on last unsubscribe
            autoDisconnect: true,
            auth: {},
            publishWithSignature: 'auto',
            verifySignatures: 'auto',
        }
        this.subscribedStreams = {}

        Object.assign(this.options, options || {})

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

        this.session = new Session(this, this.options.auth)
        this.signer = Signer.createSigner(this.options.auth, this.options.publishWithSignature)
        this.publisher = new Publisher(this)
        // Event handling on connection object
        this.connection = connection || new Connection(this.options)

        // Broadcast messages to all subs listening on stream
        this.connection.on(BroadcastMessage.TYPE, async (msg) => {
            const stream = this.subscribedStreams[msg.streamMessage.getStreamId()]
            if (stream) {
                const valid = await stream.verifyStreamMessage(msg.streamMessage)
                if (valid) {
                    // Notify the Subscriptions for this stream. If this is not the message each individual Subscription
                    // is expecting, they will either ignore it or request resend via gap event.
                    stream.getSubscriptions().forEach((sub) => sub.handleMessage(msg.streamMessage, false))
                } else {
                    const error = new InvalidSignatureError(msg.streamMessage)
                    stream.getSubscriptions().forEach((sub) => sub.handleError(error))
                }
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
                    const valid = await stream.verifyStreamMessage(msg.streamMessage)
                    if (valid) {
                        sub.handleMessage(msg.streamMessage, true)
                    } else {
                        sub.handleError(new InvalidSignatureError(msg.streamMessage))
                    }
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
                stream.getSubscription(response.subId).emit('resending', [response.streamId, response.streamPartition, response.subId])
            } else {
                debug('resent: Subscription %s is gone already', response.subId)
            }
        })

        this.connection.on(ResendResponseNoResend.TYPE, (response) => {
            const stream = this.subscribedStreams[response.streamId]
            if (stream && stream.getSubscription(response.subId)) {
                stream.getSubscription(response.subId).emit('no_resend', [response.streamId, response.streamPartition, response.subId])
            } else {
                debug('resent: Subscription %s is gone already', response.subId)
            }
        })

        this.connection.on(ResendResponseResent.TYPE, (response) => {
            const stream = this.subscribedStreams[response.streamId]
            if (stream && stream.getSubscription(response.subId)) {
                stream.getSubscription(response.subId).emit('resent', [response.streamId, response.streamPartition, response.subId])
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
            this.publisher.sendPendingPublishRequests()
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
            console.error(errorObject.message)
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
                const errorObject = err instanceof Error ? err : new Error(err)
                this.emit('error', errorObject)
                console.error(errorObject.message)
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

    async publish(streamObjectOrId, data, timestamp = Date.now()) {
        return this.publisher.publish(streamObjectOrId, data, timestamp)
    }

    subscribe(optionsOrStreamId, callback, legacyOptions) {
        if (!optionsOrStreamId) {
            throw new Error('subscribe: Invalid arguments: subscription options is required!')
        } else if (!callback) {
            throw new Error('subscribe: Invalid arguments: callback is required!')
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
            throw new Error(`subscribe: options must be an object! Given: ${optionsOrStreamId}`)
        }

        // Backwards compatibility for giving an options object as third argument
        Object.assign(options, legacyOptions)

        if (!options.stream) {
            throw new Error('subscribe: Invalid arguments: options.stream is not given')
        }

        // Create the Subscription object and bind handlers
        const sub = new Subscription(options.stream, options.partition || 0, callback, options)
        sub.on('gap', (from, to) => {
            if (!sub.resending) {
                this._requestResend(sub, {
                    resend_from: from, resend_to: to,
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
        if (this.connection.state === Connection.State.CONNECTED) {
            this._resendAndSubscribe(sub)
        } else if (this.options.autoConnect) {
            this.connect().catch(() => {}) // ignore
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

    reconnect() {
        return this.connect()
    }

    connect() {
        if (this.isConnected()) {
            return Promise.reject(new Error('Already connected!'))
        } else if (this.connection.state === Connection.State.CONNECTING) {
            return Promise.reject(new Error('Already connecting!'))
        }

        debug('Connecting to %s', this.options.url)
        return this.connection.connect()
    }

    pause() {
        return this.connection.disconnect()
    }

    disconnect() {
        this.subscribedStreams = {}
        return this.connection.disconnect()
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
            sub.once('subscribed', () => {
                if (sub.hasResendOptions()) {
                    this._requestResend(sub)
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

    _requestResend(sub, resendOptions) {
        sub.setResending(true)
        const options = resendOptions || sub.getEffectiveResendOptions()
        return this.session.getSessionToken().then((sessionToken) => {
            let request
            if (options.resend_last > 0) {
                request = ResendLastRequest.create(sub.streamId, sub.streamPartition, sub.id, options.resend_last, sessionToken)
            } else if (options.resend_from && !options.resend_to) {
                request = ResendFromRequest.create(
                    sub.streamId, sub.streamPartition, sub.id, options.resend_from,
                    options.resend_publisher || null, sessionToken,
                )
            } else if (options.resend_from && options.resend_to) {
                request = ResendRangeRequest.create(
                    sub.streamId, sub.streamPartition, sub.id, options.resend_from,
                    options.resend_to, options.resend_publisher || null, sessionToken,
                )
            }
            debug('_requestResend: %o', request)
            this.connection.send(request)
        })
    }

    handleError(msg) {
        debug(msg)
        this.emit('error', msg)
    }
}
