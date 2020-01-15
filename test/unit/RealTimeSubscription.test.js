import assert from 'assert'
import crypto from 'crypto'

import sinon from 'sinon'
import { ControlLayer, MessageLayer, Errors } from 'streamr-client-protocol'

import RealTimeSubscription from '../../src/RealTimeSubscription'
import InvalidSignatureError from '../../src/errors/InvalidSignatureError'
import VerificationFailedError from '../../src/errors/VerificationFailedError'
import EncryptionUtil from '../../src/EncryptionUtil'
import Subscription from '../../src/Subscription'

const { StreamMessage } = MessageLayer

const createMsg = (
    timestamp = 1, sequenceNumber = 0, prevTimestamp = null,
    prevSequenceNumber = 0, content = {}, publisherId = 'publisherId', msgChainId = '1',
    encryptionType = StreamMessage.ENCRYPTION_TYPES.NONE,
) => {
    const prevMsgRef = prevTimestamp ? [prevTimestamp, prevSequenceNumber] : null
    return StreamMessage.create(
        ['streamId', 0, timestamp, sequenceNumber, publisherId, msgChainId], prevMsgRef,
        StreamMessage.CONTENT_TYPES.MESSAGE, encryptionType, content, StreamMessage.SIGNATURE_TYPES.NONE,
    )
}

const msg = createMsg()

