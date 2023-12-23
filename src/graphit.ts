import * as dotenv from 'dotenv';
import * as dotenvExpand from 'dotenv-expand';

import { ethers, ZeroAddress } from 'ethers';

// import { EtherscanHttp } from 'src/etherscan';

//////////////////////////////////////////////////////////////////
// etherscan via http

// fetch from 'node-fetch';

type getContractCreationResponse = { contractAddress: string; contractCreator: string; txHash: string };

type getSourceCodeResponse = {
    SourceCode: string;
    ABI: string;
    ContractName: string;
    CompilerVersion: string;
    OptimizationUsed: number;
    Runs: number;
    ConstructorArguments: string;
    EVMVersion: string;
    Library: string;
    LicenseType: string;
    Proxy: number;
    Implementation: string;
    SwarmSource: string;
};

class EtherscanHttp {
    constructor(public apikey: string, public baseUrl: string = 'https://api.etherscan.io/api') {}

    private async fetchES(request: Object): Promise<any | undefined> {
        const url =
            `${this.baseUrl}?apikey=${this.apikey}&` +
            Object.entries(request)
                .map(([k, v]) => [k, encodeURIComponent(v)].join('='))
                .join('&')
                .toString();

        const response = await fetch(url);
        if (response.status !== 200) {
            throw Error('something went wrong while querying');
        }
        const json = await response.json();
        if (json.message === 'OK' && json.status === '1' && json.result !== 'Max rate limit reached') {
            return json.result;
        } else {
            return undefined;
        }
    }

    public async getContractCreation(address: string[]): Promise<getContractCreationResponse[] | null> {
        return await this.fetchES({
            module: 'contract',
            action: 'getcontractcreation',
            contractaddresses: address.join(','),
        });
    }

    public async getSourceCode(address: string): Promise<getSourceCodeResponse[] | null> {
        return await this.fetchES({
            module: 'contract',
            action: 'getsourcecode',
            address: address,
        });
    }
}

class EtherscanContract {
    public interface;

    constructor(
        public address: string,
        private etherscanProvider: ethers.EtherscanProvider,
        private etherscanhttp: EtherscanHttp,
        private ethersContract: ethers.Contract | null,
    ) {
        this.interface = ethersContract?.interface;
    }

    public async getContractCreation(): Promise<getContractCreationResponse | null> {
        const response = await this.etherscanhttp.getContractCreation([this.address]);
        if (response) {
            return response[0];
        }
        return null;
    }

    public async getSourceCode(): Promise<getSourceCodeResponse | null> {
        const response = await this.etherscanhttp.getSourceCode(this.address);
        if (response) {
            return response[0];
        }
        return null;
    }
}

class EtherscanProvider {
    private etherscanProvider: ethers.EtherscanProvider;
    private etherscanhttp: EtherscanHttp;

    constructor(network: ethers.Network, apikey: string | undefined) {
        this.etherscanProvider = new ethers.EtherscanProvider(network, apikey);
        this.etherscanhttp = new EtherscanHttp(apikey || '');
    }

    public async getContract(address: string): Promise<EtherscanContract | null> {
        return new EtherscanContract(
            address,
            this.etherscanProvider,
            this.etherscanhttp,
            await this.etherscanProvider.getContract(address),
        );
    }
}

///////////////////////////////////////////////////////

let jsonRpc: ethers.JsonRpcProvider;
let etherscan: EtherscanProvider;

function asDatetime(timestamp: number): string {
    return new Date(timestamp * 1000).toISOString();
}

function asTimestamp(datetime: string): number {
    const parsedUnixTimestamp = new Date(datetime).getTime();
    return isNaN(parsedUnixTimestamp) ? 0 : Math.floor(parsedUnixTimestamp / 1000);
}

function hasFunction(abi: ethers.Interface, name: string, inputTypes: string[], outputTypes: string[]): boolean {
    abi.forEachFunction(async (func) => {
        if (
            func.name === name &&
            func.inputs.reduce((matches, input, index) => {
                return matches && input.type == inputTypes[index];
            }, true) &&
            func.outputs.reduce((matches, output, index) => {
                return matches && output.type == outputTypes[index];
            }, true)
        )
            return true;
    });
    return false;
}

/////////////////////////////////////////////////////////////////////////

enum AddressTypes {
    unknown,
    contract,
    address,
    invalid,
}

class BCContract {
    constructor(public address: string) {}
    public name?: string;
    public deployTimestamp?: number;
    public creator?: string;
}

class BCAddress {
    constructor(public address: string) {
        this.type = AddressTypes.unknown;
        this.name = address.slice(0, 5) + '..' + address.slice(-3);
    }
    public name: string;
    public type: AddressTypes;
    public token?: string;
    public links: { to: string; name: string }[] = [];
    public contract?: BCContract; // extra contract info
    public implementations: BCContract[] = []; // historical implementation logics

