import { authFetch } from './utils'

async function getSessionToken(url, props) {
    return authFetch(
        url,
        undefined,
        {
            method: 'POST',
            body: JSON.stringify(props),
            headers: {
                'Content-Type': 'application/json',
            },
        },
    )
}

export async function getChallenge() {
    const url = `${this.options.restUrl}/login/challenge`
    const challenge = await authFetch(
        url,
        undefined,
        {
            method: 'POST',
        },
    )
    return challenge
}

export async function sendChallengeResponse(props) {
    if (!props || !props.challenge || !props.signature || !props.address) {
        throw new Error('Properties must contain "challenge", "signature" and "address" fields!')
    }

    const url = `${this.options.restUrl}/login/response`
    return getSessionToken(url, props)
}

export async function loginWithChallengeResponse(signingFunction, address) {
    const challenge = await this.getChallenge()
    return this.sendChallengeResponse({
        challenge,
        signature: signingFunction(challenge.challenge),
        address,
    })
}

export async function loginWithApiKey(props) {
    if (!props || !props.apikey) {
        throw new Error('Properties must contain "apikey" field!')
    }

    const url = `${this.options.restUrl}/login/apikey`
    return getSessionToken(url, props)
}

export async function loginWithUsernamePassword(props) {
    if (!props || !props.username || !props.password) {
        throw new Error('Properties must contain "username" and "password" fields!')
    }

    const url = `${this.options.restUrl}/login/password`
    return getSessionToken(url, props)
}
