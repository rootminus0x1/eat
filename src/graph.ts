import { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers';
import { BlockchainAddress } from './Blockchain';
import { parseUnits } from 'ethers';

// the nodes, also contains static information about the nodes, name, etc
export type GraphNode = {
    name: string;
    signer?: SignerWithAddress;
    leaf?: boolean;
} & BlockchainAddress;
// the links - between a from address (key) and to list of named addresses (value)
export type Link = { name: string; address: string };
export type Role = { id: string; name: string; addresses: string[] };

export type MeasurementValue = bigint | string;
export type MeasurementResult = MeasurementValue | MeasurementValue[];
export type Measure = {
    name: string;
    calculation: () => Promise<MeasurementResult>;
    type: string; // solidity type of result, you know how to extract the resulta
};

export type MeasureOnAddress = {
    name: string;
    calculation: (address: string) => Promise<MeasurementResult>;
    type: string; // solidity type
};

export const nodes = new Map<string, GraphNode>(); // address to object
export const links = new Map<string, Link[]>(); // address to array of links, from -> to:Link[]
export const backLinks = new Map<string, Link[]>(); // reverse of above, to -> from:Link[]

export const measures = new Map<string, Measure[]>();
export const measuresOnAddress = new Map<string, MeasureOnAddress[]>();

// for use in code
export const contracts: any = {};
export const users: any = {};
export const events: any = {};

export const parseArg = (configArg: any): string | bigint => {
    let arg: any;
    if (typeof configArg === 'bigint') {
        arg = configArg;
    } else if (typeof configArg === 'string') {
        // contract or user or address or string or number
        const match = configArg.match(/^\s*(\d+)\s*(\w+)\s*$/);
        if (match && match.length === 3) arg = parseUnits(match[1], match[2]);
        else if (users[configArg]) arg = users[configArg].address;
        else if (contracts[configArg]) arg = contracts[configArg].address;
    } else if (typeof configArg === 'number') arg = BigInt(configArg);
    else arg = 0n;
    return arg;
};
