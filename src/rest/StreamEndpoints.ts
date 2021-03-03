import { Agent as HttpAgent } from 'http'
import { Agent as HttpsAgent } from 'https'

import qs from 'qs'
import debugFactory from 'debug'

import { getEndpointUrl } from '../utils'
import { validateOptions } from '../stream/utils'
import { Stream, StreamOperation, StreamProperties } from '../stream'
import StreamPart from '../stream/StreamPart'
import { isKeyExchangeStream } from '../stream/KeyExchange'

import authFetch, { AuthFetchError } from './authFetch'
import { EthereumAddress, Todo } from '../types'
import { StreamrClient } from '../StreamrClient'
import { ErrorCode } from './ErrorCode'
// TODO change this import when streamr-client-protocol exports StreamMessage type or the enums types directly
import { ContentType, EncryptionType, SignatureType, StreamMessageType } from 'streamr-client-protocol/dist/src/protocol/message_layer/StreamMessage'

const debug = debugFactory('StreamrClient')

export interface StreamListQuery {
    name?: string
    uiChannel?: boolean
    noConfig?: boolean
    search?: string
    sortBy?: string
    order?: 'asc'|'desc'
    max?: number
    offset?: number
    grantedAccess?: boolean
    publicAccess?: boolean
    operation?: StreamOperation
}

export interface StreamValidationInfo {
    partitions: number,
    requireSignedData: boolean
    requireEncryptedData: boolean
}

export interface StreamMessageAsObject { // TODO this could be in streamr-protocol
    streamId: string
    streamPartition: number
    timestamp: number
    sequenceNumber: number
    publisherId: string
    msgChainId: string
    messageType: StreamMessageType
    contentType: ContentType
    encryptionType: EncryptionType
    groupKeyId: string|null
    content: any
    signatureType: SignatureType
    signature: string|null
}

const agentSettings = {
    keepAlive: true,
    keepAliveMsecs: 5000,
}

const agentByProtocol = {
    http: new HttpAgent(agentSettings),
    https: new HttpsAgent(agentSettings),
}

function getKeepAliveAgentForUrl(url: string) {
    if (url.startsWith('https')) {
        return agentByProtocol.https
    }

    if (url.startsWith('http')) {
        return agentByProtocol.http
    }

    throw new Error(`Unknown protocol in URL: ${url}`)
}

/** TODO the class should be annotated with at-internal, but adding the annotation hides the methods */
export class StreamEndpoints {

    client: StreamrClient

    constructor(client: StreamrClient) {
        this.client = client
    }

    async getStream(streamId: string) {
        this.client.debug('getStream %o', {
            streamId,
        })

        if (isKeyExchangeStream(streamId)) {
            return new Stream(this.client, {
                id: streamId,
                partitions: 1,
            })
        }

        const url = getEndpointUrl(this.client.options.restUrl, 'streams', streamId)
        const json = await authFetch<StreamProperties>(url, this.client.session)
        return new Stream(this.client, json)
    }

    async listStreams(query: StreamListQuery = {}): Promise<Stream[]> {
        this.client.debug('listStreams %o', {
            query,
        })
        const url = getEndpointUrl(this.client.options.restUrl, 'streams') + '?' + qs.stringify(query)
        const json = await authFetch<StreamProperties[]>(url, this.client.session)
        return json ? json.map((stream: StreamProperties) => new Stream(this.client, stream)) : []
    }

    async getStreamByName(name: string) {
        this.client.debug('getStreamByName %o', {
            name,
        })
        const json = await this.listStreams({
            name,
            // @ts-expect-error
            public: false,
        })
        return json[0] ? new Stream(this.client, json[0]) : Promise.reject(new AuthFetchError('', undefined, undefined, ErrorCode.NOT_FOUND))
    }

    async createStream(props?: StreamProperties) {
        this.client.debug('createStream %o', {
            props,
        })

        const json = await authFetch<StreamProperties>(
            getEndpointUrl(this.client.options.restUrl, 'streams'),
            this.client.session,
            {
                method: 'POST',
                body: JSON.stringify(props),
            },
        )
        return new Stream(this.client, json)
    }

