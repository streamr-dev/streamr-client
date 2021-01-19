import assert from 'assert'

import { ethers } from 'ethers'

import StreamrClient from '../../src'

import config from './config'

describe('LoginEndpoints', () => {
    let client

    const createClient = (opts = {}) => new StreamrClient({
        apiKey: 'tester1-api-key',
        autoConnect: false,
        autoDisconnect: false,
        ...config.clientOptions,
        ...opts,
    })

    beforeAll(() => {
        client = createClient()
    })

    afterAll(async (done) => {
        await client.disconnect()
        done()
    })

    describe('Challenge generation', () => {
        it('should retrieve a challenge', async () => {
            const challenge = await client.getChallenge('some-address')
            assert(challenge)
            assert(challenge.id)
            assert(challenge.challenge)
            assert(challenge.expires)
        })
    })

    describe('Challenge response', () => {
        it('should fail to get a session token', async () => {
            await expect(async () => {
                await client.sendChallengeResponse({
                    id: 'some-id',
                    challenge: 'some-challenge',
                }, 'some-sig', 'some-address')
            }).rejects.toThrow()
        })

        it('should get a session token', async () => {
            const wallet = ethers.Wallet.createRandom()
            const challenge = await client.getChallenge(wallet.address)
            assert(challenge.challenge)
            const signature = await wallet.signMessage(challenge.challenge)
            const sessionToken = await client.sendChallengeResponse(challenge, signature, wallet.address)
            assert(sessionToken)
            assert(sessionToken.token)
            assert(sessionToken.expires)
        })

        it('should get a session token with combined function', async () => {
            const wallet = ethers.Wallet.createRandom()
            const sessionToken = await client.loginWithChallengeResponse((d) => wallet.signMessage(d), wallet.address)
            assert(sessionToken)
            assert(sessionToken.token)
            assert(sessionToken.expires)
        })
    })

    describe('API key login', () => {
        it('should fail to get a session token', async () => {
            await expect(async () => {
                await client.loginWithApiKey('apikey')
            }).rejects.toThrow()
        })

        it('should get a session token', async () => {
            const sessionToken = await client.loginWithApiKey('tester1-api-key')
            assert(sessionToken)
            assert(sessionToken.token)
            assert(sessionToken.expires)
        })
    })

    describe('Username/password login', () => {
        it('should fail to get a session token', async () => {
            await expect(async () => {
                await client.loginWithUsernamePassword('username', 'password')
            }).rejects.toThrow()
        })

        it('should get a session token', async () => {
            const sessionToken = await client.loginWithUsernamePassword('tester2@streamr.com', 'tester2')
            assert(sessionToken)
            assert(sessionToken.token)
            assert(sessionToken.expires)
        })
    })

    describe('UserInfo', () => {
        it('should get user info', async () => {
            const userInfo = await client.getUserInfo()
            assert(userInfo.name)
            assert(userInfo.username)
        })
    })

    describe('logout', () => {
        it('should not be able to use the same session token after logout', async () => {
            await client.getUserInfo() // first fetches the session token, then requests the endpoint
            const sessionToken1 = client.session.options.sessionToken
            await client.logoutEndpoint() // invalidates the session token in engine-and-editor
            await client.getUserInfo() // requests the endpoint with sessionToken1, receives 401, fetches a new session token
            const sessionToken2 = client.session.options.sessionToken
            assert.notDeepStrictEqual(sessionToken1, sessionToken2)
        })
    })
})
