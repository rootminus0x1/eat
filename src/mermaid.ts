/////////////////////////////////////////////////////////////////////////
// mermaid graph
//
import { ZeroAddress } from 'ethers';

import { links, nodes } from './graph';
import { getConfig } from './config';

export enum AddressType {
    invalid,
    address,
    signer,
    contract,
}

function cl(f: string[], what: string) {
    //console.log(what);
    f.push(what);
}

const makeContractName = (
    name: string,
    contractName?: string,
    logicName?: string,
    tokenSymbol?: string,
    tokenName?: string,
): string => {
    let result: string[] = [];
    if (tokenName || tokenSymbol) result.push(`${tokenSymbol} (${tokenName})`);
    result.push(`<b>${name}</b>`);
    if (logicName) {
        result.push(`<i>${contractName}</i>`);
        result.push(`${logicName}`);
    } else {
        result.push(`${contractName}`);
    }
    return result.join('<br>');
};

const makeLeaf = (name: string, leaf?: boolean): string => {
    return leaf ? `${name}<br><hr>` : name;
};

const nodeMermaid = (
    address: string,
    type: AddressType,
    name: string,
    leaf?: boolean,
    contractName?: string,
    logic?: string,
    logicName?: string,
    tokenSymbol?: string,
    tokenName?: string,
): string => {
    const f: string[] = [];
    if (type === AddressType.contract) {
        const pre = logicName ? '[[' : '[';
        const post = logicName ? ']]' : ']';
        cl(
            f,
            `${address}${pre}"${makeLeaf(
                makeContractName(name, contractName, logicName, tokenSymbol, tokenName),
                // TODO: add the readings (values or deltas here)
                leaf,
            )}"${post}:::contract`,
        );
        cl(f, `click ${address} "https://etherscan.io/address/${address}#code"`);
    } else if (type === AddressType.address) {
        cl(f, `${address}(["${makeLeaf(address.slice(0, 5) + '..' + address.slice(-3), leaf)}"]):::address`);
        cl(f, `click ${address} "https://etherscan.io/address/${address}"`);
    } else if (type === AddressType.signer) {
        cl(f, `${address}\{{"${makeLeaf(name, leaf)}"}\}:::address`);
    } else {
        cl(f, `${address}("${makeLeaf(address, leaf)}"):::address`);
        cl(f, `click ${address} "https://etherscan.io/address/${address}"`);
    }
    cl(f, '');
    return f.join('\n');
};

const linkMermaid = (from: string, to: string, name: string, logic?: string): string => {
    const f: string[] = [];
    // replace zero addresses
    if (to === ZeroAddress) {
        to = `${from}-${name}0x0`;
        cl(f, `${to}((0x0))`);
    }
    cl(f, `${from} -- ${name} --> ${to}`);
    cl(f, '');
    return f.join('\n');
};

export const asMD = (mmd: string, blockNumber: number, asOf: string): string => {
    const header: string[] = [],
        footer: string[] = [];
    cl(header, '```mermaid');
    cl(header, '---');
    cl(header, `title: contract graph as of block ${getConfig().block}, ${getConfig().datetime}`);
    cl(header, '---');

    cl(footer, '```');
    cl(footer, '');
    return header.join('\n') + mmd + footer.join('\n');
};

const mmdHeader = (): string => {
    const f: string[] = [];
    if (getConfig()?.diagram?.renderer) {
        cl(f, `%%{init: {"flowchart": {"defaultRenderer": "${getConfig()?.diagram?.renderer}"}} }%%`);
    }
    //%%{ init: { 'flowchart': { 'curve': 'stepBefore' } } }%%

    cl(f, 'flowchart TB');
    /*
    cl(f, '');
    cl(f, 'graphStyle marginY 100px;');
    */
    cl(f, '');
    return f.join('\n');
};

const mmdFooter = (): string => {
    const f: string[] = [];
    /*
    cl(f, 'classDef contract font:11px Roboto');
    cl(f, 'classDef address font:11px Roboto');
    cl(f, 'classDef proxy fill:#ffffff,font:11px Roboto');
    cl(f, 'classDef link stroke-width:0px,fill:#ffffff,font:11px Roboto');
    */

    return f.join('\n');
};

export const mermaid = async (): Promise<string> => {
    const f: string[] = [];
    cl(f, mmdHeader());
    for (const [address, node] of nodes) {
        cl(
            f,
            nodeMermaid(
                address,
                (await node.isContract())
                    ? AddressType.contract
                    : (await node.isAddress())
                    ? node.signer
                        ? AddressType.signer
                        : AddressType.address
                    : AddressType.invalid,
                node.name,
                node.leaf,
                await node.contractName(),
                await node.implementationAddress(),
                await node.implementationContractName(),
                await node.erc20Symbol(),
                await node.erc20Name(),
            ),
        );
        const linksForAddress = links.get(address);
        if (linksForAddress)
            for (let link of linksForAddress) {
                cl(f, linkMermaid(address, link.address, link.name, await node.implementationAddress()));
            }
    }
    cl(f, mmdFooter());
    return f.join('\n');
};
