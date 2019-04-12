import assert from 'assert'
import fetch from 'node-fetch'
import { MessageLayer } from 'streamr-client-protocol'
import { ethers } from 'ethers'
import uniqueId from 'lodash/uniqueId'

import StreamrClient from '../../src'
import config from './config'

const { StreamMessage } = MessageLayer

const createClient = (opts = {}) => new StreamrClient({
    url: config.websocketUrl,
    restUrl: config.restUrl,
    auth: {
        privateKey: ethers.Wallet.createRandom().privateKey,
    },
    autoConnect: false,
    autoDisconnect: false,
    ...opts,
})

describe('StreamrClient Connection', () => {
    describe('bad config.url', () => {
        it('emits error without autoconnect', async (done) => {
            const client = createClient({
                url: 'asdasd',
                autoConnect: false,
                autoDisconnect: false,
            })
            client.once('error', async (error) => {
                expect(error).toBeTruthy()
                done()
            })
            await client.connect().catch(async (error) => {
                expect(error).toBeTruthy()
            })
        })

        it('rejects on connect without autoconnect', async (done) => {
            const client = createClient({
                url: 'asdasd',
                autoConnect: false,
                autoDisconnect: false,
            })

            await client.connect().catch(async (error) => {
                expect(error).toBeTruthy()
                done()
            })
        })

        it('emits error with autoconnect after first call that triggers connect()', async (done) => {
            const client = createClient({
                url: 'asdasd',
                autoConnect: true,
                autoDisconnect: true,
            })
            client.once('error', async (error) => {
                expect(error).toBeTruthy()
                done()
            })
            await client.publish('stream-id', {}).catch(async (error) => {
                expect(error).toBeTruthy()
                done()
            })
        })
    })

    describe('bad config.restUrl', () => {
        it('emits error without autoconnect', async (done) => {
            const client = createClient({
                restUrl: 'asdasd',
                autoConnect: false,
                autoDisconnect: false,
            })
            client.once('error', async (error) => {
                expect(error).toBeTruthy()
                done()
            })
        })

        it('emits error with autoconnect', (done) => {
            const client = createClient({
                restUrl: 'asdasd',
                autoConnect: true,
                autoDisconnect: true,
            })
            client.once('error', async (error) => {
                expect(error).toBeTruthy()
                done()
            })
        })
    })

    it('can disconnect before connected', async (done) => {
        const client = createClient()
        client.once('error', done)
        client.connect()
        await client.disconnect()
        done()
    })

    describe('ensureConnected', () => {
        it('connects the client', async () => {
            const client = createClient()
            await client.ensureConnected()
            expect(client.isConnected()).toBeTruthy()
            // no error if already connected
            await client.ensureConnected()
            expect(client.isConnected()).toBeTruthy()
            await client.disconnect()
        })

        it('does not error if connecting', async (done) => {
            const client = createClient()
            client.connection.once('connecting', async () => {
                await client.ensureConnected()
                expect(client.isConnected()).toBeTruthy()
                await client.disconnect()
                done()
            })

            await client.connect()
        })

        it('connects if disconnecting', async (done) => {
            const client = createClient()
            client.connection.once('disconnecting', async () => {
                await client.ensureConnected()
                expect(client.isConnected()).toBeTruthy()
                await client.disconnect()
                done()
            })

            await client.connect()
            await client.disconnect()
        })
    })

    describe('ensureDisconnected', () => {
        it('disconnects the client', async () => {
            const client = createClient()
            // no error if already disconnected
            await client.ensureDisconnected()
            await client.connect()
            await client.ensureDisconnected()
            expect(client.isDisconnected()).toBeTruthy()
        })

        it('does not error if disconnecting', async (done) => {
            const client = createClient()
            client.connection.once('disconnecting', async () => {
                await client.ensureDisconnected()
                expect(client.isDisconnected()).toBeTruthy()
                done()
            })
            await client.connect()
            await client.disconnect()
        })

        it('disconnects if connecting', async (done) => {
            const client = createClient()
            client.connection.once('connecting', async () => {
                await client.ensureDisconnected()
                expect(client.isDisconnected()).toBeTruthy()
                done()
            })
            await client.connect()
        })
    })

    describe('connect during disconnect', () => {
        let client
        async function teardown() {
            if (client) {
                client.removeAllListeners('error')
                await client.ensureDisconnected()
                client = undefined
            }
        }

        beforeEach(async () => {
            await teardown()
        })

        afterEach(async () => {
            await teardown()
        })

        it('can reconnect after disconnect', (done) => {
            client = createClient()
            client.once('error', done)
            client.connect()
            client.once('connected', () => {
                client.disconnect()
            })
            client.once('disconnected', () => {
                client.connect()
                client.once('connected', async () => {
                    await client.disconnect()
                    done()
                })
            })
        })

        it('can disconnect before connected', async (done) => {
            client = createClient()
            client.once('error', done)
            client.connect()
            await client.disconnect()
            done()
        })

        it('can connect', async (done) => {
            client = createClient()
            await client.connect()

            client.connection.once('disconnecting', async () => {
                await client.connect()
                await client.disconnect()
                done()
            })

            client.disconnect()
        }, 5000)

        it('will resolve original disconnect', async (done) => {
            client = createClient()

            await client.connect()

            client.connection.once('disconnecting', async () => {
                await client.connect()
            })
            await client.disconnect()
            done() // ok if it ever gets here
        }, 5000)

        it('has connection state transitions in correct order', async (done) => {
            client = createClient()
            const connectionEventSpy = jest.spyOn(client.connection, 'emit')

            await client.connect()

            client.connection.once('disconnecting', async () => {
                await client.connect()
                const eventNames = connectionEventSpy.mock.calls.map(([eventName]) => eventName)
                expect(eventNames).toEqual([
                    'connecting',
                    'connected',
                    'disconnecting',
                    'disconnected', // should disconnect before re-connecting
                    'connecting',
                    'connected',
                ])
                done()
            })
            await client.disconnect()
        }, 5000)

        it('does not try to reconnect', async (done) => {
            client = createClient()

            await client.connect()

            client.connection.once('disconnecting', async () => {
                await client.connect()

                // should not try connecting after disconnect (or any other reason)
                const onConnecting = () => {
                    done(new Error('should not be connecting'))
                }
                client.once('connecting', onConnecting)

                client.disconnect()
                // wait for possible reconnections
                setTimeout(() => {
                    client.off('connecting', onConnecting)
                    expect(client.isConnected()).toBe(false)
                    done()
                }, 2000)
            })
            client.disconnect()
        }, 6000)
    })

    describe('publish/subscribe connection handling', () => {
        let client
        async function teardown() {
            if (!client) { return }
            client.removeAllListeners('error')
            await client.ensureDisconnected()
            client = undefined
        }

        beforeEach(async () => {
            await teardown()
        })

        afterEach(async () => {
            await teardown()
        })
        describe('publish', () => {
            it('will connect if not connected if autoconnect set', async (done) => {
                client = createClient({
                    autoConnect: true,
                    autoDisconnect: true,
                })

                client.once('error', done)

                const stream = await client.createStream({
                    name: uniqueId(),
                })
                await client.ensureDisconnected()

                const message = {
                    id2: uniqueId(),
                }
                client.once('connected', () => {
                    // wait in case of delayed errors
                    setTimeout(() => done(), 500)
                })
                await client.publish(stream.id, message)
            })

            it('will connect if disconnecting & autoconnect set', async (done) => {
                client = createClient({
                    autoConnect: true,
                    autoDisconnect: true,
                })

                client.once('error', done)
                await client.ensureConnected()
                const stream = await client.createStream({
                    name: uniqueId(),
                })

                const message = {
                    id1: uniqueId(),
                }
                const p = client.publish(stream.id, message)
                setTimeout(() => {
                    client.disconnect() // start async disconnect after publish started
                })
                await p
                // wait in case of delayed errors
                setTimeout(() => done(), 500)
            })

            it('will error if disconnecting & autoconnect not set', async (done) => {
                client = createClient({
                    autoConnect: false,
                    autoDisconnect: false,
                })

                client.once('error', done)
                await client.ensureConnected()
                const stream = await client.createStream({
                    name: uniqueId(),
                })

                const message = {
                    id1: uniqueId(),
                }

                client.publish(stream.id, message).catch((err) => {
                    expect(err).toBeTruthy()
                    done()
                })

                setTimeout(() => {
                    client.disconnect() // start async disconnect after publish started
                })
            })
        })
        describe('subscribe', () => {
            it('does not error if disconnect after subscribe', async (done) => {
                client = createClient({
                    autoConnect: true,
                    autoDisconnect: true,
                })

                client.once('error', done)
                await client.ensureConnected()
                const stream = await client.createStream({
                    name: uniqueId(),
                })

                const sub = client.subscribe({
                    stream: stream.id,
                    resend: {
                        from: {
                            timestamp: 0,
                        },
                    },
                }, () => {})
                sub.once('subscribed', async () => {
                    await client.disconnect()
                    // wait in case of delayed errors
                    setTimeout(() => done(), 500)
                })
            })
        })
    })
})