    async getOrCreateStream(props: { id?: string, name?: string }) {
        this.client.debug('getOrCreateStream %o', {
            props,
        })
        // Try looking up the stream by id or name, whichever is defined
        try {
            if (props.id) {
                const stream = await this.getStream(props.id)
                return stream
            }
            const stream = await this.getStreamByName(props.name!)
            return stream
        } catch (err) {
            const isNotFoundError = (err instanceof AuthFetchError) && (err.errorCode === ErrorCode.NOT_FOUND)
            if (!isNotFoundError) {
                throw err
            }
        }

        const stream = await this.createStream(props)
        debug('Created stream: %s (%s)', props.name, stream.id)
        return stream
    }

    async getStreamPublishers(streamId: string) {
        this.client.debug('getStreamPublishers %o', {
            streamId,
        })
        const url = getEndpointUrl(this.client.options.restUrl, 'streams', streamId, 'publishers')
        const json = await authFetch<{ addresses: string[]}>(url, this.client.session)
        return json.addresses.map((a: string) => a.toLowerCase())
    }

    async isStreamPublisher(streamId: string, ethAddress: string) {
        this.client.debug('isStreamPublisher %o', {
            streamId,
            ethAddress,
        })
        const url = getEndpointUrl(this.client.options.restUrl, 'streams', streamId, 'publisher', ethAddress)
        try {
            await authFetch(url, this.client.session)
            return true
        } catch (e) {
            this.client.debug(e)
            if (e.response && e.response.status === 404) {
                return false
            }
            throw e
        }
    }

    async getStreamSubscribers(streamId: string) {
        this.client.debug('getStreamSubscribers %o', {
            streamId,
        })
        const url = getEndpointUrl(this.client.options.restUrl, 'streams', streamId, 'subscribers')
        const json = await authFetch<{ addresses: string[] }>(url, this.client.session)
        return json.addresses.map((a: string) => a.toLowerCase())
    }

    async isStreamSubscriber(streamId: string, ethAddress: string) {
        this.client.debug('isStreamSubscriber %o', {
            streamId,
            ethAddress,
        })
        const url = getEndpointUrl(this.client.options.restUrl, 'streams', streamId, 'subscriber', ethAddress)
        try {
            await authFetch(url, this.client.session)
            return true
        } catch (e) {
            if (e.response && e.response.status === 404) {
                return false
            }
            throw e
        }
    }

    async getStreamValidationInfo(streamId: string) {
        this.client.debug('getStreamValidationInfo %o', {
            streamId,
        })
        const url = getEndpointUrl(this.client.options.restUrl, 'streams', streamId, 'validation')
        const json = await authFetch<StreamValidationInfo>(url, this.client.session)
        return json
    }

    async getStreamLast(streamObjectOrId: Stream|string): Promise<StreamMessageAsObject> {
        const { streamId, streamPartition = 0, count = 1 } = validateOptions(streamObjectOrId)
        this.client.debug('getStreamLast %o', {
            streamId,
            streamPartition,
            count,
        })

        const url = (
            getEndpointUrl(this.client.options.restUrl, 'streams', streamId, 'data', 'partitions', streamPartition, 'last')
            + `?${qs.stringify({ count })}`
        )

        const json = await authFetch<Todo>(url, this.client.session)
        return json
    }

    async getStreamPartsByStorageNode(address: EthereumAddress) {
        type ItemType = { id: string, partitions: number}
        const json = await authFetch<ItemType[]>(getEndpointUrl(this.client.options.restUrl, 'storageNodes', address, 'streams'), this.client.session)
        let result: StreamPart[] = []
        json.forEach((stream: ItemType) => {
            result = result.concat(StreamPart.fromStream(stream))
        })
        return result
    }

    async publishHttp(streamObjectOrId: Stream|string, data: Todo, requestOptions: Todo = {}, keepAlive: boolean = true) {
        let streamId
        if (streamObjectOrId instanceof Stream) {
            streamId = streamObjectOrId.id
        } else {
            streamId = streamObjectOrId
        }
        this.client.debug('publishHttp %o', {
            streamId, data,
        })

        // Send data to the stream
        await authFetch(
            getEndpointUrl(this.client.options.restUrl, 'streams', streamId, 'data'),
            this.client.session,
            {
                ...requestOptions,
                method: 'POST',
                body: JSON.stringify(data),
                agent: keepAlive ? getKeepAliveAgentForUrl(this.client.options.restUrl!) : undefined,
            },
        )
    }
}
