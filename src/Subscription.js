import EventEmitter from 'eventemitter3'
import debugFactory from 'debug'
import uniqueId from 'lodash.uniqueid'

const DEFAULT_PROPAGATION_TIMEOUT = 5000
const DEFAULT_RESEND_TIMEOUT = 5000

/*
'interface' containing the default parameters and functionalities common to every subscription (Combined, RealTime and Historical)
 */
export default class Subscription extends EventEmitter {
    constructor({
        streamId,
        streamPartition,
        callback,
        propagationTimeout = DEFAULT_PROPAGATION_TIMEOUT,
        resendTimeout = DEFAULT_RESEND_TIMEOUT,
        debug
    }) {
        super()

        if (!callback) {
            throw new Error('No callback given!')
        }
        this.streamId = streamId
        this.streamPartition = streamPartition
        this.callback = callback
        const id = uniqueId('sub')
        this.id = id
        if (debug) {
            this.debug = debug.extend(this.constructor.name).extend(id)
        } else {
            this.debug = debugFactory(`StreamrClient::${this.constructor.name}`).extend(id)
        }

        if (!streamId) {
            throw new Error('No stream id given!')
        }
        this.propagationTimeout = propagationTimeout
        this.resendTimeout = resendTimeout
        this.state = Subscription.State.unsubscribed
    }

    async waitForSubscribed() {
        if (this._subscribedPromise) {
            return this._subscribedPromise
        }

        const subscribedPromise = new Promise((resolve, reject) => {
            if (this.state === Subscription.State.subscribed) {
                resolve()
                return
            }
            let onError
            const onSubscribed = () => {
                this.off('error', onError)
                resolve()
            }
            onError = (err) => {
                this.off('subscribed', onSubscribed)
                reject(err)
            }

            const onUnsubscribed = () => {
                if (this._subscribedPromise === subscribedPromise) {
                    this._subscribedPromise = undefined
                }
            }

            this.once('subscribed', onSubscribed)
            this.once('unsubscribed', onUnsubscribed)
            this.once('error', reject)
        }).then(() => this).finally(() => {
            if (this._subscribedPromise === subscribedPromise) {
                this._subscribedPromise = undefined
            }
        })

        this._subscribedPromise = subscribedPromise
        return this._subscribedPromise
    }

    emit(event, ...args) {
        this.debug('emit', event)
        return super.emit(event, ...args)
    }

    getState() {
        return this.state
    }

    setState(state) {
        this.debug(`Subscription: Stream ${this.streamId} state changed ${this.state} => ${state}`)
        this.state = state
        this.emit(state)
    }

    /* eslint-disable class-methods-use-this */
    onDisconnected() {
        throw new Error('Must be defined in child class')
    }
    /* eslint-enable class-methods-use-this */
}

Subscription.State = {
    unsubscribed: 'unsubscribed',
    subscribing: 'subscribing',
    subscribed: 'subscribed',
    unsubscribing: 'unsubscribing',
}
