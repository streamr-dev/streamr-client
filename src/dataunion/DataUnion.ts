import { BigNumber } from '@ethersproject/bignumber'
import { DataUnionEndpoints } from '../rest/DataUnionEndpoints'

export interface DataUnionDeployOptions {
    owner?: string,
    joinPartAgents?: string[],
    dataUnionName?: string,
    adminFee?: number,
    sidechainPollingIntervalMs?: number,
    sidechainRetryTimeoutMs?: number
    confirmations?: number
    gasPrice?: BigNumber
}

export interface DataUnionWithdrawOptions {
    pollingIntervalMs?: number
    retryTimeoutMs?: number
    payForSignatureTransport?: boolean
}

export interface DataUnionMemberListModificationOptions {
    confirmations?: number
}

export class DataUnion {

    contractAddress: string
    dataUnionEndpoints: DataUnionEndpoints

    constructor(contractAddress: string, dataUnionEndpoints: DataUnionEndpoints) {
        this.contractAddress = contractAddress
        this.dataUnionEndpoints = dataUnionEndpoints
    }

    getContractAddress() {
        return this.contractAddress
    }

    async getContract() {
        return this.dataUnionEndpoints.getContract(this.contractAddress)
    }

    // Member functions

    async join(memberAddress: string, secret?: string) {
        return this.dataUnionEndpoints.join(memberAddress, secret, this.contractAddress)
    }

    async hasJoined(memberAddress: string, options?: { pollingIntervalMs?: number, retryTimeoutMs?: number }) {
        return this.dataUnionEndpoints.hasJoined(memberAddress, options, this.contractAddress)
    }

    async withdrawAll(options?: DataUnionWithdrawOptions) {
        return this.dataUnionEndpoints.withdrawAll(this.contractAddress, options)
    }

    async withdrawAllTo(recipientAddress: string, options?: DataUnionWithdrawOptions) {
        return this.dataUnionEndpoints.withdrawAllTo(recipientAddress, options, this.contractAddress)
    }

    async signWithdrawAllTo(recipientAddress: string) {
        return this.dataUnionEndpoints.signWithdrawAllTo(recipientAddress, this.contractAddress)
    }

    async signWithdrawAmountTo(recipientAddress: string, amountTokenWei: BigNumber|number|string) {
        return this.dataUnionEndpoints.signWithdrawAmountTo(recipientAddress, amountTokenWei, this.contractAddress)
    }

    // Query functions

    async getStats() {
        return this.dataUnionEndpoints.getStats(this.contractAddress)
    }

    async getMemberStats(memberAddress?: string) {
        return this.dataUnionEndpoints.getMemberStats(memberAddress, this.contractAddress)
    }

    async getWithdrawableEarnings(memberAddress: string) {
        return this.dataUnionEndpoints.getWithdrawableEarnings(memberAddress, this.contractAddress)
    }

    async getAdminFee() {
        return this.dataUnionEndpoints.getAdminFee(this.contractAddress)
    }

    async getAdminAddress() {
        return this.dataUnionEndpoints.getAdminAddress(this.contractAddress)
    }

    async getVersion() {
        return this.dataUnionEndpoints.getVersion(this.contractAddress)
    }

    // Admin functions

    async createSecret(name: string = 'Untitled Data Union Secret') {
        return this.dataUnionEndpoints.createSecret(this.contractAddress, name)
    }

    async addMembers(memberAddressList: string[], options?: DataUnionMemberListModificationOptions) {
        return this.dataUnionEndpoints.addMembers(memberAddressList, options, this.contractAddress)
    }

    async partMembers(memberAddressList: string[], options?: DataUnionMemberListModificationOptions) {
        return this.dataUnionEndpoints.partMembers(memberAddressList, options, this.contractAddress)
    }

    async withdrawAllToMember(memberAddress: string, options?: DataUnionWithdrawOptions) {
        return this.dataUnionEndpoints.withdrawAllToMember(memberAddress, options, this.contractAddress)
    }

    async withdrawAllToSigned(memberAddress: string, recipientAddress: string, signature: string, options?: DataUnionWithdrawOptions) {
        return this.dataUnionEndpoints.withdrawAllToSigned(memberAddress, recipientAddress, signature, options, this.contractAddress)
    }

    async setAdminFee(newFeeFraction: number) {
        return this.dataUnionEndpoints.setAdminFee(newFeeFraction, this.contractAddress)
    }
}