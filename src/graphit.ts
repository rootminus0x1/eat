import * as dotenv from 'dotenv';
import * as dotenvExpand from 'dotenv-expand';

import { ethers, Result, ZeroAddress } from 'ethers';

let jsonRpc: ethers.JsonRpcProvider;
let etherscan: ethers.EtherscanProvider;

function asDatetime(timestamp: number): string {
    return new Date(timestamp * 1000).toISOString();
}

function asTimestamp(datetime: string): number {
    const parsedUnixTimestamp = new Date(datetime).getTime();
    return isNaN(parsedUnixTimestamp) ? 0 : Math.floor(parsedUnixTimestamp / 1000);
}

function hasFunction(abi: ethers.Interface, name: string, parameters: string[]): boolean {
    abi.forEachFunction(async (func) => {
        if (func.name === name && parameters.length == func.inputs.length) {
            let mismatch = false;
            for (let i = 0; i < parameters.length; i++) {
                if (parameters[i] !== func.inputs.at(i)?.name) {
                    mismatch = true;
                    break;
                }
            }
            if (!mismatch) return true;
        }
    });
    return false;
}

enum AddressTypes {
    unknown,
    contract,
    address,
    invalid,
}

class BCAddress {
    constructor(public address: string, public name: string, public type: AddressTypes, public logic?: string) {}
    public links: { to: string; name: string }[] = [];
}

// recursive decent into graph, aboiding duplicates
const done = new Set<string>();

