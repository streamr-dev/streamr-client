import { StreamrClient } from '../../src/StreamrClient'
import { uid, fakePrivateKey, getPublishTestMessages } from '../utils'

import config from './config'

const createClient = (opts = {}) => new StreamrClient({
    ...config.clientOptions,
    auth: {
        privateKey: fakePrivateKey(),
    },
    autoConnect: false,
    autoDisconnect: false,
    ...opts,
})

describe('Stream', () => {
    let client
    let stream

    beforeEach(async () => {
        client = createClient()
        await client.connect()

        stream = await client.createStream({
            name: uid('stream-integration-test')
        })
        await stream.addToStorageNode(config.clientOptions.storageNode.address)
    })

    afterEach(async () => {
        await client.disconnect()
    })

    describe('detectFields()', () => {
        it('does detect primitive types', async () => {
            const msg = {
                number: 123,
                boolean: true,
                object: {
                    k: 1,
                    v: 2,
                },
                array: [1, 2, 3],
                string: 'test',
            }
            const publishTestMessages = getPublishTestMessages(client, {
                streamId: stream.id,
                waitForLast: true,
                createMessage: () => msg,
            })
            await publishTestMessages(1)

            expect(stream.config.fields).toEqual([])
            await stream.detectFields()
            const expectedFields = [
                {
                    name: 'number',
                    type: 'number',
                },
                {
                    name: 'boolean',
                    type: 'boolean',
                },
                {
                    name: 'object',
                    type: 'map',
                },
                {
                    name: 'array',
                    type: 'list',
                },
                {
                    name: 'string',
                    type: 'string',
                },
            ]

            expect(stream.config.fields).toEqual(expectedFields)
            const loadedStream = await client.getStream(stream.id)
            expect(loadedStream.config.fields).toEqual(expectedFields)
        })

        it('skips unsupported types', async () => {
            const msg = {
                null: null,
                empty: {},
                func: () => null,
                nonexistent: undefined,
                symbol: Symbol('test'),
                // TODO: bigint: 10n,
            }
            const publishTestMessages = getPublishTestMessages(client, {
                streamId: stream.id,
                waitForLast: true,
                createMessage: () => msg,
            })
            await publishTestMessages(1)

            expect(stream.config.fields).toEqual([])
            await stream.detectFields()
            const expectedFields = [
                {
                    name: 'null',
                    type: 'map',
                },
                {
                    name: 'empty',
                    type: 'map',
                },
            ]

            expect(stream.config.fields).toEqual(expectedFields)

            const loadedStream = await client.getStream(stream.id)
            expect(loadedStream.config.fields).toEqual(expectedFields)
        })
    })
})
