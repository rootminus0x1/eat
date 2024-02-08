import * as dotenv from 'dotenv';
import * as dotenvExpand from 'dotenv-expand';
dotenvExpand.expand(dotenv.config());

import { ethers } from 'hardhat';
import { FunctionFragment, MaxUint256, ZeroAddress } from 'ethers';

const sourceDir = './eat-source';

import { BlockchainAddress, addTokenToWhale, getOwnerSigner, getSigner, whale } from './Blockchain';
import {
    Link,
    Measure,
    MeasureOnAddress,
    backLinks,
    contracts,
    links,
    measures,
    measuresOnAddress,
    nodes,
    users,
    events,
    parseArg,
} from './graph';
import { getConfig, writeEatFile, writeFile } from './config';
import { mermaid } from './mermaid';

export const dig = async () => {
    console.log('digging...');
    const done = new Set<string>(); // ensure addresses are only visited once
    const addresses = [...(getConfig().root || getConfig().leaf)]; // make a copy as we are changing it
    const leafAddresses = getConfig().leaf;
    while (addresses && addresses.length) {
        const address = addresses[0];
        addresses.shift();
        if (!done.has(address)) {
            done.add(address);
            const blockchainAddress = digOne(address);
            if (blockchainAddress) {
                const leaf = leafAddresses?.includes(address);
                nodes.set(
                    address,
                    Object.assign({ name: await blockchainAddress.contractNamish(), leaf: leaf }, blockchainAddress),
                );
                // add the measures to the contract

                const dugUp = await digDeep(blockchainAddress);
                measures.set(address, dugUp.measures);
                measuresOnAddress.set(address, dugUp.measuresOnAddress);
                if (!leaf) {
                    // process the links
                    links.set(address, dugUp.links);
                    // and consequent backlinks
                    dugUp.links.forEach((link) =>
                        backLinks.set(
                            link.address,
                            (backLinks.get(link.address) ?? []).concat({ address: address, name: link.name }),
                        ),
                    );
                    // add more addresses to be dug up
                    dugUp.links.forEach((link) => addresses.push(link.address));
                }
            }
        }
    }

    // make node names unique and also javascript identifiers
    const nodeNames = new Map<string, string[]>();
    for (const [address, node] of nodes) {
        // make it javascript id
        // replace multiple whitespaces with underscores
        node.name = node.name.replace(/\s+/g, '_');
        // replace invalid characters with a dollar sign
        node.name = node.name.replace(/[^a-zA-Z0-9$_]/g, '$');
        // ensure the identifier doesn't start with a digit
        if (/^\d/.test(node.name)) node.name = '$' + node.name;

        // then add it to the list for uniqueness check below
        nodeNames.set(node.name, (nodeNames.get(node.name) ?? []).concat(address));
    }
    for (const [name, addresses] of nodeNames) {
        if (addresses.length > 1) {
            //console.log(`name ${name} has more than one address`);
            // find the links to get some name for them
            let unique = 0;
            for (const address of addresses) {
                const node = nodes.get(address);
                if (node) {
                    const backLinksForAddress = backLinks.get(address);
                    let done = false;
                    if (backLinksForAddress && backLinksForAddress.length == 1) {
                        const index = backLinksForAddress[0].name.match(/\[(\d+)\]$/);
                        if (index && index.length == 2) {
                            node.name += `_at_${index[1]}`;
                            done = true;
                        }
                    }
                    if (!done) {
                        node.name += `__${unique}`;
                        unique++;
                    }
                }
            }
        }
    }

    // set up the graph contracts and users for executing the actions
    for (const [address, node] of nodes) {
        const contract = await node.getContract();
        if (contract) {
            contracts[node.name] = Object.assign(contract, { ownerSigner: await getOwnerSigner(node) });
            // write out source file(s)
            // TODO: one file per contract type?
            const sourceCodeText = await node.getSourceCode();
            // TODO: handle vyper code
            if (sourceCodeText !== undefined) {
                const dir = `${sourceDir}/${getConfig().configName}/${node.name}`;
                if (sourceCodeText.length == 0 || sourceCodeText[0] !== '{') {
                    // it's text (some older contracts are this)
                    // handle vyper & solidity code
                    let extension = '.txt';
                    if (sourceCodeText.match(/(^|\n)\@external\s\n/)) {
                        extension = '.vy';
                    } else {
                        extension = '.sol';
                    }
                    writeFile(`${dir}${extension}`, sourceCodeText);
                } else {
                    // else it's probably json
                    let json = undefined;
                    try {
                        json = JSON.parse(sourceCodeText.slice(1, -1)); // remove spurious { & }
                    } catch (e: any) {
                        console.log(`error in ${node.name} source code: ${e}`);
                    }
                    Object.entries(json.sources).forEach(([filePath, file]) => {
                        writeFile(`${dir}/${filePath}`, (file as any).content);
                    });
                }
            }
        } else {
            users[node.name] = await ethers.getImpersonatedSigner(address);
        }
    }

    // add in the users from the config
    if (getConfig().users) {
        const holdings = new Map<string, Map<string, bigint>>(); // username to {contractname, amount}
        const totalHoldings = new Map<string, bigint>(); // contractname to total amount
        for (const user of getConfig().users) {
            const signer = await getSigner(user.name);
            users[user.name] = signer; // to be used in actions
            // add them to the graph, too
            nodes.set(signer.address, Object.assign({ name: user.name, signer: signer }, digOne(signer.address)));
            if (user.wallet) {
                const userHoldings = new Map<string, bigint>();
                for (const holding of user.wallet) {
                    const contract = holding.contract;
                    const amount = parseArg(holding.amount) as bigint;
                    userHoldings.set(contract, userHoldings.get(contract) ?? 0n + amount);
                    totalHoldings.set(contract, totalHoldings.get(contract) ?? 0n + amount);
                }
                holdings.set(user.name, userHoldings);
            }
        }
        // now we've added the users, we can fill their wallets
        for (const [contract, amount] of totalHoldings) {
            await addTokenToWhale(contract, amount);
        }
        for (const [userName, userHoldings] of holdings) {
            // fill the wallet
            // TODO: use setBalance to set ETH holdings
            for (const [tokenName, amount] of userHoldings) {
                if (!(await contracts[tokenName].connect(whale).transfer(users[userName].address, amount))) {
                    throw Error(`could not transfer ${tokenName} from whale to ${userName}`);
                }
                // find all the contracts this user interacts with and allow them to spend there
                if (getConfig().events) {
                    for (const contract of getConfig()
                        .events.filter((a) => a.user && a.user === userName)
                        .map((a) => a.contract)) {
                        // allow the wallet to be spent
                        if (
                            !(await contracts[tokenName]
                                .connect(users[userName])
                                .approve(contracts[contract].address, MaxUint256))
                        ) {
                            throw Error(
                                `could not approve ${contracts[contract].name} to use ${userName}'s ${contracts[tokenName]}`,
                            );
                        }
                    }
                }
            }
        }
    }
    // set up the events
    if (getConfig().events) {
        getConfig().events.forEach((ue) => {
            // TODO: add a do function to call doUserEvent - look at removing doUserEvent, and also substituteArgs?
            const copy = Object.assign({ ...ue });
            console.log(`userEvent: ${ue.name}`);
            events[ue.name] = copy; // add do: doUserEvent(copy)
            // events.set(ue.name, copy);
        });
    }

    if (getConfig().diagram) writeEatFile('diagram.md', await mermaid());
    console.log('digging...done.');
};

