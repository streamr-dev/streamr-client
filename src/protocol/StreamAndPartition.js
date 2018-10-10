class StreamAndPartition {
    constructor(streamId, streamPartition) {
        this.streamId = streamId
        this.streamPartition = streamPartition
    }

    toObject() {
        return {
            stream: this.streamId,
            partition: this.streamPartition,
        }
    }

    serialize() {
        return JSON.stringify(this.toObject())
    }

    static deserialize(stringOrObject) {
        const msg = (typeof stringOrObject === 'string' ? JSON.parse(stringOrObject) : stringOrObject)

        // calling this.prototype.constructor instead of new StreamAndPartition(...) works for subclasses too
        return new this.prototype.constructor(msg.stream, msg.partition)
    }
}

module.exports = StreamAndPartition
