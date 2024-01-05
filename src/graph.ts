import { EATAddress } from './EATAddress';
// the nodes, also contains static information about the nodes, name, etc
export type graphNode = EATAddress & { stopper: boolean };
export const allNodes = new Map<string, graphNode>(); // address to object

// the links - between a from address (key) and to list of named addresses (value)
export type Link = { name: string; to: string };
export const allLinks = new Map<string, Link[]>(); // address to array of links

export type Measure = {
    name: string;
    calculation: () => Promise<bigint>; // TODO: change to bigint[]
};
export const allMeasures = new Map<string, Measure[]>();
