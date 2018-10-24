import fetch from 'node-fetch'
import debugFactory from 'debug'

const debug = debugFactory('StreamrClient:utils')

export const authFetch = async (url, session, opts = {}, requireNewToken = false) => {
    debug('authFetch: ', url, opts)
    const newHeaders = opts.headers ? opts.headers : {}
    if (session) {
        const token = await session.getSessionToken(requireNewToken)
        newHeaders.Authorization = `Bearer ${token}`
    }

    const req = {
        ...opts,
        headers: newHeaders,
    }
    const res = await fetch(url, req)

    const text = await res.text()

    if (res.ok && text.length) {
        try {
            return JSON.parse(text)
        } catch (err) {
            throw new Error(`Failed to parse JSON response: ${text}`)
        }
    } else if (res.ok) {
        return {}
    } else if ((res.status === 400 || res.status === 401) && !requireNewToken) {
        return authFetch(url, session, opts, true)
    } else {
        throw new Error(`Request to ${url} returned with error code ${res.status}: ${text}`)
    }
}
