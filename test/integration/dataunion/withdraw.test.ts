import { BigNumber, Contract, providers, Wallet } from 'ethers'
import { formatEther, parseEther } from 'ethers/lib/utils'
import { TransactionReceipt } from '@ethersproject/providers'
import debug from 'debug'

import { getEndpointUrl, until } from '../../../src/utils'
import StreamrClient from '../../../src/StreamrClient'
import * as Token from '../../../contracts/TestToken.json'
import * as DataUnionSidechain from '../../../contracts/DataUnionSidechain.json'
import config from '../config'
import authFetch from '../../../src/rest/authFetch'

const log = debug('StreamrClient::DataUnionEndpoints::integration-test-withdraw')
// const { log } = console

// @ts-expect-error
const providerSidechain = new providers.JsonRpcProvider(config.clientOptions.sidechain)
// @ts-expect-error
const providerMainnet = new providers.JsonRpcProvider(config.clientOptions.mainnet)
const adminWalletMainnet = new Wallet(config.clientOptions.auth.privateKey, providerMainnet)
const adminWalletSidechain = new Wallet(config.clientOptions.auth.privateKey, providerSidechain)

const tokenAdminWallet = new Wallet(config.tokenAdminPrivateKey, providerMainnet)
const tokenMainnet = new Contract(config.clientOptions.tokenAddress, Token.abi, tokenAdminWallet)

