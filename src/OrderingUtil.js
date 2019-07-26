import OrderedMsgChain from './OrderedMsgChain'

export default class OrderingUtil {
    constructor(streamId, streamPartition, inOrderHandler, gapHandler, gapFillTimeout) {
        this.streamId = streamId
        this.streamPartition = streamPartition
        this.inOrderHandler = inOrderHandler
        this.gapHandler = gapHandler
        this.gapFillTimeout = gapFillTimeout
        this.orderedChains = {}
    }

    add(unorderedStreamMessage) {
        const chain = this._getChain(unorderedStreamMessage.getPublisherId(), unorderedStreamMessage.getMsgChainId())
        chain.add(unorderedStreamMessage)
    }

    _getChain(publisherId, msgChainId) {
        const key = publisherId + msgChainId
        if (!this.orderedChains[key]) {
            this.orderedChains[key] = new OrderedMsgChain(publisherId, msgChainId, this.inOrderHandler, this.gapHandler, this.gapFillTimeout)
        }
        return this.orderedChains[key]
    }

    markMessageExplicitly(streamMessage) {
        const chain = this._getChain(streamMessage.getPublisherId(), streamMessage.getMsgChainId())
        chain.markMessageExplicitly(streamMessage)
    }

    clearGaps() {
        Object.keys(this.orderedChains).forEach((key) => {
            this.orderedChains[key].clearGap()
        })
    }
}
