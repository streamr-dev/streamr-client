import { Stream } from '../../src/stream'
import { Todo } from '../../src/types'

describe('Stream', () => {
    let stream: Stream
    let clientMock: Todo

    beforeEach(() => {
        clientMock = {
            publish: jest.fn()
        }
        stream = new Stream(clientMock, {
            id: 'stream-id'
        })
    })

    describe('publish()', () => {
        it('should call client.publish(...)', () => {
            const msg = {
                foo: 'bar'
            }
            const ts = Date.now()
            const pk = 'my-partition-key'

            stream.publish(msg, ts, pk)

            expect(clientMock.publish).toHaveBeenCalledWith(stream.id, msg, ts, pk)
        })
    })
})