const testWithdraw = async (
    getBalanceBefore: (memberWallet: Wallet, adminTokenMainnet: Contract) => Promise<BigNumber>, 
    withdraw: (dataUnionAddress: string, memberClient: StreamrClient, memberWallet: Wallet, adminClient: StreamrClient) => Promise<TransactionReceipt>, 
    getBalanceAfter: (memberWallet: Wallet, adminTokenMainnet: Contract) => Promise<BigNumber>,
    requiresMainnetETH: boolean
) => {
    log(`Connecting to Ethereum networks, config = ${JSON.stringify(config)}`)
    const network = await providerMainnet.getNetwork()
    log('Connected to "mainnet" network: ', JSON.stringify(network))
    const network2 = await providerSidechain.getNetwork()
    log('Connected to sidechain network: ', JSON.stringify(network2))

    log(`Minting 100 tokens to ${adminWalletMainnet.address}`)
    const tx1 = await tokenMainnet.mint(adminWalletMainnet.address, parseEther('100'))
    await tx1.wait()

    const adminClient = new StreamrClient(config.clientOptions as any)
    await adminClient.ensureConnected()

    const dataUnion = await adminClient.deployDataUnion()
    const secret = await adminClient.createSecret(dataUnion.address, 'DataUnionEndpoints test secret')
    log(`DataUnion ${dataUnion.address} is ready to roll`)
    // dataUnion = await adminClient.getDataUnionContract({dataUnion: "0xd778CfA9BB1d5F36E42526B2BAFD07B74b4066c0"})

    const memberWallet = new Wallet(`0x100000000000000000000000000000000000000012300000001${Date.now()}`, providerSidechain)
    const sendTx = await adminWalletSidechain.sendTransaction({ to: memberWallet.address, value: parseEther('0.1') })
    await sendTx.wait()
    log(`Sent 0.1 sidechain-ETH to ${memberWallet.address}`)

    if (requiresMainnetETH) {
        const send2Tx = await adminWalletMainnet.sendTransaction({ to: memberWallet.address, value: parseEther('0.1') })
        await send2Tx.wait()
        log(`Sent 0.1 mainnet-ETH to ${memberWallet.address}`)    
    }

    const memberClient = new StreamrClient({
        ...config.clientOptions,
        auth: {
            privateKey: memberWallet.privateKey
        },
        dataUnion: dataUnion.address,
    } as any)
    await memberClient.ensureConnected()

    // product is needed for join requests to analyze the DU version
    const createProductUrl = getEndpointUrl(config.clientOptions.restUrl, 'products')
    await authFetch(createProductUrl, adminClient.session, {
        method: 'POST',
        body: JSON.stringify({
            beneficiaryAddress: dataUnion.address,
            type: 'DATAUNION',
            dataUnionVersion: 2
        })
    })
    const res = await memberClient.getDataUnion(dataUnion.address).join(memberWallet.address, secret)
    // await adminClient.addMembers([memberWallet.address], { dataUnion })
    log(`Member joined data union: ${JSON.stringify(res)}`)

    const tokenAddress = await dataUnion.token()
    log(`Token address: ${tokenAddress}`)
    const adminTokenMainnet = new Contract(tokenAddress, Token.abi, adminWalletMainnet)

    const amount = parseEther('1')
    const duSidechainEarningsBefore = await dataUnion.sidechain.totalEarnings()

    const duBalance1 = await adminTokenMainnet.balanceOf(dataUnion.address)
    log(`Token balance of ${dataUnion.address}: ${formatEther(duBalance1)} (${duBalance1.toString()})`)
    const balance1 = await adminTokenMainnet.balanceOf(adminWalletMainnet.address)
    log(`Token balance of ${adminWalletMainnet.address}: ${formatEther(balance1)} (${balance1.toString()})`)

    log(`Transferring ${amount} token-wei ${adminWalletMainnet.address}->${dataUnion.address}`)
    const txTokenToDU = await adminTokenMainnet.transfer(dataUnion.address, amount)
    await txTokenToDU.wait()

    const duBalance2 = await adminTokenMainnet.balanceOf(dataUnion.address)
    log(`Token balance of ${dataUnion.address}: ${formatEther(duBalance2)} (${duBalance2.toString()})`)
    const balance2 = await adminTokenMainnet.balanceOf(adminWalletMainnet.address)
    log(`Token balance of ${adminWalletMainnet.address}: ${formatEther(balance2)} (${balance2.toString()})`)

    log(`DU member count: ${await dataUnion.sidechain.activeMemberCount()}`)

    log(`Transferred ${formatEther(amount)} tokens, next sending to bridge`)
    const tx2 = await dataUnion.sendTokensToBridge()
    await tx2.wait()

    log(`Sent to bridge, waiting for the tokens to appear at ${dataUnion.sidechain.address} in sidechain`)
    const tokenSidechain = new Contract(config.clientOptions.tokenAddressSidechain, Token.abi, adminWalletSidechain)
    await until(async () => !(await tokenSidechain.balanceOf(dataUnion.sidechain.address)).eq('0'), 300000, 3000)
    log(`Confirmed tokens arrived, DU balance: ${duSidechainEarningsBefore} -> ${await dataUnion.sidechain.totalEarnings()}`)

    // make a "full" sidechain contract object that has all functions, not just those required by StreamrClient
    const sidechainContract = new Contract(dataUnion.sidechain.address, DataUnionSidechain.abi, adminWalletSidechain)
    const tx3 = await sidechainContract.refreshRevenue()
    const tr3 = await tx3.wait()
    log(`refreshRevenue returned ${JSON.stringify(tr3)}`)
    log(`DU balance: ${await dataUnion.sidechain.totalEarnings()}`)

    const duBalance3 = await adminTokenMainnet.balanceOf(dataUnion.address)
    log(`Token balance of ${dataUnion.address}: ${formatEther(duBalance3)} (${duBalance3.toString()})`)
    const balance3 = await adminTokenMainnet.balanceOf(adminWalletMainnet.address)
    log(`Token balance of ${adminWalletMainnet.address}: ${formatEther(balance3)} (${balance3.toString()})`)

    const stats = await memberClient.getDataUnion(dataUnion.address).getMemberStats()
    log(`Stats: ${JSON.stringify(stats)}`)

    const balanceBefore = await getBalanceBefore(memberWallet, adminTokenMainnet)
    log(`Balance before: ${balanceBefore}. Withdrawing tokens...`)

    const withdrawTr = await withdraw(dataUnion.address, memberClient, memberWallet, adminClient)
    log(`Tokens withdrawn, sidechain tx receipt: ${JSON.stringify(withdrawTr)}`)
    const balanceAfter = await getBalanceAfter(memberWallet, adminTokenMainnet)
    const balanceIncrease = balanceAfter.sub(balanceBefore)

    await providerMainnet.removeAllListeners()
    await providerSidechain.removeAllListeners()
    await memberClient.ensureDisconnected()
    await adminClient.ensureDisconnected()

    expect(stats).toMatchObject({
        status: 'active',
        earningsBeforeLastJoin: '0',
        lmeAtJoin: '0',
        totalEarnings: '1000000000000000000',
        withdrawableEarnings: '1000000000000000000',
    })
    expect(withdrawTr.logs[0].address).toBe(config.clientOptions.tokenAddressSidechain)
    expect(balanceIncrease.toString()).toBe(amount.toString())
}

