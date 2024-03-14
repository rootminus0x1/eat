import * as dotenv from 'dotenv';
import * as dotenvExpand from 'dotenv-expand';
dotenvExpand.expand(dotenv.config());

import { BaseContract, Contract, DeferredTopicFilter, ZeroAddress, parseEther } from 'ethers';

import { ethers, network } from 'hardhat';
import { HardhatEthersSigner, SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers';
import { reset, setBalance } from '@nomicfoundation/hardhat-network-helpers';

import { EtherscanHttp, getContractCreationResponse, getSourceCodeResponse } from './etherscan';
import { asDateString } from './datetime';
import { contracts, localNodes, nodes, resetGraph } from './graph';
import { getConfig } from './config';
import { time } from '@nomicfoundation/hardhat-network-helpers';

let etherscanHttp = new EtherscanHttp(process.env.ETHERSCAN_API_KEY || '');

export let whale: SignerWithAddress;

export type ContractWithAddress<T extends BaseContract> = T & {
    address: string;
};

export type UserWithAddress = SignerWithAddress & { name: string; address: string };

export async function deploy<T extends BaseContract>(
    factoryName: string,
    ...deployArgs: any[]
): Promise<ContractWithAddress<T>> {
    const contractFactory = await ethers.getContractFactory(factoryName, whale);
    const contract = await contractFactory.deploy(...deployArgs);
    await contract.waitForDeployment();
    let address = await contract.getAddress();

    const contractWithAddress = Object.assign(contract as unknown as T, {
        address: address,
    });

    // for use now
    contracts[factoryName] = contractWithAddress;
    contracts[address] = contractWithAddress;

    // for use after another dig
    localNodes.set(
        address,
        Object.assign(new LocalBlockchainAddress(contractWithAddress, factoryName), {
            name: factoryName,
            address: address,
        }),
    );

    return contractWithAddress;
}

import {
    weeks,
    days,
    hours,
    minutes,
    seconds,
} from '@nomicfoundation/hardhat-network-helpers/dist/src/helpers/time/duration';
import { log } from './logging';

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
    resetGraph(); // initialise the graph
    // go to the block
    await reset(process.env.MAINNET_RPC_URL, getConfig().block);
    getConfig().timestamp = await time.latest();
    getConfig().datetime = asDateString(getConfig().timestamp);

    // get the signers
    allSigners = await ethers.getSigners();
    whale = await getSigner('whale');

    log(`${network.name} ${await time.latestBlock()} ${getConfig().datetime} UX:${getConfig().timestamp}`);
};

let allSigners: SignerWithAddress[] | undefined;
let allocatedSigners = 0;

//type SignerWithNameAndAddress = SignerWithAddress & { name: string };
let addedSigners = new Map<string, SignerWithAddress>();

export const getSigner = async (name: string): Promise<SignerWithAddress> => {
    if (!allSigners) throw 'need to setupBlockchain';
    let found = addedSigners.get(name);
    if (!found) {
        const newSigner: any = allSigners[allocatedSigners++];
        newSigner.name = name;
        found = newSigner;
        // found = allSigners[allocatedSigners++] /* as SignerWithAddress */;
        addedSigners.set(name, found!);
        await setBalance(newSigner.address, parseEther('100')); // 100 ether should be enough
    }
    return found!;
};

export const getSignerAt = async (address: string): Promise<HardhatEthersSigner | null> => {
    let signer: HardhatEthersSigner | null = null;
    if (address) {
        try {
            signer = await ethers.getImpersonatedSigner(address);
            // need to give the impersonated signer some eth (aparently need 0.641520744180000000 eth to do some actions!)
            await setBalance(signer.address, parseEther('100')); // 100 ether should be enough
        } catch (any) {}
    }
    return signer;
};

async function* queryFilter(contract: Contract, criteria: DeferredTopicFilter) {
    let toBlock = getConfig().block;
    let fromBlock = 0;
    let step = toBlock; // do the whole lot in one go

    let successfulToBlock: number = toBlock + 1;

    while (toBlock >= 0) {
        try {
            const events = await contract.queryFilter(criteria, fromBlock, toBlock);
            // Yield individual events
            for (const event of events.reverse()) {
                yield event;
            }
            // Adjust toBlock for the next iteration to continue backward
            successfulToBlock = toBlock;
            toBlock = fromBlock - 1;
        } catch (error) {
            // On exception, halve the step size and recalculate fromBlock
            step = Math.max(Math.floor(step / 2), 1); // Ensure step size doesn't become 0
            toBlock = successfulToBlock - 1; // Attempt smaller range from the last successful end
        } finally {
            fromBlock = Math.max(toBlock - step + 1, 0);
        }
    }
}

// TODO: remove the whale and just transfer to any named owner. Need to transfer the exact amount though. Maybe use the whale as an interediary?

export const addTokenToWhale = async (tokenName: string, amount: bigint): Promise<void> => {
    //console.log(`stealing ${formatEther(amount)} of ${tokenName}, ${contracts[tokenName].address} ...`);
    // Get historical transactions for the proxy contract
    /* TODO: keep this for when the contracts structure doesn't have the token in it?
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

    const done = new Set(nodes.keys()); // don't do interesting addresses
    let currentBalance: bigint = await tokenContract.balanceOf(whale); // to meet the target amount

    for await (const event of queryFilter(tokenContract, tokenContract.filters.Transfer())) {
        if (currentBalance >= amount) break;
        const parsedEvent = tokenContract.interface.parseLog({
            topics: [...event.topics],
            data: event.data,
        });
        if (parsedEvent) {
            // steal the transferree's tokens, avoiding known interesting addresses
            const to = parsedEvent.args.to;
            if (to !== '0x0000000000000000000000000000000000000000' && !done.has(to)) {
                done.add(to); // don't do this one again
                const pawn = await ethers.getImpersonatedSigner(to);
                try {
                    let pawnHolding: bigint = await tokenContract.balanceOf(pawn);
                    if (pawnHolding > 0n) {
                        await setBalance(pawn.address, 27542757796200000000n); // pawn needs some juice
                        await (tokenContract.connect(pawn) as any).transfer(whale.address, (pawnHolding * 9n) / 10n); // leave them a pittance
                        currentBalance = await tokenContract.balanceOf(whale);
                    }
                } catch (e: any) {
                    // we don't care there's an error, as the pawn may not still have
                    log(e.message);
                }
            }
        }
    }
};

type ERC20Fields = { name?: string; symbol?: string };
const getERC20Info = async (address: string): Promise<ERC20Fields> => {
    try {
        const erc20Token = new ethers.Contract(
            address,
            ['function name() view returns (string)', 'function symbol() view returns (string)'],
            ethers.provider,
        );
        return { name: await erc20Token.name(), symbol: await erc20Token.symbol() };
    } catch (error: any) {
        return {};
    }
};

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
        TODO: return this.name;
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
        const erc20Info = await getERC20Info(this.contract.address);
        return erc20Info.symbol;
    };

    public erc20Name = async (): Promise<string | undefined> => {
        const erc20Info = await getERC20Info(this.contract.address);
        return erc20Info.name;
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
                result.erc20Fields = await getERC20Info(this.address);
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

    public getContract = async (signer?: SignerWithAddress): Promise<ContractWithAddress<Contract> | null> => {
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
            (await this.erc20Symbol()) || // if its a token, use the symbol
            (await this.vyperContractName()) || // otherwise use the contract name, starting with the most specific, i.e. vyper name
            (await this.implementationContractName()) || // followed by the implementation of a proxy
            (await this.contractName()) || // followed by the actual contract at that address
            this.address // no contract name, return the address
        );
    };
}
