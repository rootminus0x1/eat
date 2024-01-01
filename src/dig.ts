import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { Buffer } from 'buffer';

import * as dotenv from 'dotenv';
import * as dotenvExpand from 'dotenv-expand';
dotenvExpand.expand(dotenv.config());

import { ethers } from 'hardhat';
import { reset } from '@nomicfoundation/hardhat-network-helpers';

import { Contract, FunctionFragment, ZeroAddress, TransactionReceipt } from 'ethers';

import { EtherscanHttp, getContractCreationResponse, getSourceCodeResponse } from './etherscan';

function asDatetime(timestamp: number): string {
    return new Date(timestamp * 1000).toISOString();
}

/*
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
*/

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
    type: GraphNodeType,
    stopper: boolean,
    logic?: string,
    logicName?: string,
    tokenName?: string,
) => {
    if (type === GraphNodeType.contract) {
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
    } else if (type === GraphNodeType.address) {
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

const outputHeaderMermaid = (f: fs.WriteStream, blockNumber: number, asOf: string): void => {
    cl(f, '```mermaid');
    cl(f, '---');
    cl(f, `title: contract graph as of block ${blockNumber}, ${asOf}`);
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

enum GraphNodeType {
    unknown,
    contract,
    address,
    invalid,
}

class GraphContract {
    constructor(public address: string, public name: string) {}
}

class GraphNode {
    constructor(public address: string) {
        this.type = GraphNodeType.unknown;
        this.name = address.slice(0, 5) + '..' + address.slice(-3);
    }
    public name: string;
    public type: GraphNodeType;
    public token?: string;
    public links: { to: string; name: string }[] = [];
    public contract?: GraphContract; // extra contract info
    public implementations: GraphContract[] = []; // historical implementation logics

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

let etherscanHttp = new EtherscanHttp(process.env.ETHERSCAN_API_KEY || '');

class EatContract {
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

/*
async function getContractData(address: string): Promise<ContractData> {
    let data = new BCContract(address);
    let contract = await etherscan.getContract(address);
    let stuff: getSourceCodeResponse | null = null;
    let abi: Object = {};
    if (contract) {
        let createInfo = await contract.getContractCreation();
        if (createInfo) {
            const receipt = await ethers.provider.getTransactionReceipt(createInfo.txHash);
            if (receipt && receipt.blockHash) {
                const block = await ethers.provider.getBlock(receipt.blockHash);
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
    return { data: data, source: stuff };
}
*/

async function dig(address: string, follow: boolean): Promise<GraphNode> {
    let result = new GraphNode(address);

    // what kind of address
    if (ethers.isAddress(address)) {
        const code = await ethers.provider.getCode(address);
        if (code !== '0x') {
            result.type = GraphNodeType.contract;
            const contract = new EatContract(address);
            result.contract = new GraphContract(contract.address, await contract.name());
            if (await contract.name()) result.name = await contract.name();
            // set up the ABI to use for following addresses
            // TODO: put a lot f this into the EatConract
            let source = await contract.sourceCode();
            let abi = source?.ABI;
            let rpcContract: Contract;
            // lookup the ERC20 token name, if it exists
            const erc20Token = new ethers.Contract(
                address,
                ['function name() view returns (string)', 'function symbol() view returns (string)'],
                ethers.provider,
            );
            try {
                const erc20Name = await erc20Token.name();
                const erc20Symbol = await erc20Token.symbol();
                if (erc20Name || erc20Symbol) result.token = `${erc20Symbol} (${erc20Name})`;
            } catch (error) {}
            if (source && source.Proxy > 0) {
                // It's a proxy
                const implementation = new EatContract(source.Implementation);
                // replace the ABI to use for following addresses
                // TODO: merge this abi with the proxy abi, maybe later when searching the functions
                abi = (await implementation.sourceCode())?.ABI;
                result.implementations.push(new GraphContract(implementation.address, await implementation.name()));
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
            }
            if (abi && follow) {
                // TODO: combine the proxy and implementation abi's
                rpcContract = new ethers.Contract(address, abi, ethers.provider);
                // Explore each function in the contract's interface and check it's return

                let functions: FunctionFragment[] = [];
                rpcContract.interface.forEachFunction((func) => {
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
            result.type = GraphNodeType.address;
        }
    } else {
        result.type = GraphNodeType.invalid;
    }
    return result;
}

async function main() {
    const args = process.argv.slice(2);
    let configFilePath = path.resolve(args[0]);
    const config: any = yaml.load(fs.readFileSync(configFilePath).toString());
    const outputFilePath =
        path.dirname(configFilePath) + '/' + path.basename(configFilePath, path.extname(configFilePath)) + '.md';
    const outputFile = fs.createWriteStream(outputFilePath, { encoding: 'utf-8' });

    await reset(process.env.MAINNET_RPC_URL, config.block);
    let block = await ethers.provider.getBlockNumber();

    outputHeaderMermaid(outputFile, block, asDatetime((await ethers.provider.getBlock(block))?.timestamp || 0));

    const done = new Set<string>();
    let addresses = config.start;
    while (addresses.length) {
        const address = addresses[0];
        addresses.shift();
        if (!done.has(address)) {
            done.add(address);
            const stopper = config.stopafter.includes(address);
            const promise = (async (): Promise<void> => {
                const GraphNode = await dig(address, !stopper);
                for (let link of GraphNode.links) {
                    // don't follow zero addresses
                    if (link.to !== ZeroAddress) {
                        addresses.push(link.to);
                    }
                }
                GraphNode.asMermaid(outputFile, stopper);
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
