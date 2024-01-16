import { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers';
import { BlockchainAddress } from './Blockchain';

// the nodes, also contains static information about the nodes, name, etc
export type GraphNode = {
    name: string;
    signer?: SignerWithAddress;
    stopper?: boolean;
} & BlockchainAddress;
// the links - between a from address (key) and to list of named addresses (value)
export type Link = { name: string; address: string };

export type Measure = {
    name: string;
    calculation: () => Promise<bigint | bigint[]>;
    type: string; // solidity type
};

export type MeasureOnAddress = {
    name: string;
    calculation: (address: string) => Promise<bigint | bigint[]>;
    type: string; // solidity type
};

export const nodes = new Map<string, GraphNode>(); // address to object
export const links = new Map<string, Link[]>(); // address to array of links, from -> to:Link[]
export const backLinks = new Map<string, Link[]>(); // reverse of above, to -> from:Link[]

export const measures = new Map<string, Measure[]>();
export const measuresOnAddress = new Map<string, MeasureOnAddress[]>();

// export const namedAddresses = new Map<string, string>();

// for use in actions
export const contracts: any = {};
export const users: any = {};
