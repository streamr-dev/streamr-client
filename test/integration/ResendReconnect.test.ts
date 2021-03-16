import { wait, waitForCondition } from 'streamr-test-utils'

import { uid, fakePrivateKey, getPublishTestMessages } from '../utils'
import { StreamrClient } from '../../src/StreamrClient'
import { Defer } from '../../src/utils'

import config from './config'
import Stream from '../../src/stream'
import { Todo } from '../../src/types'

const createClient = (opts = {}) => new StreamrClient({
    ...config.clientOptions,
    auth: {
        privateKey: fakePrivateKey(),
    },
    autoConnect: false,
    autoDisconnect: false,
    ...opts,
})

const MAX_MESSAGES = 3

describe('resend/reconnect', () => {
    let client: StreamrClient
    let stream: Stream
    let publishedMessages: [message: any, request: any][]
    let publishTestMessages: (n?: number, opts?: any) => Promise<[message: any, request: any][]>

    beforeEach(async () => {
        client = createClient()
        await client.connect()

        stream = await client.createStream({
            name: uid('resends')
        })

        publishTestMessages = getPublishTestMessages(client, {
            streamId: stream.id,
            waitForLast: true,
        })

        publishedMessages = await publishTestMessages(MAX_MESSAGES)
    }, 10 * 1000)

    afterEach(async () => {
        await client.disconnect()
    })

    describe('reconnect with resend', () => {
        let shouldDisconnect = false
        let sub: Todo
        let messages: Todo[] = []
        beforeEach(async () => {
            const done = Defer()
            messages = []
            sub = await client.subscribe({
                stream: stream.id,
                resend: {
                    last: MAX_MESSAGES,
                },
            }, (message) => {
                messages.push(message)
                if (shouldDisconnect) {
                    client.connection.socket.close()
                }
            })

            sub.once('resent', done.resolve)
            await done
            expect(messages).toEqual(publishedMessages.slice(-MAX_MESSAGES))
        }, 15000)

        it('can handle mixed resend/subscribe', async () => {
            const prevMessages = messages.slice()
            const newMessages = await publishTestMessages(3)
            expect(messages).toEqual([...prevMessages, ...newMessages])
        }, 10000)

        it('can handle reconnection after unintentional disconnection 1', async () => {
            const onClose = Defer()

            client.connection.socket.once('close', onClose.resolve)
            client.connection.socket.close()
            await onClose
            // should reconnect and get new messages
            const prevMessages = messages.slice()
            const newMessages = await publishTestMessages(3)
            await wait(6000)
            expect(messages).toEqual([...prevMessages, ...newMessages])
        }, 11000)

        it('can handle reconnection after unintentional disconnection 2', async () => {
            // should reconnect and get new messages
            const prevMessages = messages.slice()
            const newMessages = await publishTestMessages(3, {
                waitForLast: false,
            })
            const onClose = Defer()

            client.connection.socket.once('close', onClose.resolve)
            client.connection.socket.close()
            await client.connection.nextConnection()

            await wait(6000)
            expect(messages).toEqual([...prevMessages, ...newMessages])
        }, 11000)

        it('can handle reconnection after unintentional disconnection 3', async () => {
            shouldDisconnect = true
            const prevMessages = messages.slice()
            const newMessages = await publishTestMessages(MAX_MESSAGES, {
                waitForLast: false,
            })
            await waitForCondition(() => messages.length === MAX_MESSAGES * 2, 10000)
            expect(messages).toEqual([...prevMessages, ...newMessages])
        }, 21000)
    })
})
