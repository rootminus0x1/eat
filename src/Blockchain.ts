import * as dotenv from 'dotenv';
import * as dotenvExpand from 'dotenv-expand';
dotenvExpand.expand(dotenv.config());

import { BaseContract, Contract, ZeroAddress, parseEther } from 'ethers';

import { ethers, network } from 'hardhat';
import { HardhatEthersSigner, SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers';
import { reset, setBalance } from '@nomicfoundation/hardhat-network-helpers';

import { EtherscanHttp, getContractCreationResponse, getSourceCodeResponse } from './etherscan';
import { asDateString } from './datetime';
import { contracts, localNodes, nodes } from './graph';
import { getConfig } from './config';
import { time } from '@nomicfoundation/hardhat-network-helpers';

let etherscanHttp = new EtherscanHttp(process.env.ETHERSCAN_API_KEY || '');

export let whale: SignerWithAddress;

export type ContractWithAddress<T extends BaseContract = Contract> = T & {
    address: string;
};

export async function deploy<T extends BaseContract>(factoryName: string, ...deployArgs: any[]): Promise<void> {
    const contractFactory = await ethers.getContractFactory(factoryName, whale);
    const contract = await contractFactory.deploy(...deployArgs);
    await contract.waitForDeployment();
    const address = await contract.getAddress();

    const contractWithAddress = Object.assign(
        {
            address: address,
        },
        contract,
    );

    const result = Object.assign(new LocalBlockchainAddress(contractWithAddress, factoryName), {
        name: factoryName,
        address: address,
    }); //as ContractWithAddress<T>;

    contracts[factoryName] = result;
    contracts[address] = result;
    localNodes.set(factoryName, result);
}

/*
export async function deploy<T extends Contract>(
    factoryName: string,
    deployer: SignerWithAddress,
    ...deployArgs: any[]
): Promise<ContractWithAddress<T>> {
    const contractFactory = await ethers.getContractFactory(factoryName, deployer);
    const contract = await contractFactory.deploy(...deployArgs);
    await contract.waitForDeployment();
    let address = await contract.getAddress();

    let erc20 = await getERC20Fields(address);

    return Object.assign(contract as T, {
        name: factoryName,
        address: address,
        contractName: factoryName,
        implementationContractName: undefined,
        tokenName: erc20.name,
        tokenSymbol: erc20.symbol,
        connect: (signer: SignerWithAddress): T => {
            return new BaseContract(contract.target, contract.interface, signer) as T;
        },
    }) as ContractWithAddress<T>;
}

*/
import {
    weeks,
    days,
    hours,
    minutes,
    seconds,
} from '@nomicfoundation/hardhat-network-helpers/dist/src/helpers/time/duration';

const timeUnits = new Map<string, number>([
    ['week', weeks(1)],
    ['day', days(1)],
    ['hour', hours(1)],
    ['minute', minutes(1)],
    ['second', seconds(1)],
]);

export const parseTime = (amount: number, units: string): number => {
    //strip trailing "s" and lower case
    const multiplier = timeUnits.get(units.toLowerCase().replace(/s$/, ''));
    if (!multiplier) throw Error(`unrecognised units for parseTime: ${units}`);
    return amount * multiplier;
};

export const setupBlockchain = async (): Promise<void> => {
    // go to the block
    await reset(process.env.MAINNET_RPC_URL, getConfig().block);
    getConfig().timestamp = await time.latest();
    getConfig().datetime = asDateString(getConfig().timestamp);

    // get the signers
    allSigners = await ethers.getSigners();
    whale = await getSigner('whale');

    console.log(`${network.name} ${await time.latestBlock()} ${getConfig().datetime} UX:${getConfig().timestamp}`);
};

let allSigners: SignerWithAddress[] | undefined;
let allocatedSigners = 0;

export const getSigner = async (name: string): Promise<SignerWithAddress> => {
    if (!allSigners) throw 'need to setupBlockchain';
    return allSigners[allocatedSigners++] as SignerWithAddress;
};

export const getSignerAt = async (address: string, field?: string): Promise<HardhatEthersSigner | null> => {
    let theAddress = undefined;
    if (field) {
        // look up the property of address
        let contract = new ethers.Contract(address, [`function ${field}() view returns (address)`], whale);
        // call the field function
        try {
            theAddress = await contract[field]();
        } catch (any) {}
    } else {
        theAddress = address;
    }
    let signer: HardhatEthersSigner | null = null;
    if (theAddress) {
        try {
            signer = await ethers.getImpersonatedSigner(theAddress);
            await setBalance(signer.address, parseEther('10')); // 10 ether should be enough
        } catch (any) {}
        // need to give the impersonated signer some eth (aparently need 0.641520744180000000 eth to do some actions!)
    }
    return signer;
};

export const addTokenToWhale = async (tokenName: string, amount: bigint): Promise<void> => {
    //console.log(`stealing ${formatEther(amount)} of ${tokenName}, ${contracts[tokenName].address} ...`);
    // Get historical transactions for the proxy contract
    /* TODO: keep this for when contracts doesn't have the token in it?
    const tokenContract = new ethers.Contract(
        tokenAddress,
        [
            'event Transfer(address indexed from, address indexed to, uint256 value)',
            'function transfer(address to, uint256 value)',
            'function balanceOf(address)',
        ],
        whale,
    );
    */
    const tokenContract = contracts[tokenName] as Contract;

    // Get the Transfer events
    const transferEvents = await tokenContract.queryFilter(tokenContract.filters.Transfer(), 0xaf2c74, 0xb4d9f4);

    let currentBalance: bigint = await tokenContract.balanceOf(whale); // to meet the target amount

    const done = new Set(nodes.keys()); // don't do interesting addresses
    for (const event of transferEvents.sort((a: any, b: any) => {
        // most recent first
        if (a.blockNumber !== b.blockNumber) {
            return b.blockNumber - a.blockNumber; // Reverse block number order
        } else {
            return b.transactionIndex - a.transactionIndex; // Reverse transaction index order
        }
    })) {
        const parsedEvent = tokenContract.interface.parseLog({
            topics: [...event.topics],
            data: event.data,
        });
        if (parsedEvent) {
            // steal the transferree's tokens, avoiding known interesting addresses
            const to = parsedEvent.args.to;
            if (!done.has(to)) {
                done.add(to); // don't do this one again
                const pawn = await ethers.getImpersonatedSigner(to);
                try {
                    let pawnHolding: bigint = await tokenContract.balanceOf(pawn);
                    await (tokenContract.connect(pawn) as any).transfer(whale.address, pawnHolding);
                    currentBalance = await tokenContract.balanceOf(whale);
                } catch (e: any) {
                    //console.log(e.message);
                }
            }
            if (currentBalance >= amount) break;
        }
    }
};

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

export interface IBlockchainAddress<T extends BaseContract> {
    getContract: (signer?: SignerWithAddress) => Promise<ContractWithAddress<T> | null>;
    contractName: () => Promise<string | undefined>;
    contractNamish: () => Promise<string>; // a name for a contract, based on the contract type (or address), but not unique
    getSourceCode: () => Promise<string | undefined>;
    implementationAddress: () => Promise<string | undefined>;
    implementationContractName: () => Promise<string | undefined>;
    erc20Symbol: () => Promise<string | undefined>;
    erc20Name: () => Promise<string | undefined>;
    isContract: () => Promise<boolean>;
    isAddress: () => Promise<boolean>;
}

class LocalBlockchainAddress<T extends BaseContract> implements IBlockchainAddress<T> {
    constructor(private contract: ContractWithAddress<T>, private name: string) {}

    public getContract = async (signer?: SignerWithAddress): Promise<ContractWithAddress<T> | null> => {
        return this.contract;
    };
    public contractName = async (): Promise<string | undefined> => {
        TODO: return '';
    };

    public contractNamish = async (): Promise<string> => {
        return this.name;
    };

    public getSourceCode = async (): Promise<string | undefined> => {
        return "it's in you project somewhere, go find it!";
    };

    public implementationAddress = async (): Promise<string | undefined> => {
        return undefined;
    };

    public implementationContractName = async (): Promise<string | undefined> => {
        return undefined;
    };

    public erc20Symbol = async (): Promise<string | undefined> => {
        return undefined;
    };

    public erc20Name = async (): Promise<string | undefined> => {
        return undefined;
    };

    public isContract = async (): Promise<boolean> => {
        return true;
    };

    public isAddress = async (): Promise<boolean> => {
        return true;
    };
}

export class BlockchainAddress implements IBlockchainAddress<Contract> {
    constructor(public address: string) {
        this.info = this.getAddressInfo();
    }

    // get all the information in one go so it simplifies waiting for an
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

    public getContract = async (signer?: SignerWithAddress): Promise<ContractWithAddress | null> => {
        const info = await this.info;
        // get abi, handling proxies
        const abi = info.implementationContractInfo?.sourceCode?.ABI || info.contractInfo?.sourceCode?.ABI;
        if (!abi) return null; // throw Error(`unable to locate contract ABI: ${this.address}`);

        const contract = new ethers.Contract(this.address, abi, signer || ethers.provider);

        return Object.assign(contract, {
            address: this.address,
        });
    };

    public getSourceCode = async (): Promise<string | undefined> => {
        const info = await this.info;
        // get source, handling proxies
        return info.implementationContractInfo?.sourceCode?.SourceCode || info.contractInfo?.sourceCode?.SourceCode;
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
        return info.isContract ? true : false;
    };

    public isERC20Contract = async (): Promise<boolean> => {
        const info = await this.info;
        return info.erc20Fields?.name ? true : false;
    };

    public isAddress = async (): Promise<boolean> => {
        return ethers.isAddress(this.address);
    };

    // naming functions and a consolidated name (called nameish)

    public erc20Name = async (): Promise<string | undefined> => {
        const info = await this.info;
        return info.erc20Fields?.name;
    };

    public erc20Symbol = async (): Promise<string | undefined> => {
        const info = await this.info;
        return info.erc20Fields?.symbol;
    };

    public implementationAddress = async (): Promise<string | undefined> => {
        const info = await this.info;
        return info.contractInfo?.sourceCode?.Implementation;
    };

    public contractName = async (): Promise<string | undefined> => {
        const info = await this.info;
        return info.contractInfo?.sourceCode?.ContractName || undefined;
    };

    public implementationContractName = async (): Promise<string | undefined> => {
        const info = await this.info;
        return info.implementationContractInfo?.sourceCode?.ContractName;
    };

    private vyperContractName = async (): Promise<string | undefined> => {
        const info = await this.info;
        if (info.contractInfo?.sourceCode?.ContractName === 'Vyper_contract') {
            const match = info.contractInfo?.sourceCode?.SourceCode.match(/^\s*@title\s+(.*)\s*$/m);
            return match && match[1] ? match[1] : undefined;
        }
        return undefined;
    };

    public contractNamish = async (): Promise<string> => {
        return (
            (await this.vyperContractName()) ||
            (await this.implementationContractName()) ||
            (await this.contractName()) ||
            this.address
        );
    };
}
