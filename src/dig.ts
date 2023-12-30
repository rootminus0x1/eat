import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { Buffer } from 'buffer';

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
        const cacheDir = './eat-cache';
        const cachePath = cacheDir + '/' + Buffer.from(url).toString('base64');

        // ensure the cache directory exists
        try {
            // Check if the directory already exists
            await fs.promises.access(cacheDir);
        } catch (error: any) {
            // If the directory doesn't exist, create it
            if (error.code === 'ENOENT') {
                await fs.promises.mkdir(cacheDir, { recursive: true });
            } else {
                // If there was an error other than the directory not existing, throw the error
                throw error;
            }
        }
        if (fs.existsSync(cachePath)) {
            const resultString = fs.readFileSync(cachePath, 'utf-8');
            return JSON.parse(resultString);
        }

        const response = await fetch(url);
        if (response.status !== 200) {
            throw Error('something went wrong while querying');
        }
        const json = await response.json();
        if (json.message === 'OK' && json.status === '1' && json.result !== 'Max rate limit reached') {
            fs.writeFileSync(cachePath, JSON.stringify(json.result));
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
// mermaid graph
//

function cl(f: fs.WriteStream, what: string) {
    //console.log(what);
    f.write(what + '\n');
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

const useSubgraphForProxy = false;
const mergeProxyandLogic = true;
const outputNodeMermaid = (
    f: fs.WriteStream,
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
            if (mergeProxyandLogic) {
                cl(f, `${address}[["${makeStopper(makeName(name, logicName, tokenName), stopper)}"]]:::contract`);
                cl(f, `click ${address} "https://etherscan.io/address/${address}#code"`);
            } else {
                const logicid = `${address}-${logic}`;
                if (useSubgraphForProxy) {
                    cl(f, `subgraph ${address}-subgraph [" "]`);
                }
                cl(f, `${address}[["${makeName(name, logicName, tokenName)}"]]:::contract`);
                cl(f, `click ${address} "https://etherscan.io/address/${address}#code"`);
                cl(f, `${logicid}["${makeStopper(makeName(logicName), stopper)}"]:::contract`);
                cl(f, `click ${logicid} "https://etherscan.io/address/${logic}#code"`);
                cl(f, `${address} o--o ${logicid}`);
                if (useSubgraphForProxy) {
                    cl(f, 'end');
                    cl(f, `style ${address}-subgraph stroke-width:0px,fill:#ffffff`);
                }
            }
        } else {
            cl(f, `${address}["${makeStopper(makeName(name, logicName, tokenName), stopper)}"]:::contract`);
            cl(f, `click ${address} "https://etherscan.io/address/${address}#code"`);
        }
    } else if (type === AddressTypes.address) {
        cl(f, `${address}(["${makeStopper(name, stopper)}"]):::address`);
        cl(f, `click ${address} "https://etherscan.io/address/${address}"`);
    } else {
        cl(f, `${address}("${makeStopper(name, stopper)}"):::address`);
        cl(f, `click ${address} "https://etherscan.io/address/${address}"`);
    }
    cl(f, '');
};

const useNodesInLinks = false; // TODO: add a style command line arg
const outputLinkMermaid = (f: fs.WriteStream, from: string, to: string, name: string, logic?: string) => {
    // TODO: put this v into a single place for this function and outputNodeMermaid
    const fromid = logic && !mergeProxyandLogic ? `${from}-${logic}` : from;
    // replace zero addresses
    if (to === ZeroAddress) {
        to = `${fromid}-${name}0x0`;
        cl(f, `${to}((0x0))`);
    }
    if (useNodesInLinks) {
        const nodeid = `${fromid}-${name}`;
        cl(f, `${nodeid}[${name}]:::link`);
        cl(f, `${fromid} --- ${nodeid} --> ${to}`);
    } else {
        cl(f, `${fromid} -- ${name} --> ${to}`);
    }
    cl(f, '');
};

