import * as dotenv from 'dotenv';
import * as dotenvExpand from 'dotenv-expand';
dotenvExpand.expand(dotenv.config());

import { ethers } from 'hardhat';

import { EtherscanHttp, getContractCreationResponse, getSourceCodeResponse } from './etherscan';

let etherscanHttp = new EtherscanHttp(process.env.ETHERSCAN_API_KEY || '');

export class EatContract {
    constructor(public address: string) {}

    private contractCreationCache: getContractCreationResponse | null | undefined = undefined;
    public async contractCreation(): Promise<getContractCreationResponse | null> {
        if (this.contractCreationCache === undefined) {
            const response = await etherscanHttp.getContractCreation([this.address]);
            this.contractCreationCache = response ? response[0] : null;
        }
        return this.contractCreationCache;
    }

    private getSourceCodeCache: getSourceCodeResponse | null | undefined = undefined;
    public async sourceCode(): Promise<getSourceCodeResponse | null> {
        if (this.getSourceCodeCache === undefined) {
            const response = await etherscanHttp.getSourceCode(this.address);
            this.getSourceCodeCache = response ? response[0] : null;
        }
        return this.getSourceCodeCache;
    }

    public async name(): Promise<string> {
        let source = await this.sourceCode();
        return source?.ContractName || '';
    }

    public async creator(): Promise<string> {
        let createInfo = await this.contractCreation();
        return createInfo?.contractCreator || '';
    }

    private deployTimestampCache: number | null | undefined = undefined;
    public async deployTimestamp(): Promise<number | null> {
        if (this.deployTimestampCache === undefined) {
            this.deployTimestampCache = null;
            let createInfo = await this.contractCreation();
            if (createInfo) {
                const receipt = await ethers.provider.getTransactionReceipt(createInfo.txHash);
                if (receipt && receipt.blockHash) {
                    const block = await ethers.provider.getBlock(receipt.blockHash);
                    if (block && block.timestamp) {
                        this.deployTimestampCache = block.timestamp;
                    }
                }
            }
        }
        return this.deployTimestampCache;
    }

    // TODO: add this as it's more useful than ethers.interface
    // public async abi():
}
