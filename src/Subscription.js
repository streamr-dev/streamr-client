import EventEmitter from 'eventemitter3'
import debugFactory from 'debug'
import { Errors } from 'streamr-client-protocol'
import InvalidSignatureError from './errors/InvalidSignatureError'
import VerificationFailedError from './errors/VerificationFailedError'

const debug = debugFactory('StreamrClient::Subscription')

let subId = 0
function generateSubscriptionId() {
    const id = subId
    subId += 1
    return id.toString()
}

export default class Subscription extends EventEmitter {
    static get State() {
        return {
            unsubscribed: 'unsubscribed',
            subscribing: 'subscribing',
            subscribed: 'subscribed',
            unsubscribing: 'unsubscribing',
        }
    }

    constructor(streamId, streamPartition, callback, options) {
        super()

        if (!streamId) {
            throw new Error('No stream id given!')
        }
        if (!callback) {
            throw new Error('No callback given!')
        }

        this.id = generateSubscriptionId()
        this.streamId = streamId
        this.streamPartition = streamPartition
        this.callback = callback
        this.resendOptions = options || {}
        this.queue = []
        this.state = Subscription.State.unsubscribed
        this.resending = false
        this.lastReceivedMsgRef = {}

        if (this.resendOptions.from != null && this.resendOptions.last != null) {
            throw new Error(`Multiple resend options active! Please use only one: ${JSON.stringify(this.resendOptions)}`)
        }
        if (this.resendOptions.msgChainId != null && typeof this.resendOptions.publisherId === 'undefined') {
            throw new Error('publisherId must be defined as well if msgChainId is defined.')
        }
        if (this.resendOptions.from == null && this.resendOptions.to != null) {
            throw new Error('"from" must be defined as well if "to" is defined.')
        }

        /** * Message handlers ** */

        this.on('unsubscribed', () => {
            this.setResending(false)
        })

        this.on('disconnected', () => {
            this.setState(Subscription.State.unsubscribed)
            this.setResending(false)
        })
    }

    /**
     * Gap check: If the msg contains the previousMsgRef, and we know the lastReceivedMsgRef,
     * and the previousMsgRef is larger than what has been received, we have a gap!
     */
    checkForGap(previousMsgRef, key) {
        return previousMsgRef != null &&
            this.lastReceivedMsgRef[key] !== undefined &&
            previousMsgRef.compareTo(this.lastReceivedMsgRef[key]) === 1
    }

    async _catchAndEmitErrors(fn) {
        try {
            return await fn()
        } catch (err) {
            console.error(err)
            this.emit('error', err)
            // Swallow rejection
            return Promise.resolve()
        }
    }

    // All the handle* methods should:
    // - return a promise for consistency
    // - swallow exceptions and emit them as 'error' events

    async handleBroadcastMessage(msg, verifyFn) {
        return this._catchAndEmitErrors(() => this._handleMessage(msg, verifyFn, false))
    }

    async handleResentMessage(msg, verifyFn) {
        return this._catchAndEmitErrors(() => {
            if (!this.resending) {
                throw new Error(`There is no resend in progress, but received resent message ${msg.serialize()}`)
            } else {
                const handleMessagePromise = this._handleMessage(msg, verifyFn, true)
                this._lastMessageHandlerPromise = handleMessagePromise
                return handleMessagePromise
            }
        })
    }

    async handleResending(response) {
        return this._catchAndEmitErrors(() => {
            if (!this.resending) {
                throw new Error(`There should be no resend in progress, but received ResendResponseResending message ${response.serialize()}`)
            }
            this.emit('resending', response)
        })
    }

    async handleResent(response) {
        return this._catchAndEmitErrors(async () => {
            if (!this.resending) {
                throw new Error(`There should be no resend in progress, but received ResendResponseResent message ${response.serialize()}`)
            }
            if (!this._lastMessageHandlerPromise) {
                throw new Error('Attempting to handle ResendResponseResent, but no messages have been received!')
            }

            // Delay event emission until the last message in the resend has been handled
            await this._lastMessageHandlerPromise.then(async () => {
                try {
                    this.emit('resent', response)
                } finally {
                    await this._finishResend()
                }
            })
        })

    }

    async handleNoResend(response) {
        return this._catchAndEmitErrors(async () => {
            if (!this.resending) {
                throw new Error(`There should be no resend in progress, but received ResendResponseNoResend message ${response.serialize()}`)
            }
            try {
                this.emit('no_resend', response)
            } finally {
                await this._finishResend()
            }
        })
    }

    async _finishResend() {
        this._lastMessageHandlerPromise = null
        this.setResending(false)
        await this.checkQueue()
    }

