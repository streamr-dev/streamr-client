import { MessageLayer } from 'streamr-client-protocol'

import AbstractSubscription from './AbstractSubscription'
import DecryptionKeySequence from './DecryptionKeySequence'

const { StreamMessage } = MessageLayer

export default class HistoricalSubscription extends AbstractSubscription {
    constructor(streamId, streamPartition, callback, options, groupKeys, propagationTimeout, resendTimeout, orderMessages = true) {
        super(streamId, streamPartition, callback, groupKeys, propagationTimeout, resendTimeout, orderMessages)
        this.resendOptions = options
        if (!this.resendOptions || (!this.resendOptions.from && !this.resendOptions.last)) {
            throw new Error('Resend options (either "from", "from" and "to", or "last") must be defined in a historical subscription.')
        }

        if (this.resendOptions.from != null && this.resendOptions.last != null) {
            throw new Error(`Multiple resend options active! Please use only one: ${JSON.stringify(this.resendOptions)}`)
        }

        if (this.resendOptions.msgChainId != null && typeof this.resendOptions.publisherId === 'undefined') {
            throw new Error('publisherId must be defined as well if msgChainId is defined.')
        }

        if (this.resendOptions.from == null && this.resendOptions.to != null) {
            throw new Error('"from" must be defined as well if "to" is defined.')
        }
        this.keySequences = {}
        Object.keys(this.groupKeys).forEach((publisherId) => {
            this.keySequences[publisherId] = new DecryptionKeySequence([this.groupKeys[publisherId]])
        })
    }

    _decryptOrRequestGroupKey(msg) {
        if (msg.encryptionType !== StreamMessage.ENCRYPTION_TYPES.AES && msg.encryptionType !== StreamMessage.ENCRYPTION_TYPES.NEW_KEY_AND_AES) {
            return true
        }

        if (!this.keySequences[msg.getPublisherId()]) {
            const start = msg.getTimestamp()
            const end = this.resendOptions.to ? this.resendOptions.to : Date.now()
            this.emit('groupKeyMissing', msg.getPublisherId(), start, end)
            this.waitingForGroupKey[msg.getPublisherId()] = true
            this.encryptedMsgsQueue.push(msg)
            return false
        }
        this.keySequences[msg.getPublisherId()].tryToDecryptResent(msg)
        return true
    }

    async handleBroadcastMessage(msg, verifyFn) {
        await AbstractSubscription.validate(msg, verifyFn)
        this.emit('message received', msg)
    }

    /* eslint-disable class-methods-use-this */
    hasResendOptions() {
        return true
    }

    isResending() {
        return true
    }

    setResending() {}
    /* eslint-enable class-methods-use-this */

    getResendOptions() {
        return this.resendOptions
    }

    setGroupKeys(publisherId, groupKeys) {
        if (this.keySequences[publisherId]) {
            throw new Error(`Received historical group keys for publisher ${publisherId} for a second time.`)
        }
        this.keySequences[publisherId] = new DecryptionKeySequence(groupKeys)
        delete this.waitingForGroupKey[publisherId]
        this.encryptedMsgsQueue.forEach((msg) => this._inOrderHandler(msg))
        this.encryptedMsgsQueue = []
        if (this.resendDone) { // the messages in the queue were the last ones to handle
            this.emit('resend done')
        }
    }

    finishResend() {
        this._lastMessageHandlerPromise = null
        if (this.encryptedMsgsQueue.length > 0) { // received all historical messages but not yet the keys to decrypt them
            this.resendDone = true
        } else {
            this.emit('resend done')
        }
    }
}
