import { getCachedValue, saveCacheValue } from './eat-cache';

// etherscan via http

export type getContractCreationResponse = { contractAddress: string; contractCreator: string; txHash: string };

export type getSourceCodeResponse = {
    SourceCode: string;
    ABI: string;
    ContractName: string;
    CompilerVersion: string;
    OptimizationUsed: number;
    Runs: number;
    ConstructorArguments: string;
    EVMVersion: string;
    Library: string;
    LicenseType: string;
    Proxy: number;
    Implementation: string;
    SwarmSource: string;
};

export class EtherscanHttp {
    constructor(public apikey: string, public baseUrl: string = 'https://api.etherscan.io/api') {}

    private async fetchES(request: Object): Promise<any | undefined> {
        const url =
            `${this.baseUrl}?apikey=${this.apikey}&` +
            Object.entries(request)
                .map(([k, v]) => [k, encodeURIComponent(v)].join('='))
                .join('&')
                .toString();

        const cached = await getCachedValue(url);
        if (cached) return JSON.parse(cached);

        const response = await fetch(url);
        if (response.status !== 200) {
            throw Error('something went wrong while querying etherscan');
        }
        const json = await response.json();
        if (json.message === 'OK' && json.status === '1' && json.result !== 'Max rate limit reached') {
            saveCacheValue(url, JSON.stringify(json.result));
            return json.result;
        } else {
            return undefined;
        }
    }

    public async getContractCreation(address: string[]): Promise<getContractCreationResponse[] | null> {
        return await this.fetchES({
            module: 'contract',
            action: 'getcontractcreation',
            contractaddresses: address.join(','),
        });
    }

    public async getSourceCode(address: string): Promise<getSourceCodeResponse[] | null> {
        return await this.fetchES({
            module: 'contract',
            action: 'getsourcecode',
            address: address,
        });
    }
}
