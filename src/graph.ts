import { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers';
import { IBlockchainAddress } from './Blockchain';
import { Contract } from 'ethers';
import { log } from './logging';
import { Reader, ReaderTemplate } from './read';
import { TriggerTemplate } from './trigg';
import { fieldToName, nameToAddress } from './friendly';

// the nodes, also contains static information about the nodes, name, etc
export type GraphNode = {
    name: string;
    signer?: SignerWithAddress;
    leaf?: boolean;
    address: string;
    extraNameAddress: string;
} & IBlockchainAddress<Contract>;
// the links - between a from address (key) and to list of named addresses (value)
export type Link = { name: string; address: string };
export type Role = { id: string; name: string; addresses: string[] };

export let nodes: Map<string, GraphNode>; // address to object
export let links: Map<string, Link[]>; // address to array of links, from -> to:Link[]
export let backLinks: Map<string, Link[]>; // reverse of above, to -> from:Link[]
export let roles: Map<string, Role[]>; // address to array of roles
// TODO: add all view & pure functions to the readers

export let readerTemplates: Map<string, ReaderTemplate[]>; // contract address to readers

export const makeReader = (nameOrAddress: string, fn: string, field?: string): Reader => {
    const address = nameToAddress(nameOrAddress);
    const forContract = readerTemplates.get(address);
    if (forContract) {
        const readers = forContract.filter((r: ReaderTemplate) => {
            if (r.function !== fn) return false; // mismatched function name
            if (field !== undefined && r.field !== undefined) return field === fieldToName(r.field);
            if (r.field !== undefined) return fieldToName(r.field) === field;
            else return true;
        });
        if (readers.length > 1)
            throw Error(`more than one Reader matches ${fn}${field ? '.' + field : ''} on ${nameOrAddress}`);
        if (readers.length === 0) throw Error(`no Reader on ${nameOrAddress}, with ${fn}${field ? '.' + field : ''}`);
        return Object.assign({ args: [] }, readers[0]);
    }
    throw Error('no Reader found on: ${nameOrAddress}');
};

export let triggerTemplate: Map<string, TriggerTemplate>;

// for use in code - no type checking at the moment
export let contracts: any;

// not resettable: contracts deployed programmatically, not from a blockchain fork
export let users: any = {};
export let localNodes = new Map<string, GraphNode>();

export const resetGraph = () => {
    // log('resetting graph');
    nodes = new Map<string, GraphNode>(); // address to object
    links = new Map<string, Link[]>(); // address to array of links, from -> to:Link[]
    backLinks = new Map<string, Link[]>(); // reverse of above, to -> from:Link[]
    roles = new Map<string, Role[]>(); // address to array of roles
    readerTemplates = new Map<string, ReaderTemplate[]>();
    triggerTemplate = new Map<string, TriggerTemplate>();

    // for use in code - no type checking at the moment
    contracts = {};
};
