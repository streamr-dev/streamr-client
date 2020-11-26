import assert from 'assert'

import { ethers } from 'ethers'
import { wait } from 'streamr-test-utils'

import StreamrClient from '../../src'
import { uid } from '../utils'

import config from './config'

/**
 * These tests should be run in sequential order!
 */

function TestStreamEndpoints(getName) {
    let client
    let wallet
    let createdStream

    const createClient = (opts = {}) => new StreamrClient({
        autoConnect: false,
        autoDisconnect: false,
        ...config.clientOptions,
        ...opts,
    })

    beforeAll(() => {
        wallet = ethers.Wallet.createRandom()
        client = createClient({
            auth: {
                privateKey: wallet.privateKey,
            },
        })
    })

    beforeAll(async () => {
        createdStream = await client.createStream({
            name: getName(),
            requireSignedData: true,
            requireEncryptedData: false,
        })
    })

    describe('createStream', () => {
        it('creates a stream with correct values', async () => {
            const name = getName()
            const stream = await client.createStream({
                name,
                requireSignedData: true,
                requireEncryptedData: true,
            })
            assert(stream.id)
            assert.strictEqual(stream.name, name)
            assert.strictEqual(stream.requireSignedData, true)
            assert.strictEqual(stream.requireEncryptedData, true)
        })
    })

    describe('getStream', () => {
        it('get an existing Stream', async () => {
            const stream = await client.createStream()
            const existingStream = await client.getStream(stream.id)
            assert.strictEqual(existingStream.id, stream.id)
        })

        it('get a non-existing Stream', async () => {
            const id = `${wallet.address}/StreamEndpoints-integration-nonexisting-${Date.now()}`
            const stream = await client.getStream(id)
            assert.strictEqual(stream, undefined)
        })
    })

    describe('getOrCreate', () => {
        it('getOrCreate an existing Stream', async () => {
            const existingStream = await client.getOrCreateStream({
                name: createdStream.name,
            })
            assert.strictEqual(existingStream.id, createdStream.id)
            assert.strictEqual(existingStream.name, createdStream.name)
        })

        it('getOrCreate a new Stream by name', async () => {
            const newName = uid('stream')
            const newStream = await client.getOrCreateStream({
                name: newName,
            })

            assert.strictEqual(newStream.name, newName)
        })

        it('getOrCreate a new Stream by id', async () => {
            const newId = `${wallet.address}/StreamEndpoints-integration-${Date.now()}`
            const newStream = await client.getOrCreateStream({
                id: newId,
            })

            assert.strictEqual(newStream.id, newId)
        })
    })

    describe('listStreams', () => {
        it('filters by given criteria (match)', async () => {
            const result = await client.listStreams({
                name: createdStream.name,
            })
            assert.strictEqual(result.length, 1)
            assert.strictEqual(result[0].id, createdStream.id)
        })

        it('filters by given criteria (no  match)', async () => {
            const result = await client.listStreams({
                name: `non-existent-${Date.now()}`,
            })
            assert.strictEqual(result.length, 0)
        })
    })

    describe('getStreamLast', () => {
        it('does not error', async () => {
            const result = await client.getStreamLast(createdStream.id)
            expect(result).toEqual([])
        })
    })

    describe('getStreamPublishers', () => {
        it('retrieves a list of publishers', async () => {
            const publishers = await client.getStreamPublishers(createdStream.id)
            assert.deepStrictEqual(publishers, [client.publisher.signer.address.toLowerCase()])
        })
    })

    describe('isStreamPublisher', () => {
        it('returns true for valid publishers', async () => {
            const valid = await client.isStreamPublisher(createdStream.id, client.publisher.signer.address.toLowerCase())
            assert(valid)
        })
        it('returns false for invalid publishers', async () => {
            const valid = await client.isStreamPublisher(createdStream.id, 'some-wrong-address')
            assert(!valid)
        })
    })

    describe('getStreamSubscribers', () => {
        it('retrieves a list of publishers', async () => {
            const subscribers = await client.getStreamSubscribers(createdStream.id)
            assert.deepStrictEqual(subscribers, [client.publisher.signer.address.toLowerCase()])
        })
    })

    describe('isStreamSubscriber', () => {
        it('returns true for valid subscribers', async () => {
            const valid = await client.isStreamSubscriber(createdStream.id, client.publisher.signer.address.toLowerCase())
            assert(valid)
        })
        it('returns false for invalid subscribers', async () => {
            const valid = await client.isStreamSubscriber(createdStream.id, 'some-wrong-address')
            assert(!valid)
        })
    })

    describe('getStreamValidationInfo', () => {
        it('returns an object with expected fields', async () => {
            const result = await client.getStreamValidationInfo(createdStream.id)
            assert(result.partitions > 0)
            assert(result.requireSignedData === true)
            assert(result.requireEncryptedData === false)
        })
    })

    describe('Stream.update', () => {
        it('can change stream name', async () => {
            createdStream.name = 'New name'
            await createdStream.update()
        })
    })

    describe.skip('Stream configuration', () => {
        it('Stream.detectFields', async () => {
            await client.connect()
            await client.publish(createdStream.id, {
                foo: 'bar',
                count: 0,
            })
            // Need time to propagate to storage
            await wait(10000)
            const stream = await createdStream.detectFields()
            assert.deepStrictEqual(
                stream.config.fields,
                [
                    {
                        name: 'foo',
                        type: 'string',
                    },
                    {
                        name: 'count',
                        type: 'number',
                    },
                ],
            )
            await client.disconnect()
        }, 15000)
    })

    describe('Stream permissions', () => {
        it('Stream.getPermissions', async () => {
            const permissions = await createdStream.getPermissions()
            // get, edit, delete, subscribe, publish, share
            assert.strictEqual(permissions.length, 6, `Unexpected number of permissions: ${JSON.stringify(permissions)}`)
        })

        it('Stream.hasPermission', async () => {
            assert(await createdStream.hasPermission('stream_share', wallet.address))
        })

        it('Stream.grantPermission', async () => {
            await createdStream.grantPermission('stream_subscribe', null) // public read
            assert(await createdStream.hasPermission('stream_subscribe', null))
        })

        it('Stream.revokePermission', async () => {
            const publicRead = await createdStream.hasPermission('stream_subscribe', null)
            await createdStream.revokePermission(publicRead.id)
            assert(!(await createdStream.hasPermission('stream_subscribe', null)))
        })
    })

    describe('Stream deletion', () => {
        it('Stream.delete', async () => {
            await createdStream.delete()
            assert.strictEqual(await client.getStream(createdStream.id), undefined)
        })
    })
}

describe('StreamEndpoints', () => {
    describe('using normal name', () => {
        TestStreamEndpoints(() => uid('test-stream'))
    })

    describe('using name with slashes', () => {
        TestStreamEndpoints(() => uid('test-stream/slashes'))
    })
})
