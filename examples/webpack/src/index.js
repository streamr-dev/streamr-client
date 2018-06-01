import StreamrClient from 'streamr-client'

function log(msg) {
    const elem = document.createElement('p')
    elem.innerHTML = msg
    document.body.appendChild(elem)
}

// Create the client with default options
const client = new StreamrClient()
// Subscribe to a stream
const subscription = client.subscribe(
    {
        stream: '7wa7APtlTq6EC5iTCBy6dw',
        // Resend the last 10 messages on connect
        resend_last: 10,
    },
    (message) => {
        // Handle the messages in this stream
        log(JSON.stringify(message))
    },
)

// Event binding examples
client.on('connected', () => {
    log('A connection has been established!')
})

subscription.on('subscribed', () => {
    log(`Subscribed to ${subscription.streamId}`)
})

subscription.on('resending', () => {
    log(`Resending from ${subscription.streamId}`)
})

subscription.on('resent', () => {
    log(`Resend complete for ${subscription.streamId}`)
})

subscription.on('no_resend', () => {
    log(`Nothing to resend for ${subscription.streamId}`)
})