const outputHeaderMermaid = (f: fs.WriteStream, asOf: string): void => {
    cl(f, '```mermaid');
    cl(f, '---');
    cl(f, `title: contract graph as of ${asOf}`);
    cl(f, '---');
    cl(f, '%%{init: {"flowchart": {"defaultRenderer": "elk"}} }%%');
    //%%{init: {"flowchart": {"htmlLabels": false}} }%%
    //%%{ init: { 'flowchart': { 'curve': 'stepBefore' } } }%%

    cl(f, 'flowchart TB');
    /*
    cl(f, '');
    cl(f, 'graphStyle marginY 100px;');
    */
    cl(f, '');
};

const outputFooterMermaid = (f: fs.WriteStream): void => {
    /*
    cl(f, 'classDef contract font:11px Roboto');
    cl(f, 'classDef address font:11px Roboto');
    cl(f, 'classDef proxy fill:#ffffff,font:11px Roboto');
    cl(f, 'classDef link stroke-width:0px,fill:#ffffff,font:11px Roboto');
    */
    cl(f, '```');
};

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

    public asMermaid(f: fs.WriteStream, stopper: boolean) {
        let implementation = this.implementations?.[0];
        outputNodeMermaid(
            f,
            this.address,
            this.name,
            this.type,
            stopper,
            implementation?.address,
            implementation?.name,
            this.token,
        );
        for (let link of this.links) {
            outputLinkMermaid(f, this.address, link.to, link.name, implementation?.address);
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

async function dig(address: string, follow: boolean): Promise<BCAddress> {
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
                    const topic = events[events.length - 1]?.topics[1];
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
                                // assume an array of results
                                for (const outputIndex of addressIndices) {
                                    if (func.outputs[outputIndex].type === 'address') {
                                        result.links.push({
                                            to: funcResults[outputIndex],
                                            name: `${func.name}.${func.outputs[outputIndex].name}`,
                                        });
                                    } else {
                                        // address[]
                                        for (let index = 0; index < funcResults[outputIndex].length; index++) {
                                            const elem = funcResults[outputIndex][index];
                                            result.links.push({
                                                to: elem,
                                                name: `${func.name}.${func.outputs[outputIndex].name}[${index}]`,
                                            });
                                        }
                                    }
                                }
                                //console.error('array or results containing an address');
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

async function main() {
    dotenvExpand.expand(dotenv.config());
    jsonRpc = new ethers.JsonRpcProvider(process.env.MAINNET_RPC_URL);
    etherscan = new EtherscanProvider(new ethers.Network('mainnet', 1), process.env.ETHERSCAN_API_KEY);

    const asOf = asDatetime((await jsonRpc.getBlock(await jsonRpc.getBlockNumber()))?.timestamp || 0);

    const args = process.argv.slice(2);
    let configFilePath = path.resolve(args[0]);

    const config: any = yaml.load(fs.readFileSync(configFilePath).toString());

    const outputFilePath =
        path.dirname(configFilePath) + '/' + path.basename(configFilePath, path.extname(configFilePath)) + '.md';
    const outputFile = fs.createWriteStream(outputFilePath, { encoding: 'utf-8' });
    outputHeaderMermaid(outputFile, asOf);

    const done = new Set<string>();
    let addresses = config.start;
    while (addresses.length) {
        const address = addresses[0];
        addresses.shift();
        if (!done.has(address)) {
            done.add(address);
            const stopper = config.stopafter.includes(address);
            const promise = (async (): Promise<void> => {
                const bcAddress = await dig(address, !stopper);
                for (let link of bcAddress.links) {
                    // don't follow zero addresses
                    if (link.to !== ZeroAddress) {
                        addresses.push(link.to);
                    }
                }
                bcAddress.asMermaid(outputFile, stopper);
            })();
            await promise;
        }
    }

    outputFooterMermaid(outputFile);
    outputFile.end();
}

// use this pattern to be able to use async/await everywhere and properly handle errors.
main().catch((error) => {
    console.error('Error: %s', error);
    process.exitCode = 1;
});