describe('DataUnion withdraw', () => {

    describe('Member', () => {

        it('by member itself', () => {
            const getBalanceBefore = async (memberWallet: Wallet, adminTokenMainnet: Contract) => adminTokenMainnet.balanceOf(memberWallet.address)
            const withdraw = async (dataUnionAddress: string, memberClient: StreamrClient) => memberClient.getDataUnion(dataUnionAddress).withdraw()
            const getBalanceAfter = async (memberWallet: Wallet, adminTokenMainnet: Contract) => adminTokenMainnet.balanceOf(memberWallet.address)
            return testWithdraw(getBalanceBefore, withdraw, getBalanceAfter, true)
        }, 300000)

        it('from member to any address', () => {
            const outsiderWallet = new Wallet(`0x100000000000000000000000000000000000000012300000002${Date.now()}`, providerSidechain)
            const getBalanceBefore = (_: Wallet, adminTokenMainnet: Contract) => adminTokenMainnet.balanceOf(outsiderWallet.address)
            const withdraw = (dataUnionAddress: string, memberClient: StreamrClient) => memberClient.getDataUnion(dataUnionAddress).withdrawTo(outsiderWallet.address)
            const getBalanceAfter = (_: Wallet, adminTokenMainnet: Contract) => adminTokenMainnet.balanceOf(outsiderWallet.address)
            return testWithdraw(getBalanceBefore, withdraw, getBalanceAfter, true)
        }, 300000)

    })

    describe('Admin', () => {
        it('non-signed', async () => {
            const getBalanceBefore = (memberWallet: Wallet, adminTokenMainnet: Contract) => adminTokenMainnet.balanceOf(memberWallet.address)
            const withdraw = (dataUnionAddress: string, _: StreamrClient, memberWallet: Wallet, adminClient: StreamrClient) => adminClient.getDataUnion(dataUnionAddress).withdrawMember(memberWallet.address)
            const getBalanceAfter = (memberWallet: Wallet, adminTokenMainnet: Contract) => adminTokenMainnet.balanceOf(memberWallet.address)
            return testWithdraw(getBalanceBefore, withdraw, getBalanceAfter, false)
        }, 300000)
        
        
        it('signed', async () => {
            const member2Wallet = new Wallet(`0x100000000000000000000000000000000000000012300000002${Date.now()}`, providerSidechain)
            const getBalanceBefore = (_: Wallet, adminTokenMainnet: Contract) => adminTokenMainnet.balanceOf(member2Wallet.address)
            const withdraw = async (dataUnionAddress: string, memberClient: StreamrClient, memberWallet: Wallet, adminClient: StreamrClient) => {
                const signature = await memberClient.getDataUnion(dataUnionAddress).signWithdrawTo(member2Wallet.address)
                const withdrawTr = await adminClient.getDataUnion(dataUnionAddress).withdrawToSigned(memberWallet.address, member2Wallet.address, signature)
                return withdrawTr
            }
            const getBalanceAfter = (_: Wallet, adminTokenMainnet: Contract) => adminTokenMainnet.balanceOf(member2Wallet.address)
            return testWithdraw(getBalanceBefore, withdraw, getBalanceAfter, false)
        }, 300000)
    })

});