describe('StreamrClient', () => {
    let client
    let stream

    // These tests will take time, especially on Travis
    const TIMEOUT = 15 * 1000

    const createStream = async () => {
        const name = `StreamrClient-integration-${Date.now()}`
        assert(client.isConnected())

        const s = await client.createStream({
            name,
            requireSignedData: true,
        })

        assert(s.id)
        assert.equal(s.name, name)
        assert.strictEqual(s.requireSignedData, true)
        return s
    }

    beforeEach(async () => {
        try {
            await Promise.all([
                fetch(config.restUrl),
                fetch(config.websocketUrl.replace('ws://', 'http://')),
            ])
        } catch (e) {
            if (e.errno === 'ENOTFOUND' || e.errno === 'ECONNREFUSED') {
                throw new Error('Integration testing requires that engine-and-editor ' +
                    'and data-api ("entire stack") are running in the background. ' +
                    'Instructions: https://github.com/streamr-dev/streamr-docker-dev#running')
            } else {
                throw e
            }
        }

        client = createClient()
        await client.ensureConnected()
        stream = await createStream()
    })

    afterEach(async () => {
        if (client) {
            client.removeAllListeners('error')
            await client.ensureDisconnected()
        }
    })

    describe('Pub/Sub', () => {
        it('client.publish', async (done) => {
            client.once('error', done)
            await client.publish(stream.id, {
                test: 'client.publish',
            })
            setTimeout(() => done(), TIMEOUT * 0.8)
        }, TIMEOUT)

        it('Stream.publish', async (done) => {
            client.once('error', done)
            await stream.publish({
                test: 'Stream.publish',
            })
            setTimeout(() => done(), TIMEOUT * 0.8)
        }, TIMEOUT)

        it('client.publish with Stream object as arg', async (done) => {
            client.once('error', done)
            await client.publish(stream, {
                test: 'client.publish.Stream.object',
            })
            setTimeout(() => done(), TIMEOUT * 0.8)
        }, TIMEOUT)

        it('client.subscribe with resend from', (done) => {
            client.once('error', done)
            // Publish message
            client.publish(stream.id, {
                test: 'client.subscribe with resend',
            })

            // Check that we're not subscribed yet
            assert.strictEqual(client.subscribedStreams[stream.id], undefined)

            // Add delay: this test needs some time to allow the message to be written to Cassandra
            setTimeout(() => {
                const sub = client.subscribe({
                    stream: stream.id,
                    resend: {
                        from: {
                            timestamp: 0,
                        },
                    },
                }, async (parsedContent, streamMessage) => {
                    // Check message content
                    assert.strictEqual(parsedContent.test, 'client.subscribe with resend')

                    // Check signature stuff
                    const subStream = client.subscribedStreams[stream.id]
                    const publishers = await subStream.getPublishers()
                    const requireVerification = await subStream.getVerifySignatures()
                    assert.strictEqual(requireVerification, true)
                    assert.deepStrictEqual(publishers, [client.signer.address.toLowerCase()])
                    assert.strictEqual(streamMessage.signatureType, StreamMessage.SIGNATURE_TYPES.ETH)
                    assert(streamMessage.getPublisherId())
                    assert(streamMessage.signature)

                    // All good, unsubscribe
                    client.unsubscribe(sub)
                    sub.on('unsubscribed', () => {
                        assert.strictEqual(client.subscribedStreams[stream.id], undefined)
                        done()
                    })
                })
            }, 10000)
        }, TIMEOUT)

        it('client.subscribe with resend last', (done) => {
            client.once('error', done)
            // Publish message
            client.publish(stream.id, {
                test: 'client.subscribe with resend',
            })

            // Check that we're not subscribed yet
            assert.strictEqual(client.subscribedStreams[stream.id], undefined)

            // Add delay: this test needs some time to allow the message to be written to Cassandra
            setTimeout(() => {
                const sub = client.subscribe({
                    stream: stream.id,
                    resend: {
                        last: 1,
                    },
                }, async (parsedContent, streamMessage) => {
                    // Check message content
                    assert.strictEqual(parsedContent.test, 'client.subscribe with resend')

                    // Check signature stuff
                    const subStream = client.subscribedStreams[stream.id]
                    const publishers = await subStream.getPublishers()
                    const requireVerification = await subStream.getVerifySignatures()
                    assert.strictEqual(requireVerification, true)
                    assert.deepStrictEqual(publishers, [client.signer.address.toLowerCase()])
                    assert.strictEqual(streamMessage.signatureType, StreamMessage.SIGNATURE_TYPES.ETH)
                    assert(streamMessage.getPublisherId())
                    assert(streamMessage.signature)

                    // All good, unsubscribe
                    client.unsubscribe(sub)
                    sub.on('unsubscribed', () => {
                        assert.strictEqual(client.subscribedStreams[stream.id], undefined)
                        done()
                    })
                })
            }, 10000)
        }, TIMEOUT)

        it('client.subscribe (realtime)', (done) => {
            client.once('error', done)
            const id = Date.now()
            const sub = client.subscribe({
                stream: stream.id,
            }, (parsedContent, streamMessage) => {
                assert.equal(parsedContent.id, id)

                // Check signature stuff
                assert.strictEqual(streamMessage.signatureType, StreamMessage.SIGNATURE_TYPES.ETH)
                assert(streamMessage.getPublisherId())
                assert(streamMessage.signature)

                // All good, unsubscribe
                client.unsubscribe(sub)
                sub.on('unsubscribed', () => {
                    done()
                })
            })

            // Publish after subscribed
            sub.on('subscribed', () => {
                stream.publish({
                    id,
                })
            })
        })
    })
})
