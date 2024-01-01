/////////////////////////////////////////////////////////////////////////
// mermaid graph
//

import * as fs from 'fs';
import { GraphNode, GraphNodeType } from './graphnode';
import { ZeroAddress } from 'ethers';

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

export const outputGraphNodeMermaid = (f: fs.WriteStream, graphNode: GraphNode, stopper: boolean): void => {
    let implementation = graphNode.implementations?.[0];
    outputNodeMermaid(
        f,
        graphNode.address,
        graphNode.name,
        graphNode.type,
        stopper,
        implementation?.address,
        implementation?.name,
        graphNode.token,
    );
    for (let link of graphNode.links) {
        outputLinkMermaid(f, graphNode.address, link.to, link.name, implementation?.address);
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
