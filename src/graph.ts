import { BlockchainAddress } from './BlockchainAddress';
// the nodes, also contains static information about the nodes, name, etc
export type graphNode = BlockchainAddress & { name: string; stopper: boolean };
// the links - between a from address (key) and to list of named addresses (value)
export type Link = { name: string; address: string };

export type Measure = {
    name: string;
    calculation: () => Promise<bigint | bigint[]>;
    type: string; // solidity type
};

export class Graph {
    public nodes = new Map<string, graphNode>(); // address to object
    public links = new Map<string, Link[]>(); // address to array of links, from -> to:Link[]
    public backLinks = new Map<string, Link[]>(); // reverse of above, to -> from:Link[]
    public measures = new Map<string, Measure[]>();
}
