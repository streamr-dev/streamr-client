// To enable debug logging:
// DEBUG=StreamrClient node examples/node.js

// In your own app, use require('streamr-client') and get it from npm
const StreamrClient = require('../dist/streamr-client')

// Create the client with default options
const client = new StreamrClient()

// Subscribe to a stream
const subscription = client.subscribe(
    {
        stream: '7wa7APtlTq6EC5iTCBy6dw',
        // Resend the last 10 messages on connect
        resend_last: 10
    },
    function(message) {
        // Handle the messages in this stream
        console.log(message)
    }
)

// Event binding examples
client.on('connected', function() {
    console.log('A connection has been established!')
})

subscription.on('subscribed', function() {
    console.log('Subscribed to '+subscription.streamId)
})

subscription.on('resending', function() {
    console.log('Resending from '+subscription.streamId)
})

subscription.on('resent', function() {
    console.log('Resend complete for '+subscription.streamId)
})

subscription.on('no_resend', function() {
    console.log('Nothing to resend for '+subscription.streamId)
})
