import EventEmitter from 'eventemitter3'
import assert from 'assert'
import mockery from 'mockery'
import sinon from 'sinon'
import debug from 'debug'

const mockDebug = debug('mock')

const STREAM_KEY = '_S'
const COUNTER_KEY = '_C'
const TIMESTAMP_KEY = '_TS'
const BYE_KEY = '_bye'
const SUB_KEY = '_sub'

describe('StreamrClient', function() {
    let client
    let socket
    let asyncs = []

    let StreamrClient

    let ioMock
    let ioMockCalls

    function async(func) {
        let me = setTimeout(function() {
            assert.equal(me, asyncs[0])
            asyncs.shift()
            func()
        }, 0)
        asyncs.push(me)
    }

    function clearAsync() {
        asyncs.forEach(function(it) {
            clearTimeout(it)
        })
        asyncs = []
    }

    let previousOffsetByStreamId = {}

    // ['version', 'streamId', 'streamPartition', 'timestamp', 'ttl', 'offset', 'previousOffset', 'contentType', 'content']

    function msg(streamId, offset, content, subId, forcePreviousOffset) {
        content = content || {}

        // unicast message to subscription
        if (subId != null) {
            return [
                28, // version
                streamId,
                0, // partition
                Date.now(), // timestamp
                0, // ttl
                offset,
                forcePreviousOffset, // previousOffset
                27, // contentType (JSON)
                JSON.stringify(content)]
        }
        // broadcast message to all subscriptions
        else {
            let previousOffset = forcePreviousOffset || previousOffsetByStreamId[streamId]
            previousOffsetByStreamId[streamId] = offset

            return [
                28, // version
                streamId,
                0, // partition
                Date.now(), // timestamp
                0, // ttl
                offset,
                previousOffset !== offset ? previousOffset : null,
                27, // contentType (JSON)
                JSON.stringify(content)]
        }
    }

    function byeMsg(stream, counter) {
        let bye = {}
        bye[BYE_KEY] = true
        return msg(stream, counter, bye)
    }

    function createSocketMock() {
        let s = new EventEmitter()

        s.connect = function() {
            async(function() {
                s.onopen()
            })
        }

        s.disconnect = function() {
            async(function() {
                if (!s.done) {
                    mockDebug('socket.disconnect: emitting disconnect')
                    s.onclose()
                }
            })
        }

        s.subscribeHandler = function(request) {
            async(function() {
                s.fakeReceive([0, 2, null, {
                    stream: request.stream, partition: 0
                }])
            })
        }

        s.unsubscribeHandler = function(request) {
            async(function() {
                s.fakeReceive([0, 3, null, {
                    stream: request.stream, partition: 0
                }])
            })
        }

        s.resendHandler = function(request) {
            throw 'Unexpected message ' + request
        }

        s.send = function(msg) {
            let parsed = JSON.parse(msg)
            if (parsed.type === 'subscribe') {
                s.subscribeHandler(parsed)
            } else if (parsed.type === 'unsubscribe') {
                s.unsubscribeHandler(parsed)
            } else if (parsed.type === 'resend') {
                s.resendHandler(parsed)
            } else {
                throw 'Unexpected message of type ' + parsed.type
            }
        }

        s.fakeReceive = function(msg) {
            if (!s.done) {
                s.onmessage({
                    data: JSON.stringify(msg)
                })
            }
        }

        s.close = function() {
            s.disconnect()
        }

        return s
    }

    before(function() {
        mockery.enable()

        mockery.registerMock('ws', function(uri, opts) {
            ioMockCalls++

            // Create new sockets for subsequent calls
            if (ioMockCalls > 1) {
                socket = createSocketMock()
            }

            socket.uri = uri
            socket.opts = opts
            socket.connect()

            return socket
        })

        StreamrClient = require('../src/StreamrClient')
    })

    beforeEach(function() {
        clearAsync()
        socket = createSocketMock()
        ioMockCalls = 0
        client = new StreamrClient()
        client.options.autoConnect = false
        client.options.autoDisconnect = false
        previousOffsetByStreamId = {}
    })

    after(function() {
        mockery.disable()
    })

    describe('connect', function() {
        it('should send pending subscribes', function(done) {
            let subscription = client.subscribe('stream1', 'auth', function(message) {})
            client.connect()

            client.connection.on('subscribed', function(request) {
                assert.equal(request.stream, 'stream1')
                socket.done = true
                done()
            })
        })

        it('should not send anything on connect if not subscribed to anything', function(done) {
            client.connect()

            client.connection.send = function() {
                if (this.event !== 'connect') {
                    throw 'Unexpected send: '+this.event
                }
            }

            socket.done = true
            done()
        })

        it('should report that it is connected and not connecting after connecting', function(done) {
            client.connect()
            client.connection.on('connected', function() {
                assert(client.isConnected())
                assert(!client.connecting)
                done()
            })
        })

        it('should not be connecting initially', function() {
            assert(!client.connecting)
        })

        it('should report that it is connecting after calling connect()', function() {
            client.connect()
            assert(client.connecting)
        })

        it('should not try to connect while connecting', function(done) {
            client.options.autoConnect = true
            client.subscribe('stream1', 'auth', function(message) {})
            client.subscribe('stream2', 'auth', function(message) {})

            assert.equal(ioMockCalls, 1)
            socket.done = true
            done()
        })
    })

    describe('reconnect', function() {
        it('should emit a subscribed event on reconnect', function(done) {
            let subscription = client.subscribe('stream1', 'auth', function(message) {})
            client.connect()

            // connect-disconnect-connect
            client.connection.once('connected', function() {
                client.connection.once('disconnected', function() {
                    client.connection.on('subscribed', function(request) {
                        assert.equal(request.stream, 'stream1')
                        socket.done = true
                        done()
                    })

                    console.log('Disconnected, now connecting!')
                    socket.connect()
                })

                console.log('Connected, now disconnecting!')
                socket.disconnect()

            })

        })

        it('should not emit a subscribed event for unsubscribed streams on reconnect', function(done) {
            let sub1 = client.subscribe('stream1', 'auth', function(message) {})
            let sub2 = client.subscribe('stream2', 'auth', function(message) {})
            client.connect()

            // when subscribed, a bye message is received, leading to an unsubscribe
            client.connection.on('subscribed', function(response) {
                if (sub1.isSubscribed() && sub2.isSubscribed()) {
                    client.unsubscribe(sub1)
                    client.connection.once('unsubscribed', function(response) {
                        socket.disconnect()

                        client.connection.on('subscribed', function(request) {
                            assert.equal(request.stream, 'stream2')
                            socket.done = true
                            done()
                        })
                        socket.connect()
                    })
                }
            })

        })

        it('should emit a subscribed event on reconnect for topics subscribed after initial connect', function(done) {
            client.connect()
            client.connection.once('connected', function() {
                client.subscribe('stream1', 'auth', function(message) {})
                client.connection.once('subscribed', function() {
                    socket.disconnect()
                    client.connection.once('subscribed', function(request) {
                        assert.equal(request.stream, 'stream1')
                        socket.done = true
                        done()
                    })
                    socket.connect()
                })
            })
        })
    })

    describe('subscribe', function() {
        it('should throw an error if no options are given', function() {
            assert.throws(function() {
                client.subscribe(undefined, function() {})
            })
        })

        it('should throw an error if options is wrong type', function() {
            assert.throws(function() {
                client.subscribe(['streamId'], function() {})
            })
        })

        it('should throw an error if no callback is given', function() {
            assert.throws(function() {
                client.subscribe('stream1')
            })
        })

        it('should emit a subscribed event when subscribing after connecting', function(done) {
            client.connect()
            client.connection.once('connected', function() {
                client.connection.once('subscribed', function(request) {
                    assert.equal(request.stream, 'stream1')
                    socket.done = true
                    done()
                })
                client.subscribe({
                    stream: 'stream1', authKey: 'auth'
                }, function(message) {})
            })
        })

        it('should accept a string as first argument for backwards compatibility/simplified usage', function(done) {
            client.connect()
            client.connection.once('connected', function() {
                client.connection.once('subscribed', function(request) {
                    assert.equal(request.stream, 'stream1')
                    socket.done = true
                    done()
                })
                client.subscribe('stream1', function(message) {})
            })
        })

        it('should add any subscription options to subscription request', function(done) {
            socket.subscribeHandler = function(request) {
                assert.equal(request.foo, 'bar')
                socket.done = true
                done()
            }

            client.connect()
            client.connection.once('connected', function() {
                client.subscribe({
                    stream: 'stream1', authKey: 'auth', foo: 'bar'
                }, function(message) {})
            })
        })

        it('should add legacy subscription options to subscription request', function(done) {
            socket.subscribeHandler = function(request) {
                assert.equal(request.foo, 'bar')
                socket.done = true
                done()
            }

            client.connect()
            client.connection.once('connected', function() {
                client.subscribe({
                    stream: 'stream1', authKey: 'auth'
                }, function(message) {}, {
                    foo: 'bar'
                })
            })
        })

        it('should ignore any subscription options that conflict with required ones', function(done) {
            socket.subscribeHandler = function(request) {
                assert.equal(request.stream, 'stream1')
                socket.done = true
                done()
            }

            client.connect()
            client.connection.once('connected', function() {
                client.subscribe('stream1', 'auth', function(message) {}, {
                    stream: 'wrong'
                })
            })
        })

        it('should mark Subscriptions as subscribed when the server responds with subscribed', function(done) {
            let subscription = client.subscribe('stream1', 'auth', function(message) {})
            client.connect()

            client.connection.once('subscribed', function() {
                assert(subscription.isSubscribed())
                done()
            })
        })

        it('should trigger an error event on the client if the subscribe fails', function(done) {
            socket.subscribeHandler = function(request) {
                socket.fakeReceive([0, 2, null, {
                    stream: request.stream, partition: 0, error: 'error message'
                }])
            }

            client.subscribe('stream1', 'auth', function(message) {})
            client.connect()

            client.on('error', function(msg) {
                assert(msg.indexOf('error message' >= 0))
                done()
            })

        })

        it('should connect if autoConnect is set to true', function(done) {
            client.options.autoConnect = true
            client.connect = done
            client.subscribe('stream1', 'auth', function(message) {})
        })

        it('should send only one subscribe request to server even if there are multiple subscriptions for same stream', function(done) {
            let subscribeCount = 0
            socket.on('subscribe', function(request) {
                subscribeCount++
                if (subscribeCount > 1) {
                    throw 'Only one subscribe request should be sent to the server!'
                }
            })

            let sub1 = client.subscribe('stream1', 'auth', function(message) {})
            let sub2 = client.subscribe('stream1', 'auth', function(message) {})
            client.connect()

            function check(sub) {
                sub._ack = true
                if (sub1._ack && sub2._ack) {
                    done()
                }
            }

            sub1.on('subscribed', function(response) {
                check(sub1)
            })
            sub2.on('subscribed', function(response) {
                check(sub2)
            })
        })

    })

    describe('subscribe with resend options', function() {

        it('should emit a resend request after subscribed', function(done) {
            const sub = client.subscribe({
                stream: 'stream1', authKey: 'auth', resend_all: true
            }, function(message) {})
            socket.resendHandler = function(request) {
                assert.equal(request.resend_all, true)
                assert.equal(sub.isSubscribed(), true)
                socket.done = true
                done()
            }
            client.connect()

        })

        it('should emit a resend request with given other options', function(done) {
            socket.resendHandler = function(request) {
                assert.equal(request.resend_all, true)
                assert.equal(request.foo, 'bar')
                socket.done = true
                done()
            }
            client.subscribe({
                stream: 'stream1', authKey: 'auth', resend_all: true, foo: 'bar'
            }, function(message) {})
            client.connect()
        })

        it('should throw an error if multiple resend options are given', function() {
            assert.throws(function() {
                client.subscribe({
                    stream: 'stream1', authKey: 'auth', resend_all: true, resend_last: 5
                }, function(message) {})
            })
        })

        it('should resend to multiple subscriptions as per each resend option', function(done) {
            socket.resendHandler = function(request) {
                const unicastCode = 1
                const resendingCode = 4
                const resentCode = 5

                if (request.resend_all) {
                    async(function() {
                        socket.fakeReceive([0, resendingCode, request.sub, {
                            stream:'stream1', partition: 0
                        }])
                        socket.fakeReceive([0, unicastCode, request.sub, msg('stream1', 0, request.sub)])
                        socket.fakeReceive([0, unicastCode, request.sub, msg('stream1', 1, request.sub)])
                        socket.fakeReceive([0, resentCode, request.sub, {
                            stream:'stream1', partition: 0
                        }])
                    })
                } else if (request.resend_last===1) {
                    async(function() {
                        socket.fakeReceive([0, resendingCode, request.sub, {
                            stream:'stream1', partition: 0
                        }])
                        socket.fakeReceive([0, unicastCode, request.sub, msg('stream1', 1, request.sub)])
                        socket.fakeReceive([0, resentCode, request.sub, {
                            stream:'stream1', partition: 0
                        }])
                    })
                }
            }

            let sub1count = 0
            client.subscribe({
                stream: 'stream1', authKey: 'auth', resend_all: true
            }, function(message) {
                sub1count++
            })

            let sub2count = 0
            client.subscribe({
                stream: 'stream1', authKey: 'auth', resend_last: 1
            }, function(message) {
                sub2count++
            })

            client.connect()

            let subCount = 0
            client.connection.on('disconnected', function(request) {
                subCount++
                assert.equal(subCount, 1)
                assert.equal(sub1count, 2)
                assert.equal(sub2count, 1)
                socket.done = true
                done()
            })

            setTimeout(client.disconnect.bind(client), 50)
        })

        it('should not crash on resent if bye message is received while resending', function(done) {
            socket.resendHandler = function(request) {
                const broadcastCode = 0
                const resendingCode = 4
                const resentCode = 5

                async(function() {
                    socket.fakeReceive([0, resendingCode, request.sub, {
                        stream:'stream1', partition: 0
                    }])
                    socket.fakeReceive([0, broadcastCode, null, byeMsg('stream1', 0)])
                    socket.fakeReceive([0, resentCode, request.sub, {
                        stream:'stream1', partition: 0
                    }])
                    done()
                })
            }

            client.subscribe({
                stream: 'stream1', authKey: 'auth', resend_all: true
            }, function(message) {})
            client.connect()
        })

        it('should not crash if messages exist after the bye message', function(done) {
            socket.resendHandler = function(request) {
                async(function() {
                    const broadcastCode = 0
                    const unicastCode = 1
                    const resendingCode = 4
                    const resentCode = 5

                    socket.fakeReceive([0, resendingCode, request.sub, {
                        stream:'stream1', partition: 0
                    }])
                    socket.fakeReceive([0, broadcastCode, request.sub, byeMsg('stream1', 0)])
                    socket.fakeReceive([0, unicastCode, request.sub, msg('stream1', 1, sub.id)])
                    socket.fakeReceive([0, resentCode, request.sub, {
                        stream:'stream1', sub:sub.id
                    }])
                    done()
                })
            }

            let sub = client.subscribe({
                stream: 'stream1', authKey: 'auth', resend_all: true
            }, function(message) {})
            client.connect()
        })
    })

    describe('message handling', function() {

        it('should call the callback when a message is received', function(done) {
            client.subscribe({
                stream: 'stream1', authKey: 'auth'
            }, function() {
                done()
            })
            client.connect()
            client.connection.once('subscribed', function() {
                const broadcastCode = 0
                socket.fakeReceive([0, broadcastCode, null, msg('stream1', 0)])
            })
        })

        it('should not call the callback nor throw an exception when a message is re-received', function(done) {
            let callbackCounter = 0
            client.subscribe({
                stream: 'stream1', authKey: 'auth'
            }, function(message) {
                ++callbackCounter
                assert.equal(callbackCounter, 1)
                done()
            })
            client.connect()

            client.connection.once('subscribed', function() {
                // Fake message
                const broadcastCode = 0
                socket.fakeReceive([0, broadcastCode, null, msg('stream1', 0)])
                socket.fakeReceive([0, broadcastCode, null, msg('stream1', 0)])
                socket.fakeReceive([0, broadcastCode, null, msg('stream1', 0)])
                socket.fakeReceive([0, broadcastCode, null, msg('stream1', 0)])
                socket.fakeReceive([0, broadcastCode, null, msg('stream1', 0)])
                socket.fakeReceive([0, broadcastCode, null, msg('stream1', 0)])
            })
        })

        it('should call the callback once for each message in order', function(done) {
            let receivedCounts = []
            client.subscribe({
                stream: 'stream1', authKey: 'auth'
            }, function(message) {
                receivedCounts.push(message.count)
                if (receivedCounts.length === 5) {
                    assert.deepEqual(receivedCounts, [0, 1, 2, 3, 4])
                    done()
                }
            })
            client.connect()

            client.connection.once('subscribed', function() {
                const broadcastCode = 0
                socket.fakeReceive([0, broadcastCode, null, msg('stream1', 0, {
                    count: 0
                })])
                socket.fakeReceive([0, broadcastCode, null, msg('stream1', 1, {
                    count: 1
                })])
                socket.fakeReceive([0, broadcastCode, null, msg('stream1', 2, {
                    count: 2
                })])
                socket.fakeReceive([0, broadcastCode, null, msg('stream1', 3, {
                    count: 3
                })])
                socket.fakeReceive([0, broadcastCode, null, msg('stream1', 4, {
                    count: 4
                })])
            })
        })

        it('should emit unsubscribe after processing a message with the bye key', function(done) {
            let processed = false
            client.subscribe({
                stream: 'stream1', authKey: 'auth'
            }, function(message) {
                processed = true
            })
            client.connect()

            client.connection.once('subscribed', function() {
                const broadcastCode = 0
                socket.fakeReceive([0, broadcastCode, null, byeMsg('stream1', 0)])
            })

            client.connection.once('unsubscribed', function(response)  {
                assert.equal(processed, true)
                assert.equal(response.stream, 'stream1')
                done()
            })
        })

        it('should direct messages to specific subscriptions if the messages contain the _sub key', function(done) {
            let numReceived = 0
            let sub1 = client.subscribe({
                stream: 'stream1', authKey: 'auth'
            }, function(message) {
                ++numReceived
                if (numReceived === 2) {
                    done()
                }
            })

            let sub2 = client.subscribe({
                stream: 'stream1', authKey: 'auth'
            }, function(message) {
                throw 'sub1 should not have received a message!'
            })

            client.connect()
            sub2.on('subscribed', function() {
                const broadcastCode = 0
                const unicastCode = 1

                assert.throws(function() {
                    // Received by sub2
                    socket.fakeReceive([0, broadcastCode, null, msg('stream1', 0)])
                })
                socket.fakeReceive([0, unicastCode, sub1.id, msg('stream1', 1)])
            })
        })

        it('should not call the handlers with any additional keys present in the message', function(done) {
            client.subscribe({
                stream: 'stream1', authKey: 'auth'
            }, function(message) {
                assert.deepEqual(message, {
                    count: 0
                })
                done()
            })
            client.connect()

            client.connection.once('subscribed', function() {
                const broadcastCode = 0
                socket.fakeReceive([0, broadcastCode, null, msg('stream1', 0, {
                    count: 0
                })])
            })
        })

    })

    describe('unsubscribe', function() {
        it('should fire the unsubscribed event', function(done) {
            let sub = client.subscribe({
                stream: 'stream1', authKey: 'auth'
            }, function(message) {})
            client.connect()
            sub.on('subscribed', function() {
                client.unsubscribe(sub)
            })
            sub.on('unsubscribed', function() {
                done()
            })
        })

        it('should unsubscribe the client from a stream when there are no more subscriptions for that stream', function(done) {
            let sub = client.subscribe({
                stream: 'stream1', authKey: 'auth'
            }, function(message) {})
            client.connect()

            client.connection.once('subscribed', function() {
                client.unsubscribe(sub)
            })

            client.connection.once('unsubscribed', function() {
                done()
            })
        })

        it('should not send another unsubscribed event if the same Subscription is unsubscribed multiple times', function(done) {
            let sub = client.subscribe({
                stream: 'stream1', authKey: 'auth'
            }, function(message) {})
            client.connect()

            client.connection.once('subscribed', function() {
                client.unsubscribe(sub)
            })

            client.connection.once('unsubscribed', function() {
                setTimeout(function() {
                    client.connection.once('unsubscribed', function() {
                        throw 'Unsubscribed event sent more than once for same Subscription!'
                    })
                    client.unsubscribe(sub)
                    done()
                })
            })
        })

        it('should not unsubscribe the client from a stream when there are subscriptions remaining for that stream', function(done) {
            let sub1 = client.subscribe({
                stream: 'stream1', authKey: 'auth'
            }, function(message) {})
            let sub2 = client.subscribe({
                stream: 'stream1', authKey: 'auth'
            }, function(message) {})
            client.connect()

            client.connection.on('unsubscribed', function() {
                throw 'Socket should not have unsubscribed'
            })

            sub1.on('unsubscribed', function() {
                throw 'sub1 should not have unsubscribed'
            })

            sub2.on('unsubscribed', function() {
                done()
            })

            sub2.on('subscribed', function() {
                client.unsubscribe(sub2)
            })
        })

        it('should not send an unsubscribe request again if unsubscribe is called multiple times', function(done) {
            let count = 0
            let defaultUnusubscribeHandler = socket.unsubscribeHandler
            socket.unsubscribeHandler = function(request) {
                ++count
                defaultUnusubscribeHandler(request)
            }

            let sub = client.subscribe({
                stream: 'stream1', authKey: 'auth'
            }, function(message) {})
            client.connect()

            client.connection.once('subscribed', function() {
                client.unsubscribe(sub)
                assert(sub.unsubscribing)
                client.unsubscribe(sub)
            })

            client.connection.on('unsubscribed', function() {
                assert.equal(count, 1)
                assert(!sub.unsubscribing)
                done()
            })
        })

        it('should throw an error if no Subscription is given', function() {
            let sub = client.subscribe('stream1', 'auth', function(message) {})
            client.connect()

            sub.on('subscribed', function() {
                assert.throws(function() {
                    client.unsubscribe()
                })
            })
        })

        it('should throw error if Subscription is of wrong type', function() {
            let sub = client.subscribe({
                stream: 'stream1', authKey: 'auth'
            }, function(message) {})
            client.connect()

            sub.on('subscribed', function() {
                assert.throws(function() {
                    client.unsubscribe('stream1')
                })
            })
        })

        it('should handle messages after resubscribing', function(done) {
            let sub = client.subscribe({
                stream: 'stream1', authKey: 'auth'
            }, function(message) {
                throw 'This message handler should not be called'
            })
            client.connect()

            sub.on('subscribed', function() {
                client.unsubscribe(sub)
            })

            sub.on('unsubscribed', function() {
                let newSub = client.subscribe({
                    stream: 'stream1', authKey: 'auth'
                }, function(message) {
                    assert.deepEqual(message, {
                        count: 0
                    })
                    done()
                })
                newSub.on('subscribed', function() {
                    const broadcastCode = 0
                    socket.fakeReceive([0, broadcastCode, null, msg('stream1', 0, {
                        count: 0
                    })])
                })
            })
        })

        it('should disconnect when no longer subscribed to any streams', function(done) {
            client.options.autoDisconnect = true

            let sub1 = client.subscribe({
                stream: 'stream1', authKey: 'auth'
            }, function(message) {})
            let sub2 = client.subscribe('stream2', 'auth', function(message) {})
            client.connect()

            client.connection.on('subscribed', function(response) {
                if (sub1.isSubscribed() && sub2.isSubscribed()) {
                    client.unsubscribe(sub1)
                    client.unsubscribe(sub2)
                }
            })

            client.connection.on('disconnected', function() {
                assert(!sub1.isSubscribed())
                assert(!sub2.isSubscribed())
                done()
            })
        })

        it('should disconnect if all subscriptions are done during resend', function(done) {
            client.options.autoDisconnect = true

            socket.resendHandler = function(request) {
                const resendingCode = 4
                socket.fakeReceive([0, resendingCode, null, {
                    stream: request.stream, partition: 0, sub: request.sub
                }])
            }

            let sub1 = client.subscribe({
                stream: 'stream1', authKey: 'auth'
            }, function(message) {}, {
                resend_all: true
            })
            client.connect()

            client.connection.on('resending', function(request) {
                async(function() {
                    const broadcastCode = 0
                    const resentCode = 5
                    socket.fakeReceive([0, broadcastCode, null, byeMsg(request.stream, 0)])
                    socket.fakeReceive([0, resentCode, null, {
                        stream: request.stream, partition: 0, sub: request.sub
                    }])
                })
            })

            client.connection.on('disconnected', function() {
                done()
            })
        })

        it('should not disconnect if autoDisconnect is set to false', function(done) {
            client.options.autoDisconnect = false

            let sub1 = client.subscribe({
                stream: 'stream1', authKey: 'auth'
            }, function(message) {})
            let sub2 = client.subscribe('stream2', 'auth', function(message) {})
            client.connect()

            client.connection.on('disconnected', function() {
                throw 'Should not have disconnected!'
            })

            client.connection.on('subscribed', function(response) {
                if (sub1.isSubscribed() && sub2.isSubscribed()) {
                    client.unsubscribe(sub1)
                    client.unsubscribe(sub2)
                    done()
                }
            })
        })
    })

    describe('disconnect', function() {

        it('should disconnect the socket', function(done) {
            client.connect()
            client.connection.disconnect = done

            client.connection.once('connected', function() {
                client.disconnect()
            })
        })

        it('should report that it is not connected and not connecting after disconnecting', function(done) {
            client.connect()

            client.connection.once('connected', function() {
                client.disconnect()
            })

            client.connection.once('disconnected', function() {
                assert(!client.isConnected())
                assert(!client.connecting)
                done()
            })
        })

        it('should reset subscriptions when calling disconnect()', function(done) {
            client.subscribe({
                stream: 'stream1', authKey: 'auth'
            }, function(message) {})
            client.connect()

            client.connection.once('subscribed', function() {
                client.disconnect()
            })

            client.connection.once('disconnected', function() {
                assert.equal(client.getSubscriptions('stream1').length, 0)
                done()
            })
        })

        it('should only subscribe to new subscriptions since calling disconnect()', function(done) {
            client.subscribe({
                stream: 'stream1', authKey: 'auth'
            }, function(message) {})
            client.connect()

            client.connection.once('subscribed', function() {
                client.disconnect()
            })

            client.connection.once('disconnected', function() {
                client.subscribe('stream2', 'auth', function(message) {})
                client.connect()

                client.connection.once('subscribed', function(response) {
                    assert.equal(response.stream, 'stream2')
                    done()
                })
            })
        })
    })

    describe('pause', function() {
        it('should disconnect the socket', function(done) {
            client.connect()

            client.connection.disconnect = done

            client.connection.once('connected', function() {
                client.pause()
            })
        })

        it('should report that its not connected after pausing', function(done) {
            client.connect()

            client.connection.once('connected', function() {
                client.pause()
            })

            client.connection.once('disconnected', function() {
                assert(!client.isConnected())
                done()
            })
        })

        it('should not reset subscriptions', function(done) {
            client.subscribe({
                stream: 'stream1', authKey: 'auth'
            }, function(message) {})
            client.connect()

            client.connection.once('subscribed', function() {
                client.pause()
            })

            client.connection.once('disconnected', function() {
                assert.equal(client.getSubscriptions('stream1').length, 1)
                done()
            })
        })

        it('should subscribe to both old and new subscriptions after pause-and-connect', function(done) {
            let sub1, sub2

            sub1 = client.subscribe({
                stream: 'stream1', authKey: 'auth'
            }, function(message) {})
            client.connect()

            client.connection.once('subscribed', function() {
                client.pause()
            })

            client.connection.once('disconnected', function() {
                sub2 = client.subscribe('stream2', 'auth', function(message) {})

                assert(!sub1.isSubscribed())
                assert(!sub2.isSubscribed())

                assert.equal(client.getSubscriptions('stream1').length, 1)
                assert.equal(client.getSubscriptions('stream2').length, 1)

                client.connect()
                client.connection.on('subscribed', function(response) {
                    if (sub1.isSubscribed() && sub2.isSubscribed()) {
                        socket.done = true
                        done()
                    }
                })
            })
        })
    })

    describe('resend', function() {
        let validResendRequests
        let resendLimits

        function checkResendRequest(request) {
            let el = validResendRequests[0]
            // all fields in the model request must be equal in actual request
            Object.keys(el).forEach(function(field) {
                if (request[field] !== el[field]) {
                    throw 'Resend request field '+field+' does not match expected value! Was: '+JSON.stringify(request)+', expected: '+JSON.stringify(el)
                }
            })
            validResendRequests.shift()
        }

        // Setup a resend response mock
        beforeEach(function() {
            validResendRequests = []
            resendLimits = {}

            function resend(stream, sub, from, to) {
                const unicastCode = 1
                const resendingCode = 4
                const resentCode = 5

                socket.fakeReceive([0, resendingCode, null, {
                    stream: stream, sub: sub
                }])
                for (let i=from;i<=to;i++) {
                    socket.fakeReceive([0, unicastCode, sub, msg(stream, i, {}, sub)])
                }
                socket.fakeReceive([0, resentCode, null, {
                    stream: stream, sub: sub
                }])
            }

            socket.resendHandler = function(request) {
                mockDebug('defaultResendHandler: '+JSON.stringify(request))

                // Check that the request is allowed
                checkResendRequest(request)

                async(function() {
                    mockDebug('handling resend request: %o', request)
                    if (request.resend_all) {
                        if (resendLimits[request.stream] === undefined) {
                            const noResendCode = 6
                            socket.fakeReceive([0, noResendCode, null, {
                                stream: request.stream, sub: request.sub
                            }])
                        } else {
                            resend(request.stream, request.sub, resendLimits[request.stream].from, resendLimits[request.stream].to)
                        }
                    } else if (request.resend_last) {
                        if (resendLimits[request.stream] === undefined) {
                            throw 'Testing resend_last needs resendLimits.stream.to'
                        }
                        resend(request.stream, request.sub, resendLimits[request.stream].to - (request.resend_last - 1), resendLimits[request.stream].to)
                    } else if (request.resend_from!=null && request.resend_to!=null) {
                        resend(request.stream, request.sub, request.resend_from, request.resend_to)
                    } else if (request.resend_from!=null) {
                        if (resendLimits[request.stream] === undefined) {
                            throw 'Testing resend_from needs resendLimits.stream.to'
                        }
                        resend(request.stream, request.sub, request.resend_from, resendLimits[request.stream].to)
                    } else if (request.resend_from_time!=null) {
                        resend(request.stream, request.sub, 99, 100)
                    } else {
                        throw 'Unknown kind of resend request: '+JSON.stringify(request)
                    }
                })
            }
        })

        afterEach(function() {
            if (validResendRequests.length > 0) {
                throw 'resend requests remaining: '+JSON.stringify(validResendRequests)
            }
        })

        it('should recognize the resend_all option', function(done) {
            // setup
            validResendRequests.push({
                stream: 'stream1', resend_all: true
            })
            resendLimits['stream1'] = {
                from: 5, to: 10
            }

            client.subscribe({
                stream: 'stream1', authKey: 'auth'
            }, function(message) {}, {
                resend_all: true
            })
            client.connect()

            client.connection.once('resent', function(response) {
                done()
            })
        })

        it('should recognize the resend_from option', function(done) {
            // setup
            validResendRequests.push({
                stream: 'stream1', resend_from: 7
            })
            resendLimits['stream1'] = {
                from: 5, to: 10
            }

            client.subscribe({
                stream: 'stream1', authKey: 'auth'
            }, function(message) {}, {
                resend_from: 7
            })
            client.connect()

            client.connection.once('resent', function() {
                done()
            })
        })

        it('should recognize the resend_last option', function(done) {
            // setup
            validResendRequests.push({
                stream: 'stream1', resend_last: 3
            })
            resendLimits['stream1'] = {
                from: 5, to: 10
            }

            client.subscribe({
                stream: 'stream1', authKey: 'auth'
            }, function(message) {}, {
                resend_last: 3
            })
            client.connect()

            client.connection.once('resent', function() {
                done()
            })
        })

        it('should recognize the resend_from_time option', function(done) {
            // setup
            const d = Date.now()
            validResendRequests.push({
                stream: 'stream1', resend_from_time: d
            })

            client.subscribe({
                stream: 'stream1', authKey: 'auth'
            }, function(message) {}, {
                resend_from_time: d
            })
            client.connect()

            client.connection.once('resent', function() {
                done()
            })
        })

        it('should recognize the resend_from_time option given as a Date object', function(done) {
            // setup
            const d = new Date()
            validResendRequests.push({
                stream: 'stream1', resend_from_time: d.getTime()
            })
            client.subscribe({
                stream: 'stream1', authKey: 'auth'
            }, function(message) {}, {
                resend_from_time: d
            })
            client.connect()

            client.connection.once('resent', function() {
                done()
            })
        })

        it('should throw if resend_from_time is in invalid format', function() {
            assert.throws(function() {
                client.subscribe({
                    stream: 'stream1', authKey: 'auth'
                }, function(message) {}, {
                    resend_from_time: 'invalid'
                })
            })
        })

        it('should not emit a resend request if there is no gap in messages', function(done) {
            client.subscribe({
                stream: 'stream1', authKey: 'auth'
            }, function(message) {
                if (message.done) {
                    done()
                }
            })
            client.connect()

            socket.once('resend', function(req) {
                throw 'Should not have made a resend request:' + JSON.stringify(req)
            })

            client.connection.once('subscribed', function() {
                const broadcastCode = 0
                socket.fakeReceive([0, broadcastCode, null, msg('stream1', 0)])
                socket.fakeReceive([0, broadcastCode, null, msg('stream1', 1, {
                    done: true
                }, undefined, 0)])
            })
        })

        it('should emit a resend request if there is a gap in messages', function(done) {
            validResendRequests.push({
                stream: 'stream1', resend_from: 1, resend_to: 9
            })

            const receivedMessages = []
            client.subscribe({
                stream: 'stream1', authKey: 'auth'
            }, function(message) {
                receivedMessages.push(message)
            })
            client.connect()

            client.connection.once('subscribed', function() {
                const broadcastCode = 0
                socket.fakeReceive([0, broadcastCode, null, msg('stream1', 0)])
                socket.fakeReceive([0, broadcastCode, null, msg('stream1', 10, {}, undefined, 9)])
            })

            client.connection.once('resent', function() {
                assert.equal(receivedMessages.length, 11)
                done()
            })
        })

        it('should include any subscription options in resend request', function(done) {
            validResendRequests.push({
                stream: 'stream1', resend_from: 1, resend_to: 9
            })

            client.subscribe({
                stream: 'stream1', authKey: 'auth'
            }, function(message) {}, {
                auth: 'foo'
            })
            client.connect()

            client.connection.once('subscribed', function() {
                const broadcastCode = 0
                socket.fakeReceive([0, broadcastCode, null, msg('stream1', 0)])
                socket.fakeReceive([0, broadcastCode, null, msg('stream1', 10, {}, undefined, 9)])
            })

            let resendRequest = null
            const defaultResendHandler = socket.resendHandler
            socket.resendHandler = function(request) {
                resendRequest = request
                defaultResendHandler(request)
            }

            client.connection.once('resent', function() {
                assert.equal(resendRequest.auth, 'foo')
                done()
            })
        })

        it('should not include stronger resend requests in gap resend request', function(done) {
            validResendRequests.push({
                stream: 'stream1', resend_all: true
            })
            validResendRequests.push({
                stream: 'stream1', resend_from: 1, resend_to: 1
            })

            client.subscribe({
                stream: 'stream1', authKey: 'auth'
            }, function(message) {}, {
                auth: 'foo', resend_all: true
            })
            client.connect()

            client.connection.once('subscribed', function() {
                const broadcastCode = 0
                socket.fakeReceive([0, broadcastCode, null, msg('stream1', 0)])
                socket.fakeReceive([0, broadcastCode, null, msg('stream1', 2, {}, undefined, 1)])
            })

            let resendRequest = null
            const defaultResendHandler = socket.resendHandler
            socket.resendHandler = function(request) {
                resendRequest = request
                defaultResendHandler(request)
            }

            client.connection.once('resent', function() {
                assert.equal(resendRequest.resend_all, undefined)
                done()
            })
        })

        it('should not emit another resend request while waiting for resend', function(done) {
            validResendRequests.push({
                stream: 'stream1', resend_from: 1, resend_to: 9
            })

            client.subscribe({
                stream: 'stream1', authKey: 'auth'
            }, function(message) {})
            client.connect()

            client.connection.once('subscribed', function() {
                const broadcastCode = 0
                socket.fakeReceive([0, broadcastCode, null, msg('stream1', 0)])
                socket.fakeReceive([0, broadcastCode, null, msg('stream1', 10, {}, undefined, 9)])
                socket.fakeReceive([0, broadcastCode, null, msg('stream1', 11, {}, undefined, 10)])
            })

            let counter = 0
            const defaultResendHandler = socket.resendHandler
            socket.resendHandler = function(request) {
                ++counter
                defaultResendHandler(request)
            }

            client.connection.once('resent', function() {
                assert.equal(counter, 1)
                done()
            })
        })

        it('should process queued messages when the resend is complete', function(done) {
            validResendRequests.push({
                stream: 'stream1', resend_from: 1, resend_to: 9
            })

            client.subscribe({
                stream: 'stream1', authKey: 'auth'
            }, function(message) {
                if (message.counter === 12) {
                    done()
                }
            })
            client.connect()

            client.connection.once('subscribed', function() {
                const broadcastCode = 0
                socket.fakeReceive([0, broadcastCode, null, msg('stream1', 0, {
                    counter: 0
                })])
                socket.fakeReceive([0, broadcastCode, null, msg('stream1', 10, {
                    counter: 10
                }, undefined, 9)])
                socket.fakeReceive([0, broadcastCode, null, msg('stream1', 11, {
                    counter: 11
                })])
                socket.fakeReceive([0, broadcastCode, null, msg('stream1', 12, {
                    counter: 12
                })])
            })
        })

        it('should ignore retransmissions in the queue', function(done) {
            validResendRequests.push({
                stream: 'stream1', resend_from: 1, resend_to: 9
            })

            client.subscribe({
                stream: 'stream1', authKey: 'auth'
            }, function(message) {
                if (message.counter === 12) {
                    done()
                }
            })
            client.connect()

            client.connection.once('subscribed', function() {
                const broadcastCode = 0
                socket.fakeReceive([0, broadcastCode, null, msg('stream1', 0, {
                    counter: 0
                })])
                socket.fakeReceive([0, broadcastCode, null, msg('stream1', 10, {
                    counter: 10
                }, undefined, 9)])
                socket.fakeReceive([0, broadcastCode, null, msg('stream1', 11, {
                    counter: 11
                }, undefined, 10)])
                socket.fakeReceive([0, broadcastCode, null, msg('stream1', 11, {
                    counter: 11
                }, undefined, 10)]) // bogus message
                socket.fakeReceive([0, broadcastCode, null, msg('stream1', 5, {
                    counter: 5
                }, undefined, 4)])    // bogus message
                socket.fakeReceive([0, broadcastCode, null, msg('stream1', 12, {
                    counter: 12
                }, undefined, 11)])
            })
        })

        it('should do another resend request if there are gaps in the queue', function(done) {
            validResendRequests.push({
                stream: 'stream1', resend_from: 1, resend_to: 9
            })
            validResendRequests.push({
                stream: 'stream1', resend_from: 11, resend_to: 11
            })

            client.subscribe({
                stream: 'stream1', authKey: 'auth'
            }, function(message) {
                if (message.counter === 12) {
                    done()
                }
            })
            client.connect()

            client.connection.once('subscribed', function() {
                const broadcastCode = 0
                socket.fakeReceive([0, broadcastCode, null, msg('stream1', 0, {
                    counter: 0
                })])
                socket.fakeReceive([0, broadcastCode, null, msg('stream1', 10, {
                    counter: 10
                }, undefined, 9)])
                socket.fakeReceive([0, broadcastCode, null, msg('stream1', 12, {
                    counter: 12
                }, undefined, 11)])
            })
        })

        describe('on reconnect', function() {
            let msgHandler

            beforeEach(function() {
                msgHandler = sinon.spy()
            })

            it('no resend', function(done) {
                client.subscribe({
                    stream: 'stream', authKey: 'auth'
                }, msgHandler)
                client.connect()

                client.connection.on('subscribed', function() {
                    const broadcastCode = 0
                    socket.fakeReceive([0, broadcastCode, null, msg('stream', 0)])
                    socket.disconnect()
                })

                client.connection.once('disconnected', function() {
                    client.connect()

                    client.connection.on('resend', function() {
                        throw 'Should not have made a resend request!'
                    })

                    client.connection.on('subscribed', function() {
                        assert.equal(msgHandler.callCount, 1)
                        done()
                    })
                })
            })

            it('resend_all', function(done) {
                validResendRequests.push({
                    stream: 'stream', resend_all: true
                })
                resendLimits['stream'] = {
                    from: 0, to: 5
                }

                client.subscribe({
                    stream: 'stream', authKey: 'auth'
                }, msgHandler, {
                    resend_all: true
                })
                client.connect()

                client.connection.on('subscribed', function(response) {
                    socket.disconnect()
                })

                client.connection.once('disconnected', function() {
                    socket.resendHandler = function(request) {
                        assert.equal(request.resend_from, 6)
                        assert.equal(request.resend_to, undefined)
                        assert.equal(msgHandler.callCount, 6)
                        socket.done = true
                        done()
                    }
                    socket.connect()
                })
            })

            it('resend_from', function(done) {
                validResendRequests.push({
                    stream: 'stream', resend_from: 3
                })
                resendLimits['stream'] = {
                    from: 0, to: 5
                }

                client.subscribe({
                    stream: 'stream', authKey: 'auth'
                }, msgHandler, {
                    resend_from: 3
                })
                client.connect()

                client.connection.on('subscribed', function(response) {
                    socket.disconnect()
                })

                client.connection.once('disconnected', function() {
                    socket.resendHandler = function(request) {
                        assert.equal(request.resend_from, 6)
                        assert.equal(request.resend_to, undefined)
                        assert.equal(msgHandler.callCount, 3)
                        socket.done = true
                        done()
                    }
                    socket.connect()
                })
            })

            it('resend_last', function(done) {
                validResendRequests.push({
                    stream: 'stream', resend_last: 1
                })
                resendLimits['stream'] = {
                    from: 0, to: 5
                }

                client.subscribe({
                    stream: 'stream', authKey: 'auth', resend_last: 1
                }, msgHandler)
                client.connect()

                client.connection.on('subscribed', function(response) {
                    socket.disconnect()
                })

                client.connection.once('disconnected', function() {
                    socket.resendHandler = function(request) {
                        assert.equal(request.resend_last, 1)
                        assert.equal(msgHandler.callCount, 1)
                        socket.done = true
                        done()
                    }
                    socket.connect()
                })
            })

            it('resend_last should accept a gap on reconnect', function(done) {
                validResendRequests.push({
                    stream: 'stream', resend_last: 1
                })
                resendLimits['stream'] = {
                    from: 0, to: 0
                }

                client.subscribe({
                    stream: 'stream', authKey: 'auth', resend_last: 1
                }, msgHandler)
                client.connect()

                client.connection.on('subscribed', function(response) {
                    socket.disconnect()
                })

                client.connection.once('disconnected', function() {
                    socket.resendHandler = function(request) {
                        assert.equal(request.resend_last, 1)

                        const unicastCode = 1
                        const resendingCode = 4
                        const resentCode = 5

                        socket.fakeReceive([0, resendingCode, null, {
                            stream: request.stream, sub: request.sub
                        }])
                        socket.fakeReceive([0, unicastCode, request.sub, msg(request.stream, 10, {}, request.sub, 9)])
                        socket.fakeReceive([0, resentCode, null, {
                            stream: request.stream, sub: request.sub
                        }])

                        assert.equal(msgHandler.callCount, 2)
                        socket.done = true
                        done()
                    }
                    socket.connect()
                })
            })
        })

    })

    describe('Subscription', function() {
        it('should trigger a subscribed event on subscribed', function(done) {
            let subscribeCount = 0

            let sub1 = client.subscribe({
                stream: 'stream1', authKey: 'auth'
            }, function(message) {})
            let sub2 = client.subscribe({
                stream: 'stream2', authKey: 'auth'
            }, function(message) {})
            let check = function(response) {
                if (++subscribeCount === 2) {
                    done()
                }
            }
            sub1.on('subscribed', check)
            sub2.on('subscribed', check)

            client.connect()
        })

        it('should trigger an unsubscribed event on unsubscribed', function(done) {
            let count = 0
            let check = function(response) {
                if (++count===2) {
                    done()
                }
            }

            let sub1 = client.subscribe({
                stream: 'stream1', authKey: 'auth'
            }, function(message) {})
            let sub2 = client.subscribe({
                stream: 'stream2', authKey: 'auth'
            }, function(message) {})
            sub1.on('unsubscribed', check)
            sub2.on('unsubscribed', check)

            client.connect()

            client.connection.on('subscribed', function() {
                if (sub1.isSubscribed() && sub2.isSubscribed()) {
                    client.unsubscribe(sub1)
                    client.unsubscribe(sub2)
                }
            })
        })
    })

    describe('client events', function() {
        it('should trigger a connected event on connect', function(done) {
            client.on('connected', done)
            client.connect()
        })

        it('should trigger a disconnected event on disconnect', function(done) {
            client.on('disconnected', done)
            client.connect()
            client.connection.once('connected', function() {
                client.disconnect()
            })
        })
    })

})

