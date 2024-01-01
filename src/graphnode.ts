// holds the data for the directed graph

export enum GraphNodeType {
    unknown,
    contract,
    address,
    invalid,
}

export class GraphContract {
    constructor(public address: string, public name: string) {}
}

export class GraphNode {
    constructor(public address: string) {
        this.type = GraphNodeType.unknown;
        this.name = address.slice(0, 5) + '..' + address.slice(-3);
    }
    public name: string;
    public type: GraphNodeType;
    public token?: string;
    public links: { to: string; name: string }[] = [];
    public contract?: GraphContract; // extra contract info
    public implementations: GraphContract[] = []; // historical implementation logics
}