    async _handleMessage(msg, verifyFn, isResend = false) {
        if (msg.version !== 30) {
            throw new Error(`Can handle only StreamMessageV30, not version ${msg.version}`)
        }
        if (msg.prevMsgRef == null) {
            debug('handleMessage: prevOffset is null, gap detection is impossible! message: %o', msg)
        }

        // Make sure the verification is successful before proceeding
        let valid
        try {
            valid = await verifyFn()
        } catch (cause) {
            throw new VerificationFailedError(msg, cause)
        }

        if (!valid) {
            throw new InvalidSignatureError(msg)
        }

        const key = msg.getPublisherId() + msg.messageId.msgChainId

        // TODO: check this.options.resend_last ?
        // If resending, queue broadcast messages
        if (this.resending && !isResend) {
            this.queue.push(msg)
        } else if (this.checkForGap(msg.prevMsgRef, key) && !this.resending) {
            // Queue the message to be processed after resend
            this.queue.push(msg)

            const from = this.lastReceivedMsgRef[key] // cannot know the first missing message so there will be a duplicate received
            const fromObject = {
                timestamp: from.timestamp,
                sequenceNumber: from.sequenceNumber,
            }
            const to = msg.prevMsgRef
            const toObject = {
                timestamp: to.timestamp,
                sequenceNumber: to.sequenceNumber,
            }
            debug('Gap detected, requesting resend for stream %s from %o to %o', this.streamId, from, to)
            this.emit('gap', fromObject, toObject, msg.getPublisherId(), msg.messageId.msgChainId)
        } else {
            const messageRef = msg.getMessageRef()
            let res
            if (this.lastReceivedMsgRef[key] !== undefined) {
                res = messageRef.compareTo(this.lastReceivedMsgRef[key])
            }
            if (res <= 0) {
                // Prevent double-processing of messages for any reason
                debug(
                    'Sub %s already received message: %o, lastReceivedMsgRef: %d. Ignoring message.', this.id, messageRef,
                    this.lastReceivedMsgRef[key],
                )
            } else {
                // Normal case where prevMsgRef == null || lastReceivedMsgRef == null || prevMsgRef === lastReceivedMsgRef
                this.lastReceivedMsgRef[key] = messageRef
                this.callback(msg.getParsedContent(), msg)
                if (msg.isByeMessage()) {
                    this.emit('done')
                }
            }
        }
    }

    async checkQueue() {
        if (this.queue.length) {
            debug('Attempting to process %d queued messages for stream %s', this.queue.length, this.streamId)

            const originalQueue = this.queue
            this.queue = []

            // Queued messages are already verified, so pass true as the verificationPromise
            const promises = originalQueue.map((msg) => this._handleMessage(msg, () => true, false))
            await Promise.all(promises)
        }
    }

    hasResendOptions() {
        return this.resendOptions.from || this.resendOptions.last > 0
    }

    /**
     * Resend needs can change if messages have already been received.
     * This function always returns the effective resend options:
     *
     * If messages have been received:
     * - 'from' option becomes 'from' option the latest received message
     * - 'last' option stays the same
     */
    getEffectiveResendOptions() {
        const key = this.resendOptions.publisherId + this.resendOptions.msgChainId
        if (this.hasReceivedMessagesFrom(key) && this.hasResendOptions()
            && (this.resendOptions.from)) {
            return {
                // cannot know the first missing message so there will be a duplicate received
                from: {
                    timestamp: this.lastReceivedMsgRef[key].timestamp,
                    sequenceNumber: this.lastReceivedMsgRef[key].sequenceNumber,
                },
                publisherId: this.resendOptions.publisherId,
                msgChainId: this.resendOptions.msgChainId,
            }
        }
        return this.resendOptions
    }

    hasReceivedMessagesFrom(key) {
        return this.lastReceivedMsgRef[key] !== undefined
    }

    getState() {
        return this.state
    }

    setState(state) {
        debug(`Subscription: Stream ${this.streamId} state changed ${this.state} => ${state}`)
        this.state = state
        this.emit(state)
    }

    isResending() {
        return this.resending
    }

    setResending(resending) {
        debug(`Subscription: Stream ${this.streamId} resending: ${resending}`)
        this.resending = resending
    }

    handleError(err) {
        /**
         * If parsing the (expected) message failed, we should still mark it as received. Otherwise the
         * gap detection will think a message was lost, and re-request the failing message.
         */
        let key
        if (err.streamMessage) {
            key = err.streamMessage.getPublisherId() + err.streamMessage.messageId.msgChainId
        }
        if (err instanceof Errors.InvalidJsonError && !this.checkForGap(err.streamMessage.prevMsgRef, key)) {
            this.lastReceivedMsgRef[key] = err.streamMessage.getMessageRef()
        }
        this.emit('error', err)
    }
}
