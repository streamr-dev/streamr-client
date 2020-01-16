import { Contract, providers, utils, Wallet } from 'ethers'
import debug from 'debug'
import { wait } from 'streamr-test-utils'

import StreamrClient from '../../src'
import * as Token from '../../contracts/TestToken.json'

import config from './config'

const log = debug('StreamrClient::CommunityEndpoints::integration-test')

describe('CommunityEndPoints', () => {
    let community

    let testProvider
    let adminClient
    let adminWallet

    beforeAll(async () => {
        testProvider = new providers.JsonRpcProvider(config.ethereumServerUrl)
        log(`Connecting to Ethereum network, config = ${JSON.stringify(config)}`)

        const network = await testProvider.getNetwork()
        log('Connected to Ethereum network: ', JSON.stringify(network))

        adminWallet = new Wallet(config.privateKey, testProvider)
        adminClient = new StreamrClient({
            auth: {
                privateKey: adminWallet.privateKey
            },
            autoConnect: false,
            autoDisconnect: false,
            ...config.clientOptions,
        })

        log('beforeAll done')
    })
    beforeEach(async () => {
        await adminClient.ensureConnected()
        community = await adminClient.deployCommunity({
            provider: testProvider,
        })
        await community.deployed()
        log(`Deployment done for ${community.address}`)
        await community.isReady(2000, 200000)
        log(`Community ${community.address} is ready to roll`)
        await adminClient.createSecret(community.address, 'secret', 'CommunityEndpoints test secret')
    }, 300000)

    afterAll(async () => adminClient.ensureDisconnected())
    afterAll(() => testProvider.removeAllListeners())

    describe('Admin', () => {
        const memberAddressList = [
            '0x0000000000000000000000000000000000000001',
            '0x0000000000000000000000000000000000000002',
            '0x000000000000000000000000000000000000bEEF',
        ]

        it('can add and remove members', async () => {
            log('starting test')
            await adminClient.communityIsReady(community.address, log)

            await adminClient.addMembers(community.address, memberAddressList, testProvider)
            await adminClient.hasJoined(community.address, memberAddressList[0])
            const res = await adminClient.getCommunityStats(community.address)
            expect(res.memberCount).toEqual({
                total: 3, active: 3, inactive: 0
            })

            await adminClient.kick(community.address, memberAddressList.slice(1), testProvider)
            await wait(1000) // TODO: instead of sleeping, find a way to check server has registered the parting
            const res2 = await adminClient.getCommunityStats(community.address)
            expect(res2.memberCount).toEqual({
                total: 3, active: 1, inactive: 2
            })
        }, 300000)

        // separate test for adding and removing secrets? Adding secret is tested in member joins community test though.
    })

    describe('Members', () => {
        it('can join the community, and get their balances and stats, and check proof, and withdraw', async () => {
            // send eth so the member can afford to send tx
            const memberWallet = new Wallet('0x0000000000000000000000000000000000000000000000000000000000000001', testProvider)
            await adminWallet.sendTransaction({
                to: memberWallet.address,
                value: utils.parseEther('1'),
            })

            const memberClient = new StreamrClient({
                auth: {
                    privateKey: memberWallet.privateKey
                },
                autoConnect: false,
                autoDisconnect: false,
                ...config.clientOptions,
            })
            await memberClient.ensureConnected()

            const res = await memberClient.joinCommunity(community.address, 'secret')
            await memberClient.hasJoined(community.address)
            expect(res).toMatchObject({
                state: 'ACCEPTED',
                memberAddress: memberWallet.address,
                communityAddress: community.address,
            })

            // too much bother to check this in a separate test... TODO: split
            const res2 = await memberClient.getMemberStats(community.address)
            expect(res2).toEqual({
                address: memberWallet.address,
                earnings: '0',
                recordedEarnings: '0',
                withdrawableEarnings: '0',
                frozenEarnings: '0'
            })

            // add revenue, just to see some action
            const opWallet = new Wallet('0x5e98cce00cff5dea6b454889f359a4ec06b9fa6b88e9d69b86de8e1c81887da0', testProvider)
            const opToken = new Contract(adminClient.options.tokenAddress, Token.abi, opWallet)
            const tx = await opToken.mint(community.address, utils.parseEther('1'))
            const tr = await tx.wait(2)
            expect(tr.events[0].event).toBe('Transfer')
            expect(tr.events[0].args.from).toBe('0x0000000000000000000000000000000000000000')
            expect(tr.events[0].args.to).toBe(community.address)
            expect(tr.events[0].args.value.toString()).toBe('1000000000000000000')
            await wait(1000)

            // note: getMemberStats without explicit address => get stats of the authenticated StreamrClient
            let res3 = await memberClient.getMemberStats(community.address)
            while (!res3.withdrawableBlockNumber) {
                await wait(4000)
                res3 = await memberClient.getMemberStats(community.address)
            }
            expect(res3).toEqual({
                address: memberWallet.address,
                earnings: '1000000000000000000',
                recordedEarnings: '1000000000000000000',
                withdrawableEarnings: '1000000000000000000',
                frozenEarnings: '0',
                withdrawableBlockNumber: res3.withdrawableBlockNumber,
                proof: ['0xb7238c98e8baedc7aae869ecedd9900b1c2a767bbb482df81ef7539dbe71abe4']
            })

            const isValid = await memberClient.validateProof(community.address, {
                provider: testProvider
            })
            expect(isValid).toBeTruthy()

            const walletBefore = await opToken.balanceOf(memberWallet.address)

            const tr2 = await memberClient.withdraw(community.address, {
                provider: testProvider
            })
            expect(tr2.logs[0].address).toBe(adminClient.options.tokenAddress)

            const walletAfter = await opToken.balanceOf(memberWallet.address)
            const diff = walletAfter.sub(walletBefore)
            expect(diff.toString()).toBe(res3.withdrawableEarnings)
        }, 600000)

        // TODO: test withdrawTo, withdrawFor, getBalance
    })

    describe('Anyone', () => {
        const memberAddressList = [
            '0x0000000000000000000000000000000000000001',
            '0x0000000000000000000000000000000000000002',
            '0x000000000000000000000000000000000000bEEF',
        ]

        let client
        beforeAll(async () => {
            client = new StreamrClient({
                auth: {
                    apiKey: 'tester1-api-key'
                },
                autoConnect: false,
                autoDisconnect: false,
                ...config.clientOptions,
            })
        })
        afterAll(async () => client.ensureDisconnected())

        it('can get community stats, member list, and member stats', async () => {
            await adminClient.addMembers(community.address, memberAddressList, testProvider)
            await adminClient.hasJoined(community.address, memberAddressList[0])

            // mint tokens to community to generate revenue
            const opWallet = new Wallet('0x5e98cce00cff5dea6b454889f359a4ec06b9fa6b88e9d69b86de8e1c81887da0', testProvider)
            const opToken = new Contract(adminClient.options.tokenAddress, Token.abi, opWallet)
            const tx = await opToken.mint(community.address, utils.parseEther('1'))
            const tr = await tx.wait(2)
            expect(tr.events[0].event).toBe('Transfer')
            expect(tr.events[0].args.from).toBe('0x0000000000000000000000000000000000000000')
            expect(tr.events[0].args.to).toBe(community.address)

            await wait(1000)
            let mstats = await client.getMemberStats(community.address, memberAddressList[0])
            while (!mstats.withdrawableBlockNumber) {
                await wait(4000)
                mstats = await client.getMemberStats(community.address, memberAddressList[0])
            }

            // TODO: clean up asserts
            const cstats = await client.getCommunityStats(community.address)
            const mlist = await client.getMembers(community.address)

            expect(cstats.memberCount).toEqual({
                total: 3, active: 3, inactive: 0
            })
            expect(cstats.totalEarnings).toBe('1000000000000000000')
            expect(cstats.latestWithdrawableBlock.memberCount).toBe(4)
            expect(cstats.latestWithdrawableBlock.totalEarnings).toBe('1000000000000000000')
            expect(mlist).toEqual([{
                address: '0x0000000000000000000000000000000000000001',
                earnings: '333333333333333333'
            },
            {
                address: '0x0000000000000000000000000000000000000002',
                earnings: '333333333333333333'
            },
            {
                address: '0x000000000000000000000000000000000000bEEF',
                earnings: '333333333333333333'
            }])
            expect(mstats).toEqual({
                address: '0x0000000000000000000000000000000000000001',
                earnings: '333333333333333333',
                recordedEarnings: '333333333333333333',
                withdrawableEarnings: '333333333333333333',
                frozenEarnings: '0',
                withdrawableBlockNumber: cstats.latestWithdrawableBlock.blockNumber,
                proof: [
                    '0xb7238c98e8baedc7aae869ecedd9900b1c2a767bbb482df81ef7539dbe71abe4',
                    '0xe482f62a15e13774223a74cc4db3abb30d4ec3af8bf89f2f56116b9af1dbbe05',
                ]
            })
        }, 300000)
    })
})
