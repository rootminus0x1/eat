import * as dotenv from 'dotenv';
import * as dotenvExpand from 'dotenv-expand';
dotenvExpand.expand(dotenv.config());

import { ethers } from 'hardhat';
import { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers';
import { Contract, ZeroAddress } from 'ethers';

import { EtherscanHttp, getContractCreationResponse, getSourceCodeResponse } from './etherscan';

let etherscanHttp = new EtherscanHttp(process.env.ETHERSCAN_API_KEY || '');

type ERC20Fields = { name: string | undefined; symbol: string | undefined };

type RawContractInfo = {
    sourceCode: getSourceCodeResponse | null;
    contractCreation: getContractCreationResponse | null;
};

const getContractInfo = async (address: string) => {
    // get etherscan sourceCode information
    const sourceCodeResponse = await etherscanHttp.getSourceCode(address);
    // get etherscan contractCreation information
    const contractCreationResponse = await etherscanHttp.getContractCreation([address]);
    return {
        sourceCode: sourceCodeResponse ? sourceCodeResponse[0] : null,
        contractCreation: contractCreationResponse ? contractCreationResponse[0] : null,
    };
};

type RawAddressInfo = {
    isContract: boolean;
    contractInfo: RawContractInfo | null;
    erc20Fields: ERC20Fields | null;
    // TODO: make implementations an array, holding historic implementation details
    implementationContractInfo: RawContractInfo | null;
};

export class BlockchainAddress {
    constructor(public address: string) {
        this.info = this.getAddressInfo();
    }

    private info: Promise<RawAddressInfo>;
    private getAddressInfo = async (): Promise<RawAddressInfo> => {
        // default the values to simple address
        let result: RawAddressInfo = {
            isContract: false,
            contractInfo: null,
            erc20Fields: null,
            implementationContractInfo: null,
        };
        if (this.address !== ZeroAddress) {
            // check if there is code there
            const code = await ethers.provider.getCode(this.address);
            if (code !== '0x') {
                result.isContract = true;
                // check for etherscan information
                result.contractInfo = await getContractInfo(this.address);

                // check for ERC20 contract and extract extra info
                result.erc20Fields = { name: undefined, symbol: undefined };
                try {
                    const erc20Token = new ethers.Contract(
                        this.address,
                        ['function name() view returns (string)', 'function symbol() view returns (string)'],
                        ethers.provider,
                    );
                    result.erc20Fields.name = await erc20Token.name();
                    result.erc20Fields.symbol = await erc20Token.symbol();
                } catch (error: any) {
                    /* just ignore the errors */
                }
                if (
                    result.contractInfo?.sourceCode &&
                    result.contractInfo.sourceCode.Proxy > 0 &&
                    result.contractInfo.sourceCode.Implementation !== ''
                ) {
                    result.implementationContractInfo = await getContractInfo(
                        result.contractInfo.sourceCode.Implementation,
                    );
                    /*
                                    // TODO: get the update history
                    // Get historical transactions for the proxy contract
                    const events = await ethers.provider.getLogs({
                        address: address,
                        topics: [ethers.id('Upgraded(address)')],
                        fromBlock: 0,
                        toBlock: 'latest',
                    });
                    if (events.length > 0) {
                        // TODO: iterate the events and add them as implementations
                        // get the latest event's first topic as the proxy implementation
                        const topic = events[events.length - 1]?.topics[1];
                        if (topic) {
                            // TODO: this should be a decoding of the topics according to event Upgraded(address indexed implementation)
                            // result.logic = '0x' + topic.slice(-40);
                        }
                    }
                    */
                }
            }
        }
        return result;
    };

    public creator = async (): Promise<string> => {
        const info = await this.info;
        return info.contractInfo?.contractCreation?.contractCreator || '';
    };

    public deployTimestamp = async (): Promise<number | undefined> => {
        const info = await this.info;
        let result;
        const txHash = info.contractInfo?.contractCreation?.txHash;
        if (txHash) {
            const receipt = await ethers.provider.getTransactionReceipt(txHash);
            if (receipt && receipt.blockHash) {
                const block = await ethers.provider.getBlock(receipt.blockHash);
                result = block?.timestamp;
            }
        }
        return result;
    };

    public getContract = async (signer?: SignerWithAddress): Promise<Contract> => {
        const info = await this.info;
        // get abi
        const abi = info.implementationContractInfo?.sourceCode?.ABI || info.contractInfo?.sourceCode?.ABI;
        if (!abi) throw Error(`unable to locate contract ABI: ${this.address}`);

        // create the contract from the abi
        return new ethers.Contract(this.address, abi, signer || ethers.provider);
    };

    public getProxyContract = async (signer?: SignerWithAddress): Promise<Contract | null> => {
        const info = await this.info;
        const abi = info.contractInfo?.sourceCode?.ABI;
        return info.implementationContractInfo && abi
            ? new ethers.Contract(this.address, abi, signer || ethers.provider)
            : null;
    };

    public isContract = async (): Promise<boolean> => {
        const info = await this.info;
        return info.contractInfo ? true : false;
    };

    public isAddress = async (): Promise<boolean> => {
        return ethers.isAddress(this.address);
    };

    public erc20Name = async (): Promise<string | undefined> => {
        const info = await this.info;
        return info.erc20Fields?.name;
    };

    public erc20Symbol = async (): Promise<string | undefined> => {
        const info = await this.info;
        return info.erc20Fields?.symbol;
    };

    public contractName = async (): Promise<string | undefined> => {
        const info = await this.info;
        return info.contractInfo?.sourceCode?.ContractName || undefined;
    };

    public implementationAddress = async (): Promise<string | undefined> => {
        const info = await this.info;
        return info.contractInfo?.sourceCode?.Implementation;
    };

    public implementationContractName = async (): Promise<string | undefined> => {
        const info = await this.info;
        return info.implementationContractInfo?.sourceCode?.ContractName;
    };
}
