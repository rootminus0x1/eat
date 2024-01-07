import { BlockchainAddress } from './BlockchainAddress';
// the nodes, also contains static information about the nodes, name, etc
export type graphNode = BlockchainAddress & { name: string; stopper: boolean };
export const allNodes = new Map<string, graphNode>(); // address to object

// the links - between a from address (key) and to list of named addresses (value)
export type Link = { name: string; address: string };

export const allLinks = new Map<string, Link[]>(); // address to array of links, from -> to:Link[]
export const allBackLinks = new Map<string, Link[]>(); // reverse of above, to -> from:Link[]

export type Measure = {
    name: string;
    calculation: () => Promise<bigint | bigint[]>;
    type: string; // solidity type
};
export const allMeasures = new Map<string, Measure[]>();
