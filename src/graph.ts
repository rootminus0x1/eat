import { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers';
import { IBlockchainAddress } from './Blockchain';
import { Contract } from 'ethers';
import { log } from './logging';

// the nodes, also contains static information about the nodes, name, etc
export type GraphNode = {
    name: string;
    signer?: SignerWithAddress;
    leaf?: boolean;
} & IBlockchainAddress<Contract>;
// the links - between a from address (key) and to list of named addresses (value)
export type Link = { name: string; address: string };
export type Role = { id: string; name: string; addresses: string[] };

export let nodes: Map<string, GraphNode>; // address to object
export let links: Map<string, Link[]>; // address to array of links, from -> to:Link[]
export let backLinks: Map<string, Link[]>; // reverse of above, to -> from:Link[]
export let roles: Map<string, Role[]>; // address to array of roles
// TODO: add all view & pure functions to the readers
export let readers: Map<string, any>; // contract address to reader

// for use in code - no type checking at the moment
export let contracts: any;
export let users: any = {};
export let triggers: any;

// not resettable: contracts deployed programmatically, not from a blockchain fork
export let localNodes = new Map<string, GraphNode>();

export const resetGraph = () => {
    // log('resetting graph');
    nodes = new Map<string, GraphNode>(); // address to object
    links = new Map<string, Link[]>(); // address to array of links, from -> to:Link[]
    backLinks = new Map<string, Link[]>(); // reverse of above, to -> from:Link[]
    roles = new Map<string, Role[]>(); // address to array of roles
    readers = new Map<string, any>();

    // for use in code - no type checking at the moment
    contracts = {};
    triggers = {};
};