    public asMermaid(stopper: boolean) {
        let implementation = this.implementations?.at(0);
        outputNodeMermaid(
            this.address,
            this.name,
            this.type,
            stopper,
            implementation?.address,
            implementation?.name,
            this.token,
        );
        for (let link of this.links) {
            outputLinkMermaid(implementation?.address || this.address, link.to, link.name);
        }
    }
}

type ContractData = {
    data: BCContract;
    abi: ethers.Interface | undefined;
    source: getSourceCodeResponse | null;
};

async function getContractData(address: string): Promise<ContractData> {
    let data = new BCContract(address);
    let contract = await etherscan.getContract(address);
    let stuff: getSourceCodeResponse | null = null;
    if (contract) {
        let createInfo = await contract.getContractCreation();
        if (createInfo) {
            const receipt = await jsonRpc.getTransactionReceipt(createInfo.txHash);
            if (receipt && receipt.blockHash) {
                const block = await jsonRpc.getBlock(receipt.blockHash);
                if (block && block.timestamp) {
                    data.deployTimestamp = block.timestamp;
                    // console.error(`${data.address} deployed on ${asDatetime(block.timestamp)}`);
                }
            }
            data.creator = createInfo.contractCreator;
        }
        stuff = await contract.getSourceCode();
        if (stuff) {
            data.name = stuff.ContractName;
        }
    }
    return { data: data, abi: contract?.interface, source: stuff };
}

async function delve(address: string, follow: boolean): Promise<BCAddress> {
    let result = new BCAddress(address);

    // what kind of address
    if (ethers.isAddress(address)) {
        const code = await jsonRpc.getCode(address);
        if (code !== '0x') {
            result.type = AddressTypes.contract;
            const contractData = await getContractData(address);
            result.contract = contractData.data;
            if (contractData.data.name) result.name = contractData.data.name;
            // set up the ABI to use for following addresses
            let abi = contractData.abi;
            let rpcContract: ethers.Contract;
            // lookup the ERC20 token name, if it exists
            const erc20Token = new ethers.Contract(
                address,
                ['function name() view returns (string)', 'function symbol() view returns (string)'],
                jsonRpc,
            );
            try {
                const erc20Name = await erc20Token.name();
                const erc20Symbol = await erc20Token.symbol();
                if (erc20Name || erc20Symbol) result.token = `${erc20Symbol} (${erc20Name})`;
            } catch (error) {}
            if (contractData.source && contractData.source.Proxy > 0) {
                // It's a proxy
                const implementationData = await getContractData(contractData.source.Implementation);
                // replace the ABI to use for following addresses
                abi = implementationData.abi;
                result.implementations.push(implementationData.data);
                // TODO: get the update history
                // Get historical transactions for the proxy contract
                const events = await jsonRpc.getLogs({
                    address: address,
                    topics: [ethers.id('Upgraded(address)')],
                    fromBlock: 0,
                    toBlock: 'latest',
                });
                if (events.length > 0) {
                    // TODO: iterate the events and add them as implementations
                    // get the latest event's first topic as the proxy implementation
                    const topic = events[events.length - 1]?.topics.at(1);
                    if (topic) {
                        // TODO: this should be a decoding of the topics according to event Upgraded(address indexed implementation)
                        // result.logic = '0x' + topic.slice(-40);
                    }
                }
            }
            if (abi && follow) {
                rpcContract = new ethers.Contract(address, abi, jsonRpc);
                // Explore each function in the contract's interface and check it's return

                let functions: ethers.FunctionFragment[] = [];
                abi.forEachFunction((func) => {
                    // must be parameterless view or pure function
                    if (
                        func.inputs.length == 0 &&
                        (func.stateMutability === 'view' || func.stateMutability === 'pure')
                    ) {
                        functions.push(func);
                    }
                });
                for (let func of functions) {
                    // that returns one or more addresses
                    const addressIndices = func.outputs.reduce((indices, elem, index) => {
                        if (elem.type === 'address' || elem.type === 'address[]') indices.push(index);
                        return indices;
                    }, [] as number[]);
                    if (addressIndices.length > 0) {
                        try {
                            const funcResults = await rpcContract[func.name]();
                            if (func.outputs.length == 1) {
                                if (func.outputs[0].type === 'address') {
                                    result.links.push({ to: funcResults, name: func.name });
                                } else {
                                    // address[]
                                    for (let index = 0; index < funcResults.length; index++) {
                                        const elem = funcResults[index];
                                        result.links.push({ to: elem, name: `${func.name}[${index}]` });
                                    }
                                }
                            } else {
                                /*
                                // assume an array of results
                                for (const i of addressIndices) {
                                    if (typeof results[i] === 'string') {
                                        outLink(address, results[i], `${func.name}.${func.outputs[i].name}`);
                                        promises.push(delve(address, outNode, outLink));
                                        //result.addLink(`${func.name}.${func.outputs[i].name}`, await delve(results[i]));
                                    }
                                }
                                */
                                console.error('array or results containing an address');
                            }
                        } catch (err) {
                            console.error(`error calling ${address} ${func.name} ${func.selector}: ${err}`);
                        }
                    }
                }
            }
        } else {
            result.type = AddressTypes.address;
        }
    } else {
        result.type = AddressTypes.invalid;
    }
    return result;
}

