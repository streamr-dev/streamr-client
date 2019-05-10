import fetch from 'node-fetch'
import debugFactory from 'debug'

const debug = debugFactory('StreamrClient:utils')

const authFetch = async (url, session, opts = {}, requireNewToken = false) => {
    debug('authFetch: ', url, opts)

    const response = await fetch(url, {
        ...opts,
        headers: {
            ...(session && !session.options.unauthenticated ? {
                Authorization: `Bearer ${await session.getSessionToken(requireNewToken)}`,
            } : {}),
            ...opts.headers,
        },
    })

    const body = await response.text()

    if (response.ok) {
        try {
            return JSON.parse(body || '{}')
        } catch (e) {
            throw new Error(`Failed to parse JSON response: ${body}`)
        }
    } else if ([400, 401].includes(response.status) && !requireNewToken) {
        return authFetch(url, session, opts, true)
    } else {
        throw new Error(`Request to ${url} returned with error code ${response.status}: ${body}`)
    }
}

export default fetch
