/////////////////////////////////////////////////////////////////////////
// mermaid graph
//
import { ZeroAddress } from 'ethers';

import { Graph } from './graph';
import { string } from 'hardhat/internal/core/params/argumentTypes';

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
    name: string,
    contractName?: string,
    logicName?: string,
    vyperName?: string,
    tokenSymbol?: string,
    tokenName?: string,
): string => {
    let result: string[] = [];
    if (tokenName || tokenSymbol) result.push(`${tokenSymbol} (${tokenName})`);
    result.push(`<b>${name}</b>`);
    if (logicName) result.push(`<i>${contractName}</i>`);
    return result.join('<br>');
};

const makeStopper = (name: string, stopper?: boolean): string => {
    return stopper ? `${name}<br><hr>` : name;
};

const useSubgraphForProxy = false;
const mergeProxyandLogic = true;
const nodeMermaid = (
    address: string,
    type: AddressType,
    name: string,
    stopper?: boolean,
    contractName?: string,
    logic?: string,
    logicName?: string,
    vyperName?: string,
    tokenSymbol?: string,
    tokenName?: string,
): string => {
    const f: string[] = [];
    if (type === AddressType.contract) {
        if (logicName) {
            if (mergeProxyandLogic) {
                cl(
                    f,
                    `${address}[["${makeStopper(
                        makeContractName(name, contractName, logicName, vyperName, tokenSymbol, tokenName),
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
                    `${address}[["${makeContractName(
                        name,
                        contractName,
                        logicName,
                        vyperName,
                        tokenSymbol,
                        tokenName,
                    )}"]]:::contract`,
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
                    makeContractName(name, contractName, logicName, vyperName, tokenSymbol, tokenName),
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

const headerMermaid = (blockNumber: number, asOf: string, config?: any): string => {
    const f: string[] = [];
    cl(f, '```mermaid');
    cl(f, '---');
    cl(f, `title: contract graph as of block ${blockNumber}, ${asOf}`);
    cl(f, '---');
    if (config?.renderer) {
        cl(f, `%%{init: {"flowchart": {"defaultRenderer": "${config.renderer}"}} }%%`);
    }
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

export const mermaid = async (graph: Graph, blockNumber: number, asOf: string, config?: any): Promise<string> => {
    const f: string[] = [];
    cl(f, headerMermaid(blockNumber, asOf, config));
    for (const [address, node] of graph.nodes) {
        cl(
            f,
            nodeMermaid(
                address,
                (await node.isContract())
                    ? AddressType.contract
                    : (await node.isAddress())
                    ? AddressType.address
                    : AddressType.invalid,
                node.name,
                node.stopper,
                await node.contractName(),
                await node.implementationAddress(),
                await node.implementationContractName(),
                await node.vyperContractName(),
                await node.erc20Symbol(),
                await node.erc20Name(),
            ),
        );
        const links = graph.links.get(address);
        if (links)
            for (let link of links) {
                cl(f, linkMermaid(address, link.address, link.name, await node.implementationAddress()));
            }
    }
    cl(f, footerMermaid());
    return f.join('\n');
};
