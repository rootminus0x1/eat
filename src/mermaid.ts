/////////////////////////////////////////////////////////////////////////
// mermaid graph
//
import * as fs from 'fs';
import { ZeroAddress } from 'ethers';

import { EATAddress } from './EATAddress';
import { Link } from './graph';

export enum AddressType {
    invalid,
    contract,
    address,
}

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
    type: AddressType,
    stopper: boolean,
    logic?: string,
    logicName?: string,
    tokenName?: string,
) => {
    if (type === AddressType.contract) {
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
    } else if (type === AddressType.address) {
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

export const outputGraphNodeMermaid = async (
    f: fs.WriteStream,
    graphNode: EATAddress,
    links: Link[] | undefined,
    stopper: boolean,
): Promise<void> => {
    outputNodeMermaid(
        f,
        graphNode.address,
        await graphNode.contractName(),
        (await graphNode.isContract())
            ? AddressType.contract
            : (await graphNode.isAddress())
            ? AddressType.address
            : AddressType.invalid,
        stopper,
        await graphNode.implementationAddress(),
        await graphNode.implementationName(),
        await graphNode.token(),
    );
    if (links)
        for (let link of links) {
            outputLinkMermaid(
                f,
                graphNode.address,
                link.toAddress,
                link.linkName,
                await graphNode.implementationAddress(),
            );
        }
};

export const outputHeaderMermaid = (f: fs.WriteStream, blockNumber: number, asOf: string): void => {
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

export const outputFooterMermaid = (f: fs.WriteStream): void => {
    /*
    cl(f, 'classDef contract font:11px Roboto');
    cl(f, 'classDef address font:11px Roboto');
    cl(f, 'classDef proxy fill:#ffffff,font:11px Roboto');
    cl(f, 'classDef link stroke-width:0px,fill:#ffffff,font:11px Roboto');
    */
    cl(f, '```');
};
