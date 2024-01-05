/////////////////////////////////////////////////////////////////////////
// mermaid graph
//
import { ZeroAddress } from 'ethers';

import { Link, allLinks, allNodes } from './graph';

export enum AddressType {
    invalid,
    contract,
    address,
}

function cl(f: string[], what: string) {
    //console.log(what);
    f.push(what);
}

const makeContractName = (
    contractName?: string,
    logicName?: string,
    tokenSymbol?: string,
    tokenName?: string,
): string => {
    let result = contractName;
    result = logicName ? `<b>${logicName}</b><br><i>${result}</i>` : `<b>${result}</b>`;
    result = tokenName || tokenSymbol ? `${tokenSymbol} (${tokenName})<br>${result}` : result;
    return result;
};

const makeStopper = (name: string, stopper: boolean): string => {
    return stopper ? `${name}<br><hr>` : name;
};

const useSubgraphForProxy = false;
const mergeProxyandLogic = true;
const nodeMermaid = (
    address: string,
    type: AddressType,
    stopper: boolean,
    contractName?: string,
    logic?: string,
    logicName?: string,
    tokenSymbol?: string,
    tokenName?: string,
): string => {
    const f: string[] = [];
    if (type === AddressType.contract) {
        if (logic) {
            if (mergeProxyandLogic) {
                cl(
                    f,
                    `${address}[["${makeStopper(
                        makeContractName(contractName, logicName, tokenSymbol, tokenName),
                        stopper,
                    )}"]]:::contract`,
                );
                cl(f, `click ${address} "https://etherscan.io/address/${address}#code"`);
            } else {
                const logicid = `${address}-${logic}`;
                if (useSubgraphForProxy) {
                    cl(f, `subgraph ${address}-subgraph [" "]`);
                }
                cl(
                    f,
                    `${address}[["${makeContractName(contractName, logicName, tokenSymbol, tokenName)}"]]:::contract`,
                );
                cl(f, `click ${address} "https://etherscan.io/address/${address}#code"`);
                cl(f, `${logicid}["${makeStopper(makeContractName(logicName), stopper)}"]:::contract`);
                cl(f, `click ${logicid} "https://etherscan.io/address/${logic}#code"`);
                cl(f, `${address} o--o ${logicid}`);
                if (useSubgraphForProxy) {
                    cl(f, 'end');
                    cl(f, `style ${address}-subgraph stroke-width:0px,fill:#ffffff`);
                }
            }
        } else {
            cl(
                f,
                `${address}["${makeStopper(
                    makeContractName(contractName, logicName, tokenSymbol, tokenName),
                    stopper,
                )}"]:::contract`,
            );
            cl(f, `click ${address} "https://etherscan.io/address/${address}#code"`);
        }
    } else if (type === AddressType.address) {
        cl(f, `${address}(["${makeStopper(address.slice(0, 5) + '..' + address.slice(-3), stopper)}"]):::address`);
        cl(f, `click ${address} "https://etherscan.io/address/${address}"`);
    } else {
        cl(f, `${address}("${makeStopper(address, stopper)}"):::address`);
        cl(f, `click ${address} "https://etherscan.io/address/${address}"`);
    }
    cl(f, '');
    return f.join('\n');
};

const useNodesInLinks = false; // TODO: add a style command line arg
const linkMermaid = (from: string, to: string, name: string, logic?: string): string => {
    const f: string[] = [];
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
    return f.join('\n');
};

const headerMermaid = (blockNumber: number, asOf: string): string => {
    const f: string[] = [];
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
    return f.join('\n');
};

const footerMermaid = (): string => {
    const f: string[] = [];
    /*
    cl(f, 'classDef contract font:11px Roboto');
    cl(f, 'classDef address font:11px Roboto');
    cl(f, 'classDef proxy fill:#ffffff,font:11px Roboto');
    cl(f, 'classDef link stroke-width:0px,fill:#ffffff,font:11px Roboto');
    */
    cl(f, '```');
    cl(f, '');
    return f.join('\n');
};

export const mermaid = async (blockNumber: number, asOf: string): Promise<string> => {
    const f: string[] = [];
    cl(f, headerMermaid(blockNumber, asOf));
    for (const [address, node] of allNodes) {
        cl(
            f,
            nodeMermaid(
                address,
                (await node.isContract())
                    ? AddressType.contract
                    : (await node.isAddress())
                    ? AddressType.address
                    : AddressType.invalid,
                node.stopper,
                await node.contractName(),
                await node.implementationAddress(),
                await node.implementationContractName(),
                await node.erc20Symbol(),
                await node.erc20Name(),
            ),
        );
        const links = allLinks.get(address);
        if (links)
            for (let link of links) {
                cl(f, linkMermaid(address, link.to, link.name, await node.implementationAddress()));
            }
    }
    cl(f, footerMermaid());
    return f.join('\n');
};