async function delve(address: string): Promise<BCAddress | undefined> {
    // avoid duplicates
    if (done.has(address)) return;
    done.add(address);

    let found = givenContractData.find((c) => c.address == address);
    let result = new BCAddress(
        address,
        found?.name || address.slice(0, 5) + '...' + address.slice(-3),
        AddressTypes.unknown,
        found?.logic,
    );

    // what kind of address
    if (ethers.isAddress(address) && !found?.terminate) {
        const code = await jsonRpc.getCode(address);
        if (code !== '0x') {
            result.type = AddressTypes.contract;
            // get the abi
            const esContract = await etherscan.getContract(address);
            if (esContract) {
                /* when was it deployed TODO: get this working
                let deployTimestamp = 0;
                const tx = esContract.deploymentTransaction();
                if (tx) {
                    const receipt = await jsonRpc.getTransactionReceipt(tx.hash);
                    if (receipt && receipt.blockHash) {
                        const block = await jsonRpc.getBlock(receipt.blockHash);
                        if (block && block.timestamp) {
                            deployTimestamp = block.timestamp;
                            cl(`${address} deployed on ${asDatetime(deployTimestamp)}`);
                        }
                    }
                }
                */

                let abi = esContract.interface;
                // is this contract a proxy or a normal contract?
                // TODO: break proxy logic out of this - it is only about getting the correct abi
                // ERC897 proxies - see https://eips.ethereum.org/EIPS/eip-897
                let abiResolved = false; // TODO: what if a proxy refers to another proxy!
                if (!abiResolved && hasFunction(abi, 'proxyType', []) && hasFunction(abi, 'implementation', [])) {
                    const rpcContract: any = new ethers.Contract(address, abi, jsonRpc);
                    let proxyType = await rpcContract.proxyType();
                    if (proxyType > 0) {
                        let addressp = await rpcContract.implementation();
                        const esContract = await etherscan.getContract(addressp);
                        if (esContract) {
                            abi = esContract.interface;
                            abiResolved = true;
                        }
                    }
                }
                // ERC1967 proxies must have a fallback function and possibly
                // * another function to set the implementation, e.g. upgradeTo
                if (!abiResolved && abi.fallback) {
                    // TODO add other checks - fallback is necessary but not sufficient
                    // TODO: find a way of getting this programmatically
                    // TODO: make sure all paths result in a valid output, add else's
                    if (result.logic) {
                        //cl(`${address} => ${addressp}`);
                        const esContractp = await etherscan.getContract(result.logic);
                        if (esContractp) abi = esContractp.interface;
                    }
                    // const rpcContract = new ethers.Contract(address, contractInterface, jsonRpc);
                    // const results = await rpcContract.implementation();
                }

                const rpcContract = new ethers.Contract(address, abi, jsonRpc);

                // Explore each function in the contract's interface and check it's return

                const funcResults = new Map<string, any>(); // function name to results
                const funcAddressIndices = new Map<string, number[]>(); // function name to indices of address returns
                const funcPromises: Promise<void>[] = [];
                abi.forEachFunction((func) => {
                    // must be parameterless view or pure function
                    if (
                        func.inputs.length == 0 &&
                        (func.stateMutability === 'view' || func.stateMutability === 'pure')
                    ) {
                        // that returns one or more addresses
                        const addressIndices = func.outputs.reduce((indices, elem, index) => {
                            if (elem.type === 'address') indices.push(index);
                            return indices;
                        }, [] as number[]);
                        if (addressIndices.length > 0) {
                            funcAddressIndices.set(func.name, addressIndices);
                            const promise = (async () => {
                                if (
                                    address === '0xBF1Ce0Bc4EdaAD8e576b3b55e19c4C15Cf6999eb' &&
                                    func.selector === '0xa479e508'
                                ) {
                                    console.error(`calling ${address} ${func.name} ${func.selector}`);
                                }
                                try {
                                    const results = await rpcContract[func.name]();
                                    funcResults.set(func.name, results);
                                } catch (err) {
                                    console.error(`error calling ${address} ${func.name} ${func.selector}: ${err}`);
                                }
                            })();
                            funcPromises.push(promise);
                        }
                    }
                });
                await Promise.all(funcPromises);

                for (let [name, results] of funcResults) {
                    if (typeof results === 'string') {
                        // && func.outputs.length == 1 && addressIndices.length == 1) {
                        // only one result && it's the address
                        if (results !== ZeroAddress) {
                            result.links.push({ to: results, name: name });
                        }
                    } else {
                        //                            // assume an array of results
                        //                            for (const i of addressIndices) {
                        //                                if (typeof results[i] === 'string') {
                        //                                    outLink(address, results[i], `${func.name}.${func.outputs[i].name}`);
                        //                                    promises.push(delve(address, outNode, outLink));
                        //                                    //result.addLink(`${func.name}.${func.outputs[i].name}`, await delve(results[i]));
                        //                                }
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

const outputNodeMermaid = (address: string, name: string, type: AddressTypes, logic?: string) => {
    if (type === AddressTypes.contract) {
        if (logic) {
            cl(`${address}[[${name}]]:::contract`);
            cl(`click ${address} "https://etherscan.io/address/${address}#code"`);
            cl(`${logic}[${name}]:::contract`);
            cl(`click ${logic} "https://etherscan.io/address/${logic}#code"`);
            cl(`${address} o--o ${logic}`);
        } else {
            cl(`${address}[${name}]:::contract`);
            cl(`click ${address} "https://etherscan.io/address/${address}#code"`);
        }
    } else if (type === AddressTypes.address) {
        cl(`${address}([${name}]):::address`);
        cl(`click ${address} "https://etherscan.io/address/${address}"`);
    } else {
        cl(`${address}(${name}?):::address`);
        cl(`click ${address} "https://etherscan.io/address/${address}"`);
    }
    cl('');
};

const useNodesInLinks = false; // TODO: add a style command line arg
const outputLinkMermaid = (from: string, to: string, name: string) => {
    if (useNodesInLinks) {
        const nodeid = `${from}-${name}`;
        cl(`${nodeid}[${name}]:::link`);
        cl(`${from} --- ${nodeid} --> ${to}`);
    } else {
        cl(`${from} -- ${name} --> ${to}`);
    }
    cl('');
};

/////////////////////////////////////////////////////////////////////////
// names
// TODO: read this from a file
type ContractData = {
    address: string;
    name: string;
    logic?: string;
    terminate?: boolean;
};

const givenContractData: ContractData[] = [];

async function main() {
    dotenvExpand.expand(dotenv.config());
    jsonRpc = new ethers.JsonRpcProvider(process.env.MAINNET_RPC_URL);
    etherscan = new ethers.EtherscanProvider(new ethers.Network('mainnet', 1), process.env.ETHERSCAN_API_KEY);

    const asOf = asDatetime((await jsonRpc.getBlock(await jsonRpc.getBlockNumber()))?.timestamp || 0);

    // TODO: read this from file
    givenContractData.push({
        address: '0xe7b9c7c9cA85340b8c06fb805f7775e3015108dB',
        name: 'Market',
        logic: '0x679de4a3836d916fc86c6d9944c98a694f68adb4',
    });
    givenContractData.push({
        address: '0xae7ab96520DE3A18E5e111B5EaAb095312D7fE84',
        name: 'stETH',
        logic: '0x17144556fd3424edc8fc8a4c940b2d04936d17eb',
        terminate: true,
    });
    givenContractData.push({
        address: '0x53805A76E1f5ebbFE7115F16f9c87C2f7e633726',
        name: 'FractionalToken',
        logic: '0x2a906eab9b088e6753670bc8d3840f9473745748',
    });
    givenContractData.push({
        address: '0x0084C2e1B1823564e597Ff4848a88D61ac63D703',
        name: 'PlatformFeeSplitter',
    });
    givenContractData.push({
        address: '0x4eEfea49e4D876599765d5375cF7314cD14C9d38',
        name: 'RebalancePoolRegistry',
    });
    givenContractData.push({
        address: '0x5d0Aacf75116d1645Db2B3d1Ca4b303ef0CA3752',
        name: 'ReservePool',
    });
    givenContractData.push({
        address: '0x0e5CAA5c889Bdf053c9A76395f62267E653AFbb0',
        name: 'stETHTreasury',
        logic: '0x969fcabb703052155c4cc3b24458e77b2d56b29a',
    });
    givenContractData.push({
        address: '0xe063F04f280c60aECa68b38341C2eEcBeC703ae2',
        name: 'LeveragedToken',
        logic: '0x92d0cb7e56806bf977e7f5296ea2fe84b475fe83',
    });
    /*
    givenContractData.push({
        address: '0xBF1Ce0Bc4EdaAD8e576b3b55e19c4C15Cf6999eb',
        name: 'EVMScriptRegistry',
        //        inaccessible: true,
    });
    givenContractData.push({
        address: '0xa29b819654cE6224A222bb5f586920105E2D7E0E',
        name: 'LegacyOracle',
        //        inaccessible: true,
    });
    */
    givenContractData.push({
        address: '0xa84360896cE9152d1780c546305BB54125F962d9',
        name: 'FxETHTwapOracle',
        terminate: true,
    });
    givenContractData.push({
        address: '0x79c5f5b0753acE25ecdBdA4c2Bc86Ab074B6c2Bb',
        name: 'RebalancePoolSplitter',
    });
    givenContractData.push({
        address: '0x26B2ec4E02ebe2F54583af25b647b1D619e67BbF',
        name: 'GnosisSafe',
        logic: '0xd9db270c1b5e3bd161e8c8503c55ceabee709552',
    });

    // TODO: read this from command line
    const root = '0xe7b9c7c9cA85340b8c06fb805f7775e3015108dB';

    cl('```mermaid');
    cl('---');
    cl(`title: contract graph as of ${asOf}`);
    cl('---');
    cl('flowchart TB');
    cl('');

    let childAddresses = givenContractData.map((cd) => cd.address); // follow them all
    let address: string | undefined;
    while ((address = childAddresses.shift())) {
        const bcAddress = await delve(address);
        if (bcAddress) {
            outputNodeMermaid(bcAddress.address, bcAddress.name, bcAddress.type, bcAddress.logic);
            for (let link of bcAddress.links) {
                outputLinkMermaid(bcAddress.logic || bcAddress.address, link.to, link.name);
                childAddresses.push(link.to);
            }
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