describe('RealTimeSubscription', () => {
    describe('message handling', () => {
        describe('handleBroadcastMessage()', () => {
            it('calls the message handler', () => {
                const sub = new RealTimeSubscription(msg.getStreamId(), msg.getStreamPartition(), (content, receivedMsg) => {
                    assert.deepEqual(content, msg.getParsedContent())
                    assert.equal(msg, receivedMsg)
                })
                return sub.handleBroadcastMessage(msg, sinon.stub().resolves(true))
            })

            describe('on error', () => {
                let stdError
                let sub

                beforeEach(() => {
                    sub = new RealTimeSubscription(msg.getStreamId(), msg.getStreamPartition(), sinon.stub().throws('should not be called!'))
                    stdError = console.error
                    console.error = sinon.stub()
                })

                afterEach(() => {
                    console.error = stdError
                    sub.stop()
                })

                describe('when message verification returns false', () => {
                    it('does not call the message handler', async () => sub.handleBroadcastMessage(msg, sinon.stub().resolves(false)))

                    it('prints to standard error stream', async () => {
                        await sub.handleBroadcastMessage(msg, sinon.stub().resolves(false))
                        assert(console.error.calledWith(sinon.match.instanceOf(InvalidSignatureError)))
                    })

                    it('emits an error event', async (done) => {
                        sub.on('error', (err) => {
                            assert(err instanceof InvalidSignatureError)
                            done()
                        })
                        return sub.handleBroadcastMessage(msg, sinon.stub().resolves(false))
                    })
                })

                describe('when message verification throws', () => {
                    it('emits an error event', async (done) => {
                        const error = new Error('test error')
                        sub.on('error', (err) => {
                            assert(err instanceof VerificationFailedError)
                            assert.strictEqual(err.cause, error)
                            done()
                        })
                        return sub.handleBroadcastMessage(msg, sinon.stub().throws(error))
                    })
                })

                describe('when message handler throws', () => {
                    it('emits an error event', async (done) => {
                        sub.on('error', (err) => {
                            assert.strictEqual(err.name, 'should not be called!')
                            done()
                        })
                        return sub.handleBroadcastMessage(msg, sinon.stub().resolves(true))
                    })

                    it('prints to standard error stream', async (done) => {
                        sub.on('error', (err) => {
                            assert.strictEqual(err.name, 'should not be called!')
                            done()
                        })
                        return sub.handleBroadcastMessage(msg, sinon.stub().resolves(true))
                    })
                })
            })

            it('calls the callback once for each message in order', () => {
                const msgs = [1, 2, 3, 4, 5].map((timestamp) => createMsg(
                    timestamp,
                    timestamp === 1 ? 0 : timestamp - 1,
                ))

                const received = []

                const sub = new RealTimeSubscription(msg.getStreamId(), msg.getStreamPartition(), (content, receivedMsg) => {
                    received.push(receivedMsg)
                    if (received.length === 5) {
                        assert.deepEqual(msgs, received)
                    }
                })

                return Promise.all(msgs.map((m) => sub.handleBroadcastMessage(m, sinon.stub().resolves(true))))
            })
        })

        describe('handleResentMessage()', () => {
            it('processes messages if resending is true', async () => {
                const handler = sinon.stub()
                const sub = new RealTimeSubscription(msg.getStreamId(), msg.getStreamPartition(), handler)

                sub.setResending(true)
                await sub.handleResentMessage(msg, sinon.stub().resolves(true))
                assert.equal(handler.callCount, 1)
            })

            describe('on error', () => {
                let stdError
                let sub

                beforeEach(() => {
                    sub = new RealTimeSubscription(msg.getStreamId(), msg.getStreamPartition(), sinon.stub()
                        .throws('should not be called!'))
                    sub.setResending(true)
                    stdError = console.error
                    console.error = sinon.stub()
                })

                afterEach(() => {
                    console.error = stdError
                    sub.stop()
                })

                describe('when message verification returns false', () => {
                    it('does not call the message handler', async () => sub.handleResentMessage(msg, sinon.stub()
                        .resolves(false)))

                    it('prints to standard error stream', async () => {
                        await sub.handleResentMessage(msg, sinon.stub()
                            .resolves(false))
                        assert(console.error.calledWith(sinon.match.instanceOf(InvalidSignatureError)))
                    })

                    it('emits an error event', async (done) => {
                        sub.on('error', (err) => {
                            assert(err instanceof InvalidSignatureError)
                            done()
                        })
                        return sub.handleResentMessage(msg, sinon.stub()
                            .resolves(false))
                    })
                })

                describe('when message verification throws', () => {
                    it('emits an error event', async (done) => {
                        const error = new Error('test error')
                        sub.on('error', (err) => {
                            assert(err instanceof VerificationFailedError)
                            assert.strictEqual(err.cause, error)
                            done()
                        })
                        return sub.handleResentMessage(msg, sinon.stub()
                            .throws(error))
                    })
                })

                describe('when message handler throws', () => {
                    it('emits an error event', async (done) => {
                        sub.on('error', (err) => {
                            assert.strictEqual(err.name, 'should not be called!')
                            done()
                        })
                        return sub.handleResentMessage(msg, sinon.stub()
                            .resolves(true))
                    })

                    it('prints to standard error stream', async (done) => {
                        sub.on('error', (err) => {
                            assert.strictEqual(err.name, 'should not be called!')
                            done()
                        })
                        return sub.handleResentMessage(msg, sinon.stub()
                            .resolves(true))
                    })
                })
            })
        })

        describe('duplicate handling', () => {
            it('ignores re-received messages', async () => {
                const handler = sinon.stub()
                const sub = new RealTimeSubscription(msg.getStreamId(), msg.getStreamPartition(), handler)

                await sub.handleBroadcastMessage(msg, sinon.stub().resolves(true))
                await sub.handleBroadcastMessage(msg, sinon.stub().resolves(true))
                assert.equal(handler.callCount, 1)
                sub.stop()
            })
            it('ignores re-received messages if they come from resend', async () => {
                const handler = sinon.stub()
                const sub = new RealTimeSubscription(msg.getStreamId(), msg.getStreamPartition(), handler)
                sub.setResending(true)

                await sub.handleBroadcastMessage(msg, sinon.stub().resolves(true))
                await sub.handleResentMessage(msg, sinon.stub().resolves(true))
                sub.stop()
            })
        })

        describe('gap detection', () => {
            it('emits "gap" if a gap is detected', (done) => {
                const msg1 = msg
                const msg4 = createMsg(4, undefined, 3)

                const sub = new RealTimeSubscription(msg.getStreamId(), msg.getStreamPartition(), sinon.stub(), {}, 100, 100)
                sub.on('gap', (from, to, publisherId) => {
                    assert.equal(from.timestamp, 1) // cannot know the first missing message so there will be a duplicate received
                    assert.equal(from.sequenceNumber, 1)
                    assert.equal(to.timestamp, 3)
                    assert.equal(to.sequenceNumber, 0)
                    assert.equal(publisherId, 'publisherId')
                    setTimeout(() => {
                        sub.stop()
                        done()
                    }, 100)
                })

                sub.handleBroadcastMessage(msg1, sinon.stub().resolves(true))
                sub.handleBroadcastMessage(msg4, sinon.stub().resolves(true))
            })

            it('emits second "gap" after the first one if no missing message is received in between', (done) => {
                const msg1 = msg
                const msg4 = createMsg(4, undefined, 3)

                const sub = new RealTimeSubscription(msg.getStreamId(), msg.getStreamPartition(), sinon.stub(), {}, 100, 100)
                sub.on('gap', (from, to, publisherId) => {
                    sub.on('gap', (from2, to2, publisherId2) => {
                        assert.deepStrictEqual(from, from2)
                        assert.deepStrictEqual(to, to2)
                        assert.deepStrictEqual(publisherId, publisherId2)
                        sub.stop()
                        done()
                    })
                })

                sub.handleBroadcastMessage(msg1, sinon.stub().resolves(true))
                sub.handleBroadcastMessage(msg4, sinon.stub().resolves(true))
            })

            it('does not emit second "gap" after the first one if the missing messages are received in between', (done) => {
                const msg1 = msg
                const msg2 = createMsg(2, undefined, 1)
                const msg3 = createMsg(3, undefined, 2)
                const msg4 = createMsg(4, undefined, 3)

                const sub = new RealTimeSubscription(msg.getStreamId(), msg.getStreamPartition(), sinon.stub(), {}, 100, 100)
                sub.on('gap', () => {
                    sub.handleBroadcastMessage(msg2, sinon.stub().resolves(true))
                    sub.handleBroadcastMessage(msg3, sinon.stub().resolves(true)).then(() => {
                    })
                    sub.on('gap', () => { throw new Error('should not emit second gap') })
                    setTimeout(() => {
                        sub.stop()
                        done()
                    }, 100 + 1000)
                })

                sub.handleBroadcastMessage(msg1, sinon.stub().resolves(true))
                sub.handleBroadcastMessage(msg4, sinon.stub().resolves(true))
            })

            it('does not emit second "gap" if gets unsubscribed', async (done) => {
                const msg1 = msg
                const msg4 = createMsg(4, undefined, 3)

                const sub = new RealTimeSubscription(msg.getStreamId(), msg.getStreamPartition(), sinon.stub(), {}, 100, 100)
                sub.once('gap', () => {
                    sub.emit('unsubscribed')
                    sub.on('gap', () => { throw new Error('should not emit second gap') })
                    setTimeout(() => {
                        sub.stop()
                        done()
                    }, 100 + 1000)
                })

                sub.handleBroadcastMessage(msg1, sinon.stub().resolves(true))
                sub.handleBroadcastMessage(msg4, sinon.stub().resolves(true))
            })

            it('does not emit second "gap" if gets disconnected', async (done) => {
                const msg1 = msg
                const msg4 = createMsg(4, undefined, 3)

                const sub = new RealTimeSubscription(msg.getStreamId(), msg.getStreamPartition(), sinon.stub(), {}, 100, 100)
                sub.once('gap', () => {
                    sub.emit('disconnected')
                    sub.on('gap', () => { throw new Error('should not emit second gap') })
                    setTimeout(() => {
                        sub.stop()
                        done()
                    }, 100 + 1000)
                })

                sub.handleBroadcastMessage(msg1, sinon.stub().resolves(true))
                sub.handleBroadcastMessage(msg4, sinon.stub().resolves(true))
            })

            it('does not emit "gap" if different publishers', () => {
                const msg1 = msg
                const msg1b = createMsg(1, 0, undefined, 0, {}, 'anotherPublisherId')

                const sub = new RealTimeSubscription(msg.getStreamId(), msg.getStreamPartition(), sinon.stub())
                sub.on('gap', () => {
                    throw new Error('unexpected gap')
                })

                sub.handleBroadcastMessage(msg1, sinon.stub().resolves(true))
                sub.handleBroadcastMessage(msg1b, sinon.stub().resolves(true))
            })

            it('emits "gap" if a gap is detected (same timestamp but different sequenceNumbers)', (done) => {
                const msg1 = msg
                const msg4 = createMsg(1, 4, 1, 3)

                const sub = new RealTimeSubscription(msg.getStreamId(), msg.getStreamPartition(), sinon.stub(), {}, 100, 100)
                sub.on('gap', (from, to, publisherId) => {
                    assert.equal(from.timestamp, 1) // cannot know the first missing message so there will be a duplicate received
                    assert.equal(from.sequenceNumber, 1)
                    assert.equal(to.timestamp, 1)
                    assert.equal(to.sequenceNumber, 3)
                    assert.equal(publisherId, 'publisherId')
                    setTimeout(() => {
                        sub.stop()
                        done()
                    }, 100)
                })

                sub.handleBroadcastMessage(msg1, sinon.stub().resolves(true))
                sub.handleBroadcastMessage(msg4, sinon.stub().resolves(true))
            })

            it('does not emit "gap" if a gap is not detected', () => {
                const msg1 = msg
                const msg2 = createMsg(2, undefined, 1)

                const sub = new RealTimeSubscription(msg.getStreamId(), msg.getStreamPartition(), sinon.stub())
                sub.on('gap', sinon.stub().throws())

                sub.handleBroadcastMessage(msg1, sinon.stub().resolves(true))
                sub.handleBroadcastMessage(msg2, sinon.stub().resolves(true))
            })

            it('does not emit "gap" if a gap is not detected (same timestamp but different sequenceNumbers)', () => {
                const msg1 = msg
                const msg2 = createMsg(1, 1, 1, 0)

                const sub = new RealTimeSubscription(msg.getStreamId(), msg.getStreamPartition(), sinon.stub())
                sub.on('gap', sinon.stub().throws())

                sub.handleBroadcastMessage(msg1, sinon.stub().resolves(true))
                sub.handleBroadcastMessage(msg2, sinon.stub().resolves(true))
            })
        })

        describe('ordering util', () => {
            it('handles messages in the order in which they arrive if no ordering util', async () => {
                const msg1 = msg
                const msg2 = createMsg(2, 0, 1, 0)
                const msg3 = createMsg(3, 0, 2, 0)
                const msg4 = createMsg(4, 0, 3, 0)
                const received = []

                const sub = new RealTimeSubscription(msg.getStreamId(), msg.getStreamPartition(), (content, receivedMsg) => {
                    received.push(receivedMsg)
                }, {}, 100, 100, false)
                sub.on('gap', sinon.stub().throws())

                await sub.handleBroadcastMessage(msg1, sinon.stub().resolves(true))
                await sub.handleBroadcastMessage(msg2, sinon.stub().resolves(true))
                await sub.handleBroadcastMessage(msg4, sinon.stub().resolves(true))
                await sub.handleBroadcastMessage(msg2, sinon.stub().resolves(true))
                await sub.handleBroadcastMessage(msg3, sinon.stub().resolves(true))
                await sub.handleBroadcastMessage(msg1, sinon.stub().resolves(true))

                assert.deepStrictEqual(received, [msg1, msg2, msg4, msg2, msg3, msg1])
            })
            it('handles messages in order without duplicates if ordering util is set', async () => {
                const msg1 = msg
                const msg2 = createMsg(2, 0, 1, 0)
                const msg3 = createMsg(3, 0, 2, 0)
                const msg4 = createMsg(4, 0, 3, 0)
                const received = []

                const sub = new RealTimeSubscription(msg.getStreamId(), msg.getStreamPartition(), (content, receivedMsg) => {
                    received.push(receivedMsg)
                })

                await sub.handleBroadcastMessage(msg1, sinon.stub().resolves(true))
                await sub.handleBroadcastMessage(msg2, sinon.stub().resolves(true))
                await sub.handleBroadcastMessage(msg4, sinon.stub().resolves(true))
                await sub.handleBroadcastMessage(msg2, sinon.stub().resolves(true))
                await sub.handleBroadcastMessage(msg3, sinon.stub().resolves(true))
                await sub.handleBroadcastMessage(msg1, sinon.stub().resolves(true))

                assert.deepStrictEqual(received, [msg1, msg2, msg3, msg4])
            })
        })

        it('emits done after processing a message with the bye key', (done) => {
            const byeMsg = createMsg(1, undefined, null, null, {
                _bye: true,
            })
            const handler = sinon.stub()
            const sub = new RealTimeSubscription(byeMsg.getStreamId(), byeMsg.getStreamPartition(), handler)
            sub.on('done', () => {
                assert(handler.calledOnce)
                done()
            })

            sub.handleBroadcastMessage(byeMsg, sinon.stub().resolves(true))
        })

        describe('decryption', () => {
            it('should read clear text content without trying to decrypt', (done) => {
                const msg1 = createMsg(1, 0, null, 0, {
                    foo: 'bar',
                })
                const sub = new RealTimeSubscription(msg1.getStreamId(), msg1.getStreamPartition(), (content) => {
                    assert.deepStrictEqual(content, msg1.getParsedContent())
                    done()
                })
                return sub.handleBroadcastMessage(msg1, sinon.stub().resolves(true))
            })
            it('should decrypt encrypted content with the correct key', (done) => {
                const groupKey = crypto.randomBytes(32)
                const data = {
                    foo: 'bar',
                }
                const msg1 = createMsg(1, 0, null, 0, data)
                EncryptionUtil.encryptStreamMessage(msg1, groupKey)
                const sub = new RealTimeSubscription(msg1.getStreamId(), msg1.getStreamPartition(), (content) => {
                    assert.deepStrictEqual(content, data)
                    done()
                }, {
                    publisherId: groupKey,
                })
                return sub.handleBroadcastMessage(msg1, sinon.stub().resolves(true))
            })
            it('should emit "groupKeyMissing" when not able to decrypt with the wrong key', (done) => {
                const correctGroupKey = crypto.randomBytes(32)
                const wrongGroupKey = crypto.randomBytes(32)
                const msg1 = createMsg(1, 0, null, 0, {
                    foo: 'bar',
                })
                EncryptionUtil.encryptStreamMessage(msg1, correctGroupKey)
                const sub = new RealTimeSubscription(msg1.getStreamId(), msg1.getStreamPartition(), sinon.stub(), {
                    publisherId: wrongGroupKey,
                })
                sub.on('groupKeyMissing', (publisherId) => {
                    assert.strictEqual(publisherId, msg1.getPublisherId())
                    done()
                })
                return sub.handleBroadcastMessage(msg1, sinon.stub().resolves(true))
            })
            it('should queue messages when not able to decrypt and handle them once the key is updated', async () => {
                const correctGroupKey = crypto.randomBytes(32)
                const wrongGroupKey = crypto.randomBytes(32)
                const data1 = {
                    test: 'data1',
                }
                const data2 = {
                    test: 'data2',
                }
                const msg1 = createMsg(1, 0, null, 0, data1)
                const msg2 = createMsg(2, 0, 1, 0, data2)
                EncryptionUtil.encryptStreamMessage(msg1, correctGroupKey)
                EncryptionUtil.encryptStreamMessage(msg2, correctGroupKey)
                let received1 = null
                let received2 = null
                const sub = new RealTimeSubscription(msg1.getStreamId(), msg1.getStreamPartition(), (content) => {
                    if (!received1) {
                        received1 = content
                    } else {
                        received2 = content
                    }
                }, {
                    publisherId: wrongGroupKey,
                })
                // cannot decrypt msg1, queues it and emits "groupKeyMissing" (should send group key request).
                await sub.handleBroadcastMessage(msg1, sinon.stub().resolves(true))
                // cannot decrypt msg2, queues it.
                await sub.handleBroadcastMessage(msg2, sinon.stub().resolves(true))
                // faking the reception of the group key response
                sub.setGroupKeys('publisherId', [correctGroupKey])
                // try again to decrypt the queued messages but this time with the correct key
                assert.deepStrictEqual(received1, data1)
                assert.deepStrictEqual(received2, data2)
            })
            it('should call "onUnableToDecrypt" when not able to decrypt for the second time', async () => {
                const correctGroupKey = crypto.randomBytes(32)
                const wrongGroupKey = crypto.randomBytes(32)
                const otherWrongGroupKey = crypto.randomBytes(32)
                const msg1 = createMsg(1, 0, null, 0, {
                    test: 'data1',
                })
                const msg2 = createMsg(2, 0, 1, 0, {
                    test: 'data2',
                })
                EncryptionUtil.encryptStreamMessage(msg1, correctGroupKey)
                EncryptionUtil.encryptStreamMessage(msg2, correctGroupKey)
                let undecryptableMsg = null
                const sub = new RealTimeSubscription(msg1.getStreamId(), msg1.getStreamPartition(), () => {
                    throw new Error('should not call the handler')
                }, {
                    publisherId: wrongGroupKey,
                }, 5000, 5000, true, (error) => {
                    undecryptableMsg = error.streamMessage
                })
                // cannot decrypt msg1, emits "groupKeyMissing" (should send group key request).
                await sub.handleBroadcastMessage(msg1, sinon.stub().resolves(true))
                // cannot decrypt msg2, queues it.
                await sub.handleBroadcastMessage(msg2, sinon.stub().resolves(true))
                // faking the reception of the group key response
                sub.setGroupKeys('publisherId', [otherWrongGroupKey])
                assert.deepStrictEqual(undecryptableMsg, msg2)
            })
            it('should decrypt first content, update key and decrypt second content', async (done) => {
                const groupKey1 = crypto.randomBytes(32)
                const groupKey2 = crypto.randomBytes(32)
                const data1 = {
                    test: 'data1',
                }
                const data2 = {
                    test: 'data2',
                }
                const msg1 = createMsg(1, 0, null, 0, data1)
                const msg2 = createMsg(2, 0, 1, 0, data2)
                EncryptionUtil.encryptStreamMessageAndNewKey(groupKey2, msg1, groupKey1)
                EncryptionUtil.encryptStreamMessage(msg2, groupKey2)
                let test1Ok = false
                const sub = new RealTimeSubscription(msg1.getStreamId(), msg1.getStreamPartition(), (content) => {
                    if (JSON.stringify(content) === JSON.stringify(data1)) {
                        assert.deepStrictEqual(sub.groupKeys.publisherId, groupKey2)
                        test1Ok = true
                    } else if (test1Ok && JSON.stringify(content) === JSON.stringify(data2)) {
                        done()
                    }
                }, {
                    publisherId: groupKey1,
                })
                await sub.handleBroadcastMessage(msg1, sinon.stub().resolves(true))
                return sub.handleBroadcastMessage(msg2, sinon.stub().resolves(true))
            })
        })
    })

    describe('handleError()', () => {
        it('emits an error event', (done) => {
            const err = new Error('Test error')
            const sub = new RealTimeSubscription(
                msg.getStreamId(),
                msg.getStreamPartition(),
                sinon.stub().throws('Msg handler should not be called!'),
            )
            sub.on('error', (thrown) => {
                assert(err === thrown)
                done()
            })
            sub.handleError(err)
        })

        it('marks the message as received if an InvalidJsonError occurs, and continue normally on next message', async (done) => {
            const sub = new RealTimeSubscription(msg.getStreamId(), msg.getStreamPartition(), (content, receivedMsg) => {
                if (receivedMsg.getTimestamp() === 3) {
                    sub.stop()
                    done()
                }
            })

            sub.on('gap', sinon.stub().throws('Should not emit gap!'))

            const msg1 = msg
            const msg3 = createMsg(3, undefined, 2)

            // Receive msg1 successfully
            await sub.handleBroadcastMessage(msg1, sinon.stub().resolves(true))

            // Get notified of an invalid message
            const err = new Errors.InvalidJsonError(msg.getStreamId(), 'invalid json', 'test error msg', createMsg(2, undefined, 1))
            sub.handleError(err)

            // Receive msg3 successfully
            await sub.handleBroadcastMessage(msg3, sinon.stub().resolves(true))
        })

        it('if an InvalidJsonError AND a gap occur, does not mark it as received and emits gap at the next message', async (done) => {
            const sub = new RealTimeSubscription(msg.getStreamId(), msg.getStreamPartition(), sinon.stub(), {}, 100, 100)

            sub.on('gap', (from, to, publisherId) => {
                assert.equal(from.timestamp, 1) // cannot know the first missing message so there will be a duplicate received
                assert.equal(from.sequenceNumber, 1)
                assert.equal(to.timestamp, 3)
                assert.equal(to.sequenceNumber, 0)
                assert.equal(publisherId, 'publisherId')
                setTimeout(() => {
                    sub.stop()
                    done()
                }, 100)
            })

            const msg1 = msg
            const msg4 = createMsg(4, undefined, 3)

            // Receive msg1 successfully
            await sub.handleBroadcastMessage(msg1, sinon.stub().resolves(true))

            // Get notified of invalid msg3 (msg2 is missing)
            const err = new Errors.InvalidJsonError(msg.getStreamId(), 'invalid json', 'test error msg', createMsg(3, undefined, 2))
            sub.handleError(err)

            // Receive msg4 and should emit gap
            await sub.handleBroadcastMessage(msg4, sinon.stub().resolves(true))
        })
    })

    describe('setState()', () => {
        it('updates the state', () => {
            const sub = new RealTimeSubscription(msg.getStreamId(), msg.getStreamPartition(), sinon.stub())
            sub.setState(Subscription.State.subscribed)
            assert.equal(sub.getState(), Subscription.State.subscribed)
        })
        it('fires an event', (done) => {
            const sub = new RealTimeSubscription(msg.getStreamId(), msg.getStreamPartition(), sinon.stub())
            sub.on(Subscription.State.subscribed, done)
            sub.setState(Subscription.State.subscribed)
        })
    })

    describe('handleResending()', () => {
        it('emits the resending event', (done) => {
            const sub = new RealTimeSubscription(msg.getStreamId(), msg.getStreamPartition(), sinon.stub())
            sub.addPendingResendRequestId('requestId')
            sub.on('resending', () => done())
            sub.setResending(true)
            sub.handleResending(ControlLayer.ResendResponseResending.create('streamId', 0, 'requestId'))
        })
    })

    describe('handleResent()', () => {
        it('arms the Subscription to emit the resent event on last message (message handler completes BEFORE resent)', async (done) => {
            const handler = sinon.stub()
            const sub = new RealTimeSubscription(msg.getStreamId(), msg.getStreamPartition(), handler)
            sub.addPendingResendRequestId('requestId')
            sub.on('resent', () => done())
            sub.setResending(true)
            await sub.handleResentMessage(msg, sinon.stub().resolves(true))
            sub.handleResent(ControlLayer.ResendResponseResent.create('streamId', 0, 'requestId'))
        })

        it('arms the Subscription to emit the resent event on last message (message handler completes AFTER resent)', async (done) => {
            const handler = sinon.stub()
            const sub = new RealTimeSubscription(msg.getStreamId(), msg.getStreamPartition(), handler)
            sub.addPendingResendRequestId('requestId')
            sub.on('resent', () => done())
            sub.setResending(true)
            sub.handleResentMessage(msg, sinon.stub().resolves(true))
            sub.handleResent(ControlLayer.ResendResponseResent.create('streamId', 0, 'requestId'))
        })

        describe('on error', () => {
            let stdError
            let sub

            beforeEach(() => {
                stdError = console.error
                console.error = sinon.stub()
            })

            afterEach(() => {
                console.error = stdError
                sub.stop()
            })

            it('cleans up the resend if event handler throws', async () => {
                const handler = sinon.stub()
                sub = new RealTimeSubscription(msg.getStreamId(), msg.getStreamPartition(), handler)
                const error = new Error('test error, ignore')
                sub.addPendingResendRequestId('requestId')
                sub.on('resent', sinon.stub().throws(error))
                sub.setResending(true)
                await sub.handleResentMessage(msg, sinon.stub().resolves(true))

                await sub.handleResent(ControlLayer.ResendResponseResent.create('streamId', 0, 'requestId'))
                assert(!sub.isResending())
            })
        })
    })

    describe('handleNoResend()', () => {
        it('emits the no_resend event', (done) => {
            const sub = new RealTimeSubscription(msg.getStreamId(), msg.getStreamPartition(), sinon.stub())
            sub.addPendingResendRequestId('requestId')
            sub.on('no_resend', () => done())
            sub.setResending(true)
            sub.handleNoResend(ControlLayer.ResendResponseNoResend.create('streamId', 0, 'requestId'))
        })

        describe('on error', () => {
            let stdError
            let sub

            beforeEach(() => {
                stdError = console.error
                console.error = sinon.stub()
            })

            afterEach(() => {
                console.error = stdError
                sub.stop()
            })

            it('cleans up the resend if event handler throws', async () => {
                sub = new RealTimeSubscription(msg.getStreamId(), msg.getStreamPartition(), sinon.stub())
                const error = new Error('test error, ignore')
                sub.addPendingResendRequestId('requestId')
                sub.on('no_resend', sinon.stub()
                    .throws(error))
                sub.setResending(true)
                await sub.handleNoResend(ControlLayer.ResendResponseNoResend.create('streamId', 0, 'requestId'))
                assert(!sub.isResending())
            })
        })
    })
})
