import assert from 'assert'
import fetch from 'node-fetch'
import { MessageLayer } from 'streamr-client-protocol'
import { ethers } from 'ethers'
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
            expect(client.isConnected()).toBeFalsy()
        })

        it('does not error if disconnecting', async (done) => {
            const client = createClient()
            client.connection.once('disconnecting', async () => {
                await client.ensureDisconnected()
                expect(client.isConnected()).toBeFalsy()
                done()
            })
            await client.connect()
            await client.disconnect()
        })

        it('disconnects if connecting', async (done) => {
            const client = createClient()
            client.connection.once('connecting', async () => {
                await client.ensureDisconnected()
                expect(client.isConnected()).toBeFalsy()
                done()
            })
            await client.connect()
        })
    })

    it('can disconnect before connected', async (done) => {
        const client = createClient()
        client.once('error', done)
        client.connect()
        await client.disconnect()
        done()
    })

    it('can reconnect after disconnect', (done) => {
        const client = createClient()
        client.on('error', done)
        client.connect()
        client.once('connected', () => {
            client.disconnect()
        })
        client.once('disconnected', () => {
            client.connect()
            client.once('connected', () => {
                client.disconnect()
                done()
            })
        })
    })

    describe('connect during disconnect', () => {
        let client
        async function teardown() {
            if (client) {
                if (client.connection.state !== 'disconnected') {
                    await client.disconnect()
                }
                client = undefined
            }
        }

        beforeEach(async () => {
            await teardown()
        })

        afterEach(async () => {
            await teardown()
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

    const ensureConnected = () => new Promise((resolve) => {
        client.on('connected', resolve)
        client.connect()
    })

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
        await ensureConnected()
        stream = await createStream()
    })

    afterEach(() => {
        if (client && client.isConnected()) {
            return client.disconnect()
        }
        return Promise.resolve()
    })

    describe('Pub/Sub', () => {
        it('client.publish', () => client.publish(stream.id, {
            test: 'client.publish',
        }), TIMEOUT)

        it('Stream.publish', () => stream.publish({
            test: 'Stream.publish',
        }), TIMEOUT)

        it('client.publish with Stream object as arg', () => {
            client.publish(stream, {
                test: 'client.publish.Stream.object',
            })
        }, TIMEOUT)

        it('client.subscribe with resend from', (done) => {
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
