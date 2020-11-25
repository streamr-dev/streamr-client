import { Errors } from 'streamr-client-protocol'

import { counterId } from '../utils'
import { pipeline } from '../utils/iterators'

import { validateOptions } from './api'
import Validator from './Validator'
import messageStream from './messageStream'
import OrderMessages from './OrderMessages'

const { ValidationError } = Errors

export { SignatureRequiredError } from './Validator'

async function collect(src) {
    const msgs = []
    for await (const msg of src) {
        msgs.push(msg.getParsedContent())
    }

    return msgs
}

export default function MessagePipeline(client, opts = {}, onFinally = () => {}) {
    const options = validateOptions(opts)
    const { key, afterSteps = [], onError = (err) => { throw err } } = options
    const id = counterId('MessagePipeline') + key
    /* eslint-disable object-curly-newline */
    const {
        validate = Validator(client, options),
        msgStream = messageStream(client.connection, options),
        orderingUtil = OrderMessages(client, options)
    } = options
    /* eslint-enable object-curly-newline */
    const p = pipeline([
        msgStream,
        async function* getStreamMessage(src) {
            for await (const { streamMessage } of src) {
                yield streamMessage
            }
        },
        async function* Validate(src) {
            for await (const streamMessage of src) {
                try {
                    await validate(streamMessage)
                } catch (err) {
                    if (err instanceof ValidationError) {
                        orderingUtil.markMessageExplicitly(streamMessage)
                        await onError(err)
                        // eslint-disable-next-line no-continue
                    } else {
                        throw err
                    }
                }

                yield streamMessage
            }
        },
        async function* Parse(src) {
            for await (const streamMessage of src) {
                try {
                    streamMessage.getParsedContent()
                } catch (err) {
                    orderingUtil.markMessageExplicitly(streamMessage)
                    await onError(err)
                }
                yield streamMessage
            }
        },
        orderingUtil,
        ...afterSteps
    ], async (err, ...args) => {
        await msgStream.cancel()
        return onFinally(err, ...args)
    })

    return Object.assign(p, {
        id,
        msgStream,
        orderingUtil,
        validate,
        collect: collect.bind(null, p),
        end: msgStream.end,
    })
}