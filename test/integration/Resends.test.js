import { ethers } from 'ethers'
import uuid from 'uuid/v4'

import StreamrClient from '../../src'

import config from './config'

const { wait, waitForCondition } = require('streamr-test-utils')

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

const MAX_MESSAGES = 10
const TEST_REPEATS = 10

describe('StreamrClient resends', () => {
    describe('resend', () => {
        let client
        let stream
        let publishedMessages

        beforeEach(async () => {
            client = createClient()
            await client.ensureConnected()

            publishedMessages = []

            stream = await client.createStream({
                name: uuid(),
            })

            for (let i = 0; i < MAX_MESSAGES; i++) {
                const message = {
                    msg: `message${i}`,
                }

                // eslint-disable-next-line no-await-in-loop
                await client.publish(stream.id, message)
                publishedMessages.push(message)
            }

            await wait(3000) // wait for messages to (hopefully) land in storage
        }, 10 * 1000)

        afterEach(async () => {
            await client.ensureDisconnected()
        })

        it('resend last using resend function', async (done) => {
            for (let i = 0; i < TEST_REPEATS; i++) {
                const receivedMessages = []

                // eslint-disable-next-line no-await-in-loop
                const sub = await client.resend(
                    {
                        stream: stream.id,
                        resend: {
                            last: MAX_MESSAGES,
                        },
                    },
                    (message) => {
                        receivedMessages.push(message)
                    },
                )

                // eslint-disable-next-line no-loop-func
                sub.once('resent', () => {
                    expect(receivedMessages).toStrictEqual(publishedMessages)
                })

                // eslint-disable-next-line no-await-in-loop
                await waitForCondition(() => receivedMessages.length === MAX_MESSAGES)
            }
            done()
        }, 50000)

        it('resend last using subscribe function', async (done) => {
            for (let i = 0; i < TEST_REPEATS; i++) {
                const receivedMessages = []

                // eslint-disable-next-line no-await-in-loop
                const sub = client.subscribe(
                    {
                        stream: stream.id,
                        resend: {
                            last: MAX_MESSAGES,
                        },
                    },
                    (message) => {
                        receivedMessages.push(message)
                    },
                )

                // eslint-disable-next-line no-loop-func
                sub.once('resent', () => {
                    expect(receivedMessages).toStrictEqual(publishedMessages)
                })

                // eslint-disable-next-line no-await-in-loop
                await waitForCondition(() => receivedMessages.length === MAX_MESSAGES)
            }
            done()
        }, 50000)

        it('resend last using subscribe and publish messages after resend', async (done) => {
            const receivedMessages = []

            client.subscribe({
                stream: stream.id,
                resend: {
                    last: MAX_MESSAGES,
                },
            }, (message) => {
                receivedMessages.push(message)
            })

            // wait for resend MAX_MESSAGES
            await waitForCondition(() => receivedMessages.length === MAX_MESSAGES)
            expect(receivedMessages).toStrictEqual(publishedMessages)

            // publish after resend, realtime subscription messages
            for (let i = MAX_MESSAGES; i < MAX_MESSAGES * 2; i++) {
                const message = {
                    msg: `message${i}`,
                }

                // eslint-disable-next-line no-await-in-loop
                await client.publish(stream.id, message)
                publishedMessages.push(message)
            }

            await waitForCondition(() => receivedMessages.length === MAX_MESSAGES * 2)
            expect(receivedMessages).toStrictEqual(publishedMessages)
            done()
        }, 30000)

        it('resend last using subscribe and publish realtime messages', async () => {
            const receivedMessages = []

            const sub = client.subscribe({
                stream: stream.id,
                resend: {
                    last: MAX_MESSAGES,
                },
            }, (message) => {
                receivedMessages.push(message)
            })

            sub.on('subscribed', async () => {
                for (let i = MAX_MESSAGES; i < MAX_MESSAGES * 2; i++) {
                    const message = {
                        msg: `message${i}`,
                    }

                    // eslint-disable-next-line no-await-in-loop
                    await client.publish(stream.id, message)
                    publishedMessages.push(message)
                }
            })

            await waitForCondition(() => receivedMessages.length === MAX_MESSAGES * 2)
            expect(receivedMessages).toStrictEqual(publishedMessages)
        }, 30000)
    })
})
