import { ControlLayer, MessageLayer, Errors } from 'streamr-client-protocol'
import { wait } from 'streamr-test-utils'

import RealTimeSubscription from '../../src/RealTimeSubscription'
import Subscription from '../../src/Subscription'

const { StreamMessage, MessageIDStrict, MessageRef } = MessageLayer

const createMsg = (
    timestamp = 1, sequenceNumber = 0, prevTimestamp = null,
    prevSequenceNumber = 0, content = {}, publisherId = 'publisherId', msgChainId = '1',
    encryptionType,
) => {
    const prevMsgRef = prevTimestamp ? new MessageRef(prevTimestamp, prevSequenceNumber) : null
    return new StreamMessage({
        messageId: new MessageIDStrict('streamId', 0, timestamp, sequenceNumber, publisherId, msgChainId),
        prevMsgRef,
        content,
        encryptionType,
    })
}

const msg = createMsg()

describe('RealTimeSubscription', () => {
    describe('message handling', () => {
        describe('handleBroadcastMessage()', () => {
            it('calls the message handler', async (done) => {
                const handler = jest.fn(async () => true)

                const sub = new RealTimeSubscription({
                    streamId: msg.getStreamId(),
                    streamPartition: msg.getStreamPartition(),
                    callback: (content, receivedMsg) => {
                        expect(content).toStrictEqual(msg.getParsedContent())
                        expect(msg).toStrictEqual(receivedMsg)
                        expect(handler).toHaveBeenCalledTimes(1)
                        done()
                    },
                })
                await sub.handleBroadcastMessage(msg, handler)
            })

            describe('on error', () => {
                let sub

                beforeEach(() => {
                    sub = new RealTimeSubscription({
                        streamId: msg.getStreamId(),
                        streamPartition: msg.getStreamPartition(),
                        callback: () => { throw new Error('should not be called!') },
                    })
                    sub.onError = jest.fn()
                })

                afterEach(() => {
                    sub.stop()
                })

                describe('when message verification throws', () => {
                    it('emits an error event', async (done) => {
                        const error = new Error('test error')
                        sub.once('error', (err) => {
                            expect(err).toBe(error)
                            done()
                        })
                        await sub.handleBroadcastMessage(msg, () => { throw error })
                    })
                })

                describe('when message handler throws', () => {
                    it('emits an error event', async (done) => {
                        sub.once('error', (err) => {
                            expect(err.message).toBe('should not be called!')
                            expect(sub.onError).toHaveBeenCalled()
                            done()
                        })
                        await sub.handleBroadcastMessage(msg, async () => true)
                    })

                    it('prints to standard error stream', async (done) => {
                        sub.once('error', (err) => {
                            expect(err.message).toBe('should not be called!')
                            expect(sub.onError).toHaveBeenCalled()
                            done()
                        })
                        await sub.handleBroadcastMessage(msg, async () => true)
                    })
                })
            })

            it('calls the callback once for each message in order', async (done) => {
                const msgs = [1, 2, 3, 4, 5].map((timestamp) => createMsg(
                    timestamp,
                    timestamp === 1 ? 0 : timestamp - 1,
                ))

                const received = []

                const sub = new RealTimeSubscription({
                    streamId: msg.getStreamId(),
                    streamPartition: msg.getStreamPartition(),
                    callback: (content, receivedMsg) => {
                        received.push(receivedMsg)
                        if (received.length === 5) {
                            expect(msgs).toStrictEqual(received)
                            done()
                        }
                    }
                })

                await Promise.all(msgs.map((m) => sub.handleBroadcastMessage(m, async () => true)))
            })
        })

        describe('handleResentMessage()', () => {
            it('processes messages if resending is true', async () => {
                const handler = jest.fn()
                const sub = new RealTimeSubscription({
                    streamId: msg.getStreamId(),
                    streamPartition: msg.getStreamPartition(),
                    callback: handler,
                })

                sub.setResending(true)
                await sub.handleResentMessage(msg, 'requestId', async () => true)
                expect(handler).toHaveBeenCalledTimes(1)
            })

            describe('on error', () => {
                let sub

                beforeEach(() => {
                    sub = new RealTimeSubscription({
                        streamId: msg.getStreamId(),
                        streamPartition: msg.getStreamPartition(),
                        callback: () => {
                            throw new Error('should not be called!')
                        },
                    })
                    sub.setResending(true)
                })

                afterEach(() => {
                    sub.stop()
                })

                describe('when message verification throws', () => {
                    it('emits an error event', async (done) => {
                        const error = new Error('test error')
                        sub.onError = jest.fn()
                        sub.once('error', (err) => {
                            expect(err).toBe(error)
                            expect(sub.onError).toHaveBeenCalled()
                            done()
                        })
                        return sub.handleResentMessage(msg, 'requestId', () => { throw error })
                    })
                })

                describe('when message handler throws', () => {
                    it('emits an error event', async (done) => {
                        sub.onError = jest.fn()
                        sub.once('error', (err) => {
                            expect(err.message).toBe('should not be called!')
                            expect(sub.onError).toHaveBeenCalled()
                            done()
                        })
                        await sub.handleResentMessage(msg, 'requestId', async () => true)
                    })

                    it('prints to standard error stream', async (done) => {
                        sub.onError = jest.fn()
                        sub.once('error', (err) => {
                            expect(err.message).toBe('should not be called!')
                            expect(sub.onError).toHaveBeenCalled()
                            done()
                        })
                        return sub.handleResentMessage(msg, 'requestId', async () => true)
                    })
                })
            })
        })

        describe('duplicate handling', () => {
            it('ignores re-received messages', async () => {
                const handler = jest.fn()
                const sub = new RealTimeSubscription({
                    streamId: msg.getStreamId(),
                    streamPartition: msg.getStreamPartition(),
                    callback: handler,
                })

                await sub.handleBroadcastMessage(msg, async () => true)
                await sub.handleBroadcastMessage(msg, async () => true)
                expect(handler).toHaveBeenCalledTimes(1)
                sub.stop()
            })

            it('ignores re-received messages if they come from resend', async () => {
                const handler = jest.fn()
                const sub = new RealTimeSubscription({
                    streamId: msg.getStreamId(),
                    streamPartition: msg.getStreamPartition(),
                    callback: handler,
                })
                sub.setResending(true)

                await sub.handleBroadcastMessage(msg, async () => true)
                await sub.handleResentMessage(msg, 'requestId', async () => true)
                sub.stop()
            })
        })

        describe('gap detection', () => {
            it('emits "gap" if a gap is detected', (done) => {
                const msg1 = msg
                const msg4 = createMsg(4, undefined, 3)
                const sub = new RealTimeSubscription({
                    streamId: msg.getStreamId(),
                    streamPartition: msg.getStreamPartition(),
                    callback: () => {},
                    propagationTimeout: 100,
                    resendTimeout: 100,
                })
                sub.once('gap', (from, to, publisherId) => {
                    expect(from.timestamp).toEqual(1) // cannot know the first missing message so there will be a duplicate received
                    expect(from.sequenceNumber).toEqual(1)
                    expect(to.timestamp).toEqual(3)
                    expect(to.sequenceNumber).toEqual(0)
                    expect(publisherId).toEqual('publisherId')
                    setTimeout(() => {
                        sub.stop()
                        done()
                    }, 100)
                })

                sub.handleBroadcastMessage(msg1, async () => true)
                sub.handleBroadcastMessage(msg4, async () => true)
            })

            it('emits second "gap" after the first one if no missing message is received in between', (done) => {
                const msg1 = msg
                const msg4 = createMsg(4, undefined, 3)

                const sub = new RealTimeSubscription({
                    streamId: msg.getStreamId(),
                    streamPartition: msg.getStreamPartition(),
                    callback: () => {},
                    propagationTimeout: 100,
                    resendTimeout: 100,
                })

                sub.once('gap', (from, to, publisherId) => {
                    sub.once('gap', (from2, to2, publisherId2) => {
                        expect(from).toStrictEqual(from2)
                        expect(to).toStrictEqual(to2)
                        expect(publisherId).toStrictEqual(publisherId2)
                        sub.stop()
                        done()
                    })
                })

                sub.handleBroadcastMessage(msg1, async () => true)
                sub.handleBroadcastMessage(msg4, async () => true)
            })

            it('does not emit second "gap" after the first one if the missing messages are received in between', (done) => {
                const msg1 = msg
                const msg2 = createMsg(2, undefined, 1)
                const msg3 = createMsg(3, undefined, 2)
                const msg4 = createMsg(4, undefined, 3)

                const sub = new RealTimeSubscription({
                    streamId: msg.getStreamId(),
                    streamPartition: msg.getStreamPartition(),
                    callback: () => {},
                    propagationTimeout: 100,
                    resendTimeout: 100,
                })

                sub.once('gap', () => {
                    sub.handleBroadcastMessage(msg2, async () => true)
                    sub.handleBroadcastMessage(msg3, async () => true)
                    sub.once('gap', () => { throw new Error('should not emit second gap') })
                    setTimeout(() => {
                        sub.stop()
                        done()
                    }, 100 + 1000)
                })

                sub.handleBroadcastMessage(msg1, async () => true)
                sub.handleBroadcastMessage(msg4, async () => true)
            })

            it('does not emit second "gap" if gets unsubscribed', async (done) => {
                const msg1 = msg
                const msg4 = createMsg(4, undefined, 3)

                const sub = new RealTimeSubscription({
                    streamId: msg.getStreamId(),
                    streamPartition: msg.getStreamPartition(),
                    callback: () => {},
                    propagationTimeout: 100,
                    resendTimeout: 100,
                })

                sub.once('gap', () => {
                    sub.emit('unsubscribed')
                    sub.once('gap', () => { throw new Error('should not emit second gap') })
                    setTimeout(() => {
                        sub.stop()
                        done()
                    }, 100 + 1000)
                })

                sub.handleBroadcastMessage(msg1, async () => true)
                sub.handleBroadcastMessage(msg4, async () => true)
            })

            it('does not emit second "gap" if gets disconnected', async (done) => {
                const msg1 = msg
                const msg4 = createMsg(4, undefined, 3)

                const sub = new RealTimeSubscription({
                    streamId: msg.getStreamId(),
                    streamPartition: msg.getStreamPartition(),
                    callback: () => {},
                    propagationTimeout: 100,
                    resendTimeout: 100,
                })

                sub.once('gap', () => {
                    sub.emit('disconnected')
                    sub.once('gap', () => { throw new Error('should not emit second gap') })
                    setTimeout(() => {
                        sub.stop()
                        done()
                    }, 100 + 1000)
                })

                sub.handleBroadcastMessage(msg1, async () => true)
                sub.handleBroadcastMessage(msg4, async () => true)
            })

            it('does not emit "gap" if different publishers', async () => {
                const msg1 = msg
                const msg1b = createMsg(1, 0, undefined, 0, {}, 'anotherPublisherId')

                const sub = new RealTimeSubscription({
                    streamId: msg.getStreamId(),
                    streamPartition: msg.getStreamPartition(),
                    callback: () => {},
                    propagationTimeout: 100,
                    resendTimeout: 100,
                })
                sub.once('gap', () => {
                    throw new Error('unexpected gap')
                })

                sub.handleBroadcastMessage(msg1, async () => true)
                sub.handleBroadcastMessage(msg1b, async () => true)
                await wait(100)
            })

            it('emits "gap" if a gap is detected (same timestamp but different sequenceNumbers)', (done) => {
                const msg1 = msg
                const msg4 = createMsg(1, 4, 1, 3)

                const sub = new RealTimeSubscription({
                    streamId: msg.getStreamId(),
                    streamPartition: msg.getStreamPartition(),
                    callback: () => {},
                    propagationTimeout: 100,
                    resendTimeout: 100,
                })
                sub.once('gap', (from, to, publisherId) => {
                    expect(from.timestamp).toEqual(1) // cannot know the first missing message so there will be a duplicate received
                    expect(from.sequenceNumber).toEqual(1)
                    expect(to.timestamp).toEqual(1)
                    expect(to.sequenceNumber).toEqual(3)
                    expect(publisherId).toEqual('publisherId')
                    setTimeout(() => {
                        sub.stop()
                        done()
                    }, 100)
                })

                sub.handleBroadcastMessage(msg1, async () => true)
                sub.handleBroadcastMessage(msg4, async () => true)
            })

            it('does not emit "gap" if a gap is not detected', async () => {
                const msg1 = msg
                const msg2 = createMsg(2, undefined, 1)

                const sub = new RealTimeSubscription({
                    streamId: msg.getStreamId(),
                    streamPartition: msg.getStreamPartition(),
                    callback: () => {},
                    propagationTimeout: 100,
                    resendTimeout: 100,
                })
                sub.once('gap', () => { throw new Error() })

                sub.handleBroadcastMessage(msg1, async () => true)
                sub.handleBroadcastMessage(msg2, async () => true)
            })

            it('does not emit "gap" if a gap is not detected (same timestamp but different sequenceNumbers)', async () => {
                const msg1 = msg
                const msg2 = createMsg(1, 1, 1, 0)

                const sub = new RealTimeSubscription({
                    streamId: msg.getStreamId(),
                    streamPartition: msg.getStreamPartition(),
                    callback: () => {},
                    propagationTimeout: 100,
                    resendTimeout: 100,
                })
                sub.once('gap', () => { throw new Error() })

                sub.handleBroadcastMessage(msg1, async () => true)
                sub.handleBroadcastMessage(msg2, async () => true)
                await wait(100)
            })
        })

        describe('ordering util', () => {
            it('handles messages in the order in which they arrive if no ordering util', async () => {
                const msg1 = msg
                const msg2 = createMsg(2, 0, 1, 0)
                const msg3 = createMsg(3, 0, 2, 0)
                const msg4 = createMsg(4, 0, 3, 0)
                const received = []
                const sub = new RealTimeSubscription({
                    streamId: msg.getStreamId(),
                    streamPartition: msg.getStreamPartition(),
                    callback: (content, receivedMsg) => {
                        received.push(receivedMsg)
                    },
                    propagationTimeout: 100,
                    resendTimeout: 100,
                    orderMessages: false,
                })
                sub.once('gap', () => { throw new Error() })

                await sub.handleBroadcastMessage(msg1, async () => true)
                await sub.handleBroadcastMessage(msg2, async () => true)
                await sub.handleBroadcastMessage(msg4, async () => true)
                await sub.handleBroadcastMessage(msg2, async () => true)
                await sub.handleBroadcastMessage(msg3, async () => true)
                await sub.handleBroadcastMessage(msg1, async () => true)

                expect(received).toStrictEqual([msg1, msg2, msg4, msg2, msg3, msg1])
            })

            it('handles messages in order without duplicates if ordering util is set', async () => {
                const msg1 = msg
                const msg2 = createMsg(2, 0, 1, 0)
                const msg3 = createMsg(3, 0, 2, 0)
                const msg4 = createMsg(4, 0, 3, 0)
                const received = []

                const sub = new RealTimeSubscription({
                    streamId: msg.getStreamId(),
                    streamPartition: msg.getStreamPartition(),
                    callback: (content, receivedMsg) => {
                        received.push(receivedMsg)
                    },
                    propagationTimeout: 100,
                    resendTimeout: 100,
                    orderMessages: true,
                })

                await sub.handleBroadcastMessage(msg1, async () => true)
                await sub.handleBroadcastMessage(msg2, async () => true)
                await sub.handleBroadcastMessage(msg4, async () => true)
                await sub.handleBroadcastMessage(msg2, async () => true)
                await sub.handleBroadcastMessage(msg3, async () => true)
                await sub.handleBroadcastMessage(msg1, async () => true)

                expect(received).toStrictEqual([msg1, msg2, msg3, msg4])
            })
        })

        it('emits done after processing a message with the bye key', (done) => {
            const byeMsg = createMsg(1, undefined, null, null, {
                _bye: true,
            })
            const handler = jest.fn()
            const sub = new RealTimeSubscription({
                streamId: byeMsg.getStreamId(),
                streamPartition: byeMsg.getStreamPartition(),
                callback: handler,
            })
            sub.once('done', () => {
                expect(handler).toHaveBeenCalledTimes(1)
                done()
            })

            sub.handleBroadcastMessage(byeMsg, async () => true)
        })
    })

    describe('handleError()', () => {
        it('emits an error event', (done) => {
            const err = new Error('Test error')
            const sub = new RealTimeSubscription({
                streamId: msg.getStreamId(),
                streamPartition: msg.getStreamPartition(),
                callback: () => {
                    throw new Error('Msg handler should not be called!')
                },
            })
            sub.onError = jest.fn()
            sub.once('error', (thrown) => {
                expect(err === thrown).toBeTruthy()
                done()
            })
            sub.handleError(err)
        })

        it('marks the message as received if an InvalidJsonError occurs, and continue normally on next message', async (done) => {
            const sub = new RealTimeSubscription({
                streamId: msg.getStreamId(),
                streamPartition: msg.getStreamPartition(),
                callback: (content, receivedMsg) => {
                    if (receivedMsg.getTimestamp() === 3) {
                        sub.stop()
                        done()
                    }
                },
            })
            sub.onError = jest.fn()

            sub.once('gap', () => { throw new Error('Should not emit gap!') })

            const msg1 = msg
            const msg3 = createMsg(3, undefined, 2)

            // Receive msg1 successfully
            await sub.handleBroadcastMessage(msg1, async () => true)

            // Get notified of an invalid message
            const err = new Errors.InvalidJsonError(msg.getStreamId(), 'invalid json', 'test error msg', createMsg(2, undefined, 1))
            sub.handleError(err)

            // Receive msg3 successfully
            await sub.handleBroadcastMessage(msg3, async () => true)
        })

        it('if an InvalidJsonError AND a gap occur, does not mark it as received and emits gap at the next message', async (done) => {
            const sub = new RealTimeSubscription({
                streamId: msg.getStreamId(),
                streamPartition: msg.getStreamPartition(),
                callback: () => {},
                propagationTimeout: 100,
                resendTimeout: 100,
            })
            sub.onError = jest.fn()

            sub.once('gap', (from, to, publisherId) => {
                expect(from.timestamp).toEqual(1) // cannot know the first missing message so there will be a duplicate received
                expect(from.sequenceNumber).toEqual(1)
                expect(to.timestamp).toEqual(3)
                expect(to.sequenceNumber).toEqual(0)
                expect(publisherId).toEqual('publisherId')
                setTimeout(() => {
                    sub.stop()
                    done()
                }, 100)
            })

            const msg1 = msg
            const msg4 = createMsg(4, undefined, 3)

            // Receive msg1 successfully
            await sub.handleBroadcastMessage(msg1, async () => true)

            // Get notified of invalid msg3 (msg2 is missing)
            const err = new Errors.InvalidJsonError(msg.getStreamId(), 'invalid json', 'test error msg', createMsg(3, undefined, 2))
            sub.handleError(err)

            // Receive msg4 and should emit gap
            await sub.handleBroadcastMessage(msg4, async () => true)
        })
    })

    describe('setState()', () => {
        it('updates the state', () => {
            const sub = new RealTimeSubscription({
                streamId: msg.getStreamId(),
                streamPartition: msg.getStreamPartition(),
                callback: () => {},
            })
            sub.setState(Subscription.State.subscribed)
            expect(sub.getState()).toEqual(Subscription.State.subscribed)
        })
        it('fires an event', (done) => {
            const sub = new RealTimeSubscription({
                streamId: msg.getStreamId(),
                streamPartition: msg.getStreamPartition(),
                callback: () => {},
            })
            sub.once(Subscription.State.subscribed, done)
            sub.setState(Subscription.State.subscribed)
        })
    })

    describe('handleResending()', () => {
        it('emits the resending event', (done) => {
            const sub = new RealTimeSubscription({
                streamId: msg.getStreamId(),
                streamPartition: msg.getStreamPartition(),
                callback: () => {},
            })
            sub.addPendingResendRequestId('requestId')
            sub.once('resending', () => done())
            sub.setResending(true)
            sub.handleResending(new ControlLayer.ResendResponseResending({
                streamId: 'streamId',
                streamPartition: 0,
                requestId: 'requestId',
            }))
        })
    })

    describe('handleResent()', () => {
        it('arms the Subscription to emit the resent event on last message (message handler completes BEFORE resent)', async (done) => {
            const handler = jest.fn()
            const sub = new RealTimeSubscription({
                streamId: msg.getStreamId(),
                streamPartition: msg.getStreamPartition(),
                callback: handler,
            })
            sub.addPendingResendRequestId('requestId')
            sub.once('resent', () => {
                expect(handler).toHaveBeenCalledTimes(1)
                done()
            })
            sub.setResending(true)
            await sub.handleResentMessage(msg, 'requestId', async () => true)
            sub.handleResent(new ControlLayer.ResendResponseResent({
                streamId: 'streamId',
                streamPartition: 0,
                requestId: 'requestId',
            }))
        })

        it('arms the Subscription to emit the resent event on last message (message handler completes AFTER resent)', async (done) => {
            const handler = jest.fn()
            const sub = new RealTimeSubscription({
                streamId: msg.getStreamId(),
                streamPartition: msg.getStreamPartition(),
                callback: handler,
            })
            sub.addPendingResendRequestId('requestId')
            sub.once('resent', () => {
                expect(handler).toHaveBeenCalledTimes(1)
                done()
            })
            sub.setResending(true)
            sub.handleResentMessage(msg, 'requestId', async () => true)
            sub.handleResent(new ControlLayer.ResendResponseResent({
                streamId: 'streamId',
                streamPartition: 0,
                requestId: 'requestId',
            }))
        })

        describe('on error', () => {
            let sub

            afterEach(() => {
                sub.stop()
            })

            it('cleans up the resend if event handler throws', async () => {
                sub = new RealTimeSubscription({
                    streamId: msg.getStreamId(),
                    streamPartition: msg.getStreamPartition(),
                    callback: () => {},
                })
                sub.onError = jest.fn()
                const error = new Error('test error, ignore')
                sub.addPendingResendRequestId('requestId')
                sub.once('resent', () => { throw error })
                sub.setResending(true)
                await sub.handleResentMessage(msg, 'requestId', async () => true)

                await sub.handleResent(new ControlLayer.ResendResponseResent({
                    streamId: 'streamId',
                    streamPartition: 0,
                    requestId: 'requestId',
                }))
                expect(!sub.isResending()).toBeTruthy()
            })
        })
    })

    describe('handleNoResend()', () => {
        it('emits the no_resend event', async () => {
            const sub = new RealTimeSubscription({
                streamId: msg.getStreamId(),
                streamPartition: msg.getStreamPartition(),
                callback: () => {},
            })
            sub.addPendingResendRequestId('requestId')
            const onNoResent = new Promise((resolve) => sub.once('no_resend', resolve))
            sub.setResending(true)
            await sub.handleNoResend(new ControlLayer.ResendResponseNoResend({
                streamId: 'streamId',
                streamPartition: 0,
                requestId: 'requestId',
            }))
            expect(!sub.isResending()).toBeTruthy()
            await onNoResent
        })

        describe('on error', () => {
            let sub

            afterEach(() => {
                sub.stop()
            })

            it('cleans up the resend if event handler throws', async () => {
                sub = new RealTimeSubscription({
                    streamId: msg.getStreamId(),
                    streamPartition: msg.getStreamPartition(),
                    callback: () => {},
                })
                sub.onError = jest.fn()
                const error = new Error('test error, ignore')
                sub.addPendingResendRequestId('requestId')
                sub.once('no_resend', () => { throw error })
                sub.setResending(true)
                await sub.handleNoResend(new ControlLayer.ResendResponseNoResend({
                    streamId: 'streamId',
                    streamPartition: 0,
                    requestId: 'requestId',
                }))
                expect(!sub.isResending()).toBeTruthy()
            })
        })
    })
})