export const digOne = (address: string): BlockchainAddress | null => {
    return address !== ZeroAddress ? new BlockchainAddress(address) : null;
};

const outputName = (func: FunctionFragment, outputIndex?: number, arrayIndex?: number): string => {
    let result = func.name;
    if (outputIndex || outputIndex === 0) {
        result = `${result}.${func.outputs[outputIndex].name === '' ? outputIndex : func.outputs[outputIndex].name}`;
    }
    if (arrayIndex || arrayIndex === 0) {
        result = `${result}[${arrayIndex}]`;
    }
    return result;
};

const digDeep = async (
    address: BlockchainAddress,
): Promise<{ measures: Measure[]; measuresOnAddress: MeasureOnAddress[]; links: Link[] }> => {
    const links: Link[] = [];
    const measures: Measure[] = [];
    const measuresOnAddress: MeasureOnAddress[] = [];
    // would like to follow also the proxy contained addresses
    // unfortunately for some proxies (e.g. openzeppelin's TransparentUpgradeableProxy) only the admin can call functions on the proxy
    const contract = await address.getContract();
    if (contract) {
        // TODO: do something with constructor arguments and initialize calls (for logics)

        // so we can call the functions async in a loop later
        let functions: FunctionFragment[] = [];
        contract.interface.forEachFunction((func) => functions.push(func));

        // Explore each parameterless view (or pure) functions in the contract's interface
        for (const func of functions.filter(
            (f) =>
                (f.stateMutability === 'view' || f.stateMutability === 'pure') &&
                (f.inputs.length == 0 || (f.inputs.length == 1 && f.inputs[0].type === 'address')),
        )) {
            const onAddress = func.inputs.length == 1;
            // get all the functions that return a numeric or address or arrays of them
            for (const outputIndex of func.outputs.reduce((indices, elem, index) => {
                // TODO:  add bool?
                if (elem.type === 'address' || elem.type === 'address[]' || /^u?int\d+(\[\])?$/.test(elem.type)) {
                    indices.push(index);
                }
                return indices;
            }, [] as number[])) {
                const returnsSingle = func.outputs.length == 1;
                const returnsArray = func.outputs[outputIndex].type.endsWith('[]');
                const returnsAddress = func.outputs[outputIndex].type.startsWith('address');
                const name = outputName(func, returnsSingle ? undefined : outputIndex);
                const type = func.outputs[outputIndex].type;
                // TODO: merge these two
                const call: (arg?: any) => any = onAddress
                    ? async (address: string) => await contract[func.name](address)
                    : async () => await contract[func.name]();
                const process: any[] = [];
                if (!returnsSingle) {
                    // multiple outputs so have to extract the one in question - single outputs are already extracted
                    process.push((result: any[]): any => result[outputIndex]);
                }
                if (returnsArray) {
                    if (returnsAddress) {
                        // translate addess to string
                        process.push((result: any[]): string[] => result.map((a: string) => a));
                    } else {
                        // translate numbers to bigint
                        process.push((result: any[]): bigint[] => result.map((a: bigint) => a));
                    }
                }
                // chain the call and processing
                const calculation = async (address?: any): Promise<any> => {
                    let result = await call(address);
                    for (const p of process) {
                        result = p(result);
                    }
                    return result;
                };

                // now add the data into measures, measuresOnAddress & links
                if (returnsAddress && !onAddress) {
                    // need to execute the function
                    try {
                        const result = await calculation(); // the same calc as a measure will use
                        if (Array.isArray(result)) {
                            for (let i = 0; i < result.length; i++) {
                                links.push({ name: outputName(func, outputIndex, i), address: result[i] });
                            }
                        } else {
                            links.push({ name: name, address: result });
                        }
                    } catch (err) {
                        console.error(`linking - error calling ${address} ${func.name} ${func.selector}: ${err}`);
                    }
                }
                if (onAddress) {
                    measuresOnAddress.push({ name: name, type: type, calculation: calculation });
                } else {
                    measures.push({ name: name, type: type, calculation: calculation });
                }
            }
        }
    }
    return { measures: measures, measuresOnAddress: measuresOnAddress, links: links };
};