/////////////////////////////////////////////////////////////////////////
// mermaid graph
//

function cl(what: string) {
    console.log(what);
}

const makeName = (name?: string, logicName?: string, tokenName?: string): string => {
    let result = name;
    result = logicName ? `<b>${logicName}</b><br><i>${result}</i>` : `<b>${result}</b>`;
    result = tokenName ? `${tokenName}<br>${result}` : result;
    return result;
};

const makeStopper = (name: string, stopper: boolean): string => {
    return stopper ? `${name}<br><hr>` : name;
};

const outputNodeMermaid = (
    address: string,
    name: string,
    type: AddressTypes,
    stopper: boolean,
    logic?: string,
    logicName?: string,
    tokenName?: string,
) => {
    if (type === AddressTypes.contract) {
        if (logic) {
            cl(`${address}[["${makeName(name, logicName, tokenName)}"]]:::contract`);
            cl(`click ${address} "https://etherscan.io/address/${address}#code"`);
            cl(`${logic}["${makeStopper(makeName(logicName), stopper)}"]:::contract`);
            cl(`click ${logic} "https://etherscan.io/address/${logic}#code"`);
            cl(`${address} o--o ${logic}`);
        } else {
            cl(`${address}["${makeStopper(makeName(name, logicName, tokenName), stopper)}"]:::contract`);
            cl(`click ${address} "https://etherscan.io/address/${address}#code"`);
        }
    } else if (type === AddressTypes.address) {
        cl(`${address}(["${makeStopper(name, stopper)}"]):::address`);
        cl(`click ${address} "https://etherscan.io/address/${address}"`);
    } else {
        cl(`${address}("${makeStopper(name, stopper)}"):::address`);
        cl(`click ${address} "https://etherscan.io/address/${address}"`);
    }
    cl('');
};

const useNodesInLinks = false; // TODO: add a style command line arg
let zeroCount = 0;
const outputLinkMermaid = (from: string, to: string, name: string) => {
    // replace zero addresses
    if (to === ZeroAddress) {
        to = `addressZero${zeroCount++}`;
        cl(`${to}((0x0))`);
    }
    if (useNodesInLinks) {
        const nodeid = `${from}-${name}`;
        cl(`${nodeid}[${name}]:::link`);
        cl(`${from} --- ${nodeid} --> ${to}`);
    } else {
        cl(`${from} -- ${name} --> ${to}`);
    }
    cl('');
};

async function main() {
    dotenvExpand.expand(dotenv.config());
    jsonRpc = new ethers.JsonRpcProvider(process.env.MAINNET_RPC_URL);
    etherscan = new EtherscanProvider(new ethers.Network('mainnet', 1), process.env.ETHERSCAN_API_KEY);

    const asOf = asDatetime((await jsonRpc.getBlock(await jsonRpc.getBlockNumber()))?.timestamp || 0);

    // TODO: read this from command lin
    let start = ['0xe7b9c7c9cA85340b8c06fb805f7775e3015108dB']; // Market
    //let start = ['0x4eEfea49e4D876599765d5375cF7314cD14C9d38']; // RebalancePoolRegistry

    let stop = [
        '0xae7ab96520DE3A18E5e111B5EaAb095312D7fE84', // stETH
        //'0xa84360896cE9152d1780c546305BB54125F962d9', // FxETHTwapOracle
        '0x26B2ec4E02ebe2F54583af25b647b1D619e67BbF', // GnosisSafe (just has a list of owners)
        '0x21f73D42Eb58Ba49dDB685dc29D3bF5c0f0373CA', // "           "
        '0xE62B71cf983019BFf55bC83B48601ce8419650CC', // AccessControlledOffchainAggregator
        '0xdA31bc2B08F22AE24aeD5F6EB1E71E96867BA196', // "           "
    ];

    cl('```mermaid');
    cl('---');
    cl(`title: contract graph as of ${asOf}`);
    cl('---');
    cl('flowchart TB');
    cl('');

    const done = new Set<string>();
    let addresses = start;
    let address: string | undefined;
    while ((address = addresses.shift())) {
        if (!done.has(address)) {
            done.add(address);
            const stopper = stop.includes(address);
            const bcAddress = await delve(address, !stopper);
            for (let link of bcAddress.links) {
                // don't follow zero addresses
                if (link.to !== ZeroAddress) {
                    addresses.push(link.to);
                }
            }
            bcAddress.asMermaid(stopper);
        }
    }

    cl('');
    /*
    cl('classDef contract font:11px Roboto');
    cl('classDef address font:11px Roboto');
    cl('classDef proxy fill:#ffffff,font:11px Roboto');
    cl('classDef link stroke-width:0px,fill:#ffffff,font:11px Roboto');
    */

    cl('```');
}

// use this pattern to be able to use async/await everywhere and properly handle errors.
main().catch((error) => {
    console.error('Error: %s', error);
    process.exitCode = 1;
});
