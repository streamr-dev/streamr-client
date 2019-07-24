import assert from 'assert'

import sinon from 'sinon'
import { MessageLayer } from 'streamr-client-protocol'
import shuffle from 'array-shuffle'

const { StreamMessage } = MessageLayer
import OrderedMsgChain from '../../src/OrderedMsgChain'

const createMsg = (
    timestamp = 1, sequenceNumber = 0, prevTimestamp = null,
    prevSequenceNumber = 0, content = {}, publisherId = 'publisherId', msgChainId = 'msgChainId',
) => {
    const prevMsgRef = prevTimestamp ? [prevTimestamp, prevSequenceNumber] : null
    return StreamMessage.create(
        ['streamId', 0, timestamp, sequenceNumber, publisherId, msgChainId], prevMsgRef,
        StreamMessage.CONTENT_TYPES.MESSAGE, StreamMessage.ENCRYPTION_TYPES.NONE, content, StreamMessage.SIGNATURE_TYPES.NONE,
    )
}

describe('OrderedMsgChain', () => {
    const msg1 = createMsg(1, 0)
    const msg2 = createMsg(2, 0, 1, 0)
    const msg3 = createMsg(3, 0, 2, 0)
    const msg4 = createMsg(4, 0, 3, 0)
    const msg5 = createMsg(5, 0, 4, 0)
    let util
    afterEach(() => {
        util.clearGap()
    })
    it('handles ordered messages in order', () => {
        const received = []
        util = new OrderedMsgChain('publisherId', 'msgChainId', (msg) => {
            received.push(msg)
        }, () => {
            throw new Error('Unexpected gap')
        })
        util.add(msg1)
        util.add(msg2)
        util.add(msg3)
        assert.deepStrictEqual(received, [msg1, msg2, msg3])
    })
    it('drops duplicates', () => {
        const received = []
        util = new OrderedMsgChain('publisherId', 'msgChainId', (msg) => {
            received.push(msg)
        }, () => {
            throw new Error('Unexpected gap')
        })
        util.add(msg1)
        util.add(msg1)
        util.add(msg2)
        util.add(msg1)
        assert.deepStrictEqual(received, [msg1, msg2])
    })
    it('calls the gap handler', (done) => {
        const received = []
        util = new OrderedMsgChain('publisherId', 'msgChainId', (msg) => {
            received.push(msg)
        }, (from, to, publisherId, msgChainId) => {
            assert.deepStrictEqual(received, [msg1, msg2])
            assert.strictEqual(from.timestamp, msg2.getMessageRef().timestamp)
            assert.strictEqual(from.sequenceNumber, msg2.getMessageRef().sequenceNumber + 1)
            assert.deepStrictEqual(to, msg5.prevMsgRef)
            assert.strictEqual(publisherId, 'publisherId')
            assert.strictEqual(msgChainId, 'msgChainId')
            clearInterval(util.gap)
            done()
        }, 50)
        util.add(msg1)
        util.add(msg2)
        util.add(msg5)
    })
    it('handles unordered messages in order', () => {
        const received = []
        util = new OrderedMsgChain('publisherId', 'msgChainId', (msg) => {
            received.push(msg)
        }, () => {})
        util.add(msg1)
        util.add(msg2)
        util.add(msg5)
        util.add(msg3)
        util.add(msg4)
        assert.deepStrictEqual(received, [msg1, msg2, msg3, msg4, msg5])
    })
    it('does not call the gap handler (scheduled but resolved before timeout)', () => {
        const received = []
        util = new OrderedMsgChain('publisherId', 'msgChainId', (msg) => {
            received.push(msg)
        }, () => {
            throw new Error('Unexpected gap')
        }, 10000)
        util.add(msg1)
        util.add(msg5)
        util.add(msg4)
        util.add(msg3)
        util.add(msg2)
        assert.deepStrictEqual(received, [msg1, msg2, msg3, msg4, msg5])
    })
    it('call the gap handler MAX_GAP_REQUESTS times and then throws', (done) => {
        const clock = sinon.useFakeTimers()
        let counter = 0
        try {
            util = new OrderedMsgChain('publisherId', 'msgChainId', () => {}, (from, to, publisherId, msgChainId) => {
                assert.strictEqual(from.timestamp, msg1.getMessageRef().timestamp)
                assert.strictEqual(from.sequenceNumber, msg1.getMessageRef().sequenceNumber + 1)
                assert.deepStrictEqual(to, msg3.prevMsgRef)
                assert.strictEqual(publisherId, 'publisherId')
                assert.strictEqual(msgChainId, 'msgChainId')
                counter += 1
                clock.tick(5000)
            }, 5000)
            util.add(msg1)
            util.add(msg3)
            clock.tick(5000)
        } catch (e) {
            assert.strictEqual(e.message, 'Failed to fill gap between [1,1] and [2,0] for publisherId-msgChainId'
                + ` after ${OrderedMsgChain.MAX_GAP_REQUESTS} trials`)
            assert.strictEqual(counter, OrderedMsgChain.MAX_GAP_REQUESTS)
            clock.restore()
            done()
        }
    })
    it('handles unordered messages in order (large randomized test)', () => {
        const expected = [msg1]
        let i
        for (i = 2; i <= 1000; i++) {
            expected.push(createMsg(i, 0, i - 1, 0))
        }
        const shuffled = shuffle(expected)
        const received = []
        util = new OrderedMsgChain('publisherId', 'msgChainId', (msg) => {
            received.push(msg)
        }, () => {}, 50)
        util.add(msg1)
        shuffled.forEach((msg) => {
            if (msg.getTimestamp() !== msg1.getTimestamp()) {
                util.add(msg)
            }
        })
        assert.deepStrictEqual(received, expected)
    })
})
