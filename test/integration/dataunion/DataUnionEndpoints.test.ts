import { Contract, providers, Wallet } from 'ethers'
import { parseEther, formatEther } from 'ethers/lib/utils'
import { Mutex } from 'async-mutex'
import debug from 'debug'

import { getEndpointUrl } from '../../../src/utils'
import authFetch from '../../../src/rest/authFetch'
import StreamrClient from '../../../src/StreamrClient'
import * as Token from '../../../contracts/TestToken.json'
import config from '../config'
import { DataUnion } from '../../../src/dataunion/DataUnion'

const log = debug('StreamrClient::DataUnionEndpoints::integration-test')
// const log = console.log

// @ts-expect-error
const providerSidechain = new providers.JsonRpcProvider(config.clientOptions.sidechain)
// @ts-expect-error
const providerMainnet = new providers.JsonRpcProvider(config.clientOptions.mainnet)
const adminWalletMainnet = new Wallet(config.clientOptions.auth.privateKey, providerMainnet)

describe('DataUnionEndPoints', () => {
    let adminClient: StreamrClient

    const tokenAdminWallet = new Wallet(config.tokenAdminPrivateKey, providerMainnet)
    const tokenMainnet = new Contract(config.clientOptions.tokenAddress, Token.abi, tokenAdminWallet)

    afterAll(async () => {
        await providerMainnet.removeAllListeners()
        await providerSidechain.removeAllListeners()
        await adminClient.ensureDisconnected()
    })

    const streamrClientCleanupList = []
    afterAll(async () => Promise.all(streamrClientCleanupList.map((c) => c.ensureDisconnected())))

    beforeAll(async () => {
        log(`Connecting to Ethereum networks, config = ${JSON.stringify(config)}`)
        const network = await providerMainnet.getNetwork()
        log('Connected to "mainnet" network: ', JSON.stringify(network))
        const network2 = await providerSidechain.getNetwork()
        log('Connected to sidechain network: ', JSON.stringify(network2))

        log(`Minting 100 tokens to ${adminWalletMainnet.address}`)
        const tx1 = await tokenMainnet.mint(adminWalletMainnet.address, parseEther('100'))
        await tx1.wait()

        adminClient = new StreamrClient(config.clientOptions as any)
        await adminClient.ensureConnected()
    }, 10000)

    // fresh dataUnion for each test case, created NOT in parallel to avoid nonce troubles
    const adminMutex = new Mutex()
    async function deployDataUnionSync(testName) {
        let dataUnion: DataUnion
        await adminMutex.runExclusive(async () => {
            const dataUnionName = testName + Date.now()
            log(`Starting deployment of dataUnionName=${dataUnionName}`)
            dataUnion = await adminClient.deployDataUnion({ dataUnionName })
            log(`DataUnion ${dataUnion.getContractAddress()} is ready to roll`)

            // product is needed for join requests to analyze the DU version
            const createProductUrl = getEndpointUrl(config.clientOptions.restUrl, 'products')
            await authFetch(
                createProductUrl,
                adminClient.session,
                {
                    method: 'POST',
                    body: JSON.stringify({
                        beneficiaryAddress: dataUnion.getContractAddress(),
                        type: 'DATAUNION',
                        dataUnionVersion: 2
                    })
                }
            )
        })
        return dataUnion
    }

    describe('Admin', () => {
        const memberAddressList = [
            '0x0000000000000000000000000000000000000001',
            '0x0000000000000000000000000000000000000002',
            '0x000000000000000000000000000000000000bEEF',
        ]

        it('can add members', async () => {
            const dataUnion = await deployDataUnionSync('add-members-test')
            await adminMutex.runExclusive(async () => {
                await dataUnion.addMembers(memberAddressList)
                await dataUnion.hasJoined(memberAddressList[0])
            })
            const res = await dataUnion.getStats()
            expect(+res.activeMemberCount).toEqual(3)
            expect(+res.inactiveMemberCount).toEqual(0)
        }, 150000)

        it('can remove members', async () => {
            const dataUnion = await deployDataUnionSync('remove-members-test')
            await adminMutex.runExclusive(async () => {
                await dataUnion.addMembers(memberAddressList)
                await dataUnion.partMembers(memberAddressList.slice(1))
            })
            const res = await dataUnion.getStats()
            expect(+res.activeMemberCount).toEqual(1)
            expect(+res.inactiveMemberCount).toEqual(2)
        }, 150000)

        it('can set admin fee', async () => {
            const dataUnion = await deployDataUnionSync('set-admin-fee-test')
            const oldFee = await dataUnion.getAdminFee()
            await adminMutex.runExclusive(async () => {
                log(`DU owner: ${await dataUnion.getAdminAddress()}`)
                log(`Sending tx from ${adminClient.getAddress()}`)
                const tr = await dataUnion.setAdminFee(0.1)
                log(`Transaction receipt: ${JSON.stringify(tr)}`)
            })
            const newFee = await dataUnion.getAdminFee()
            expect(oldFee).toEqual(0)
            expect(newFee).toEqual(0.1)
        }, 150000)

        it('receives admin fees', async () => {
            const dataUnion = await deployDataUnionSync('withdraw-admin-fees-test')

            await adminMutex.runExclusive(async () => {
                await dataUnion.addMembers(memberAddressList)
                const tr = await dataUnion.setAdminFee(0.1)
                log(`Transaction receipt: ${JSON.stringify(tr)}`)
            })

            const amount = parseEther('2')
            const contract = await dataUnion._getContract()
            const tokenAddress = await contract.token()
            const adminTokenMainnet = new Contract(tokenAddress, Token.abi, adminWalletMainnet)

            await adminMutex.runExclusive(async () => {
                log(`Transferring ${amount} token-wei ${adminWalletMainnet.address}->${dataUnion.getContractAddress()}`)
                const txTokenToDU = await adminTokenMainnet.transfer(dataUnion.getContractAddress(), amount)
                await txTokenToDU.wait()
            })

            const balance1 = await adminTokenMainnet.balanceOf(adminWalletMainnet.address)
            log(`Token balance of ${adminWalletMainnet.address}: ${formatEther(balance1)} (${balance1.toString()})`)

            log(`Transferred ${formatEther(amount)} tokens, next sending to bridge`)
            const tx2 = await contract.sendTokensToBridge()
            await tx2.wait()

            const balance2 = await adminTokenMainnet.balanceOf(adminWalletMainnet.address)
            log(`Token balance of ${adminWalletMainnet.address}: ${formatEther(balance2)} (${balance2.toString()})`)

            expect(formatEther(balance2.sub(balance1))).toEqual('0.2')
        }, 150000)
    })

    describe('Anyone', () => {
        const nonce = Date.now()
        const memberAddressList = [
            `0x100000000000000000000000000${nonce}`,
            `0x200000000000000000000000000${nonce}`,
            `0x300000000000000000000000000${nonce}`,
        ]

        async function getOutsiderClient(dataUnion) {
            const client = new StreamrClient({
                ...config.clientOptions,
                auth: {
                    apiKey: 'tester1-api-key'
                },
                dataUnion: dataUnion.address,
                autoConnect: false,
                autoDisconnect: false,
            } as any)
            streamrClientCleanupList.push(client)
            return client
        }

        it('can get dataUnion stats', async () => {
            const dataUnion = await deployDataUnionSync('get-du-stats-test')
            await adminMutex.runExclusive(async () => {
                await dataUnion.addMembers(memberAddressList)
            })
            const client = await getOutsiderClient(dataUnion)
            const stats = await client.getDataUnion(dataUnion.getContractAddress()).getStats()
            expect(+stats.activeMemberCount).toEqual(3)
            expect(+stats.inactiveMemberCount).toEqual(0)
            expect(+stats.joinPartAgentCount).toEqual(2)
            expect(+stats.totalEarnings).toEqual(0)
            expect(+stats.totalWithdrawable).toEqual(0)
            expect(+stats.lifetimeMemberEarnings).toEqual(0)
        }, 150000)

        it('can get member stats', async () => {
            const dataUnion = await deployDataUnionSync('get-member-stats-test')
            await adminMutex.runExclusive(async () => {
                await dataUnion.addMembers(memberAddressList)
            })
            const client = await getOutsiderClient(dataUnion)
            const memberStats = await Promise.all(memberAddressList.map((m) => client.getDataUnion(dataUnion.getContractAddress()).getMemberStats(m)))
            expect(memberStats).toMatchObject([{
                status: 'active',
                earningsBeforeLastJoin: '0',
                lmeAtJoin: '0',
                totalEarnings: '0',
                withdrawableEarnings: '0',
            }, {
                status: 'active',
                earningsBeforeLastJoin: '0',
                lmeAtJoin: '0',
                totalEarnings: '0',
                withdrawableEarnings: '0',
            }, {
                status: 'active',
                earningsBeforeLastJoin: '0',
                lmeAtJoin: '0',
                totalEarnings: '0',
                withdrawableEarnings: '0',
            }])
        }, 150000)
    })
})
