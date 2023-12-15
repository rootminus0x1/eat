console.log("hello!");

/*
import * as dotenv from 'dotenv';
import * as dotenvExpand from 'dotenv-expand';
dotenvExpand.expand(dotenv.config());

import { ethers } from 'ethers';

let provider: ethers.JsonRpcProvider;

async function exploreAddress(name: string, address: string, depth: number) {
    if (ethers.isAddress(address)) {
        const code = await provider.getCode(address);
        if (code !== '0x') {
            //exploreContract(address, code, depth);
        } else {
            console.log(`${address}, '${name}', is a non-contract address`);
        }
    } else {
        console.log(`${address}, '${name}', is not a valid address`);
    }
}

*/
async function main() {
//    provider = new ethers.JsonRpcProvider(process.env.MAINNET_RPC_URL);
//    console.log(`${process.env.MAINNET_RPC_URL}, block: ${await provider.getBlockNumber()}`);

    let root = '0xe7b9c7c9cA85340b8c06fb805f7775e3015108dB'; // it's a proxy to market
//    await exploreAddress('root', root, 0);

    // TODO: discover if the proxy holds stuff or the thing pointed to

//    let balance = ethers.parseEther('1.0');
const balance = 0;
    console.log('hello world', balance);
}

// use this pattern to be able to use async/await everywhere and properly handle errors.
main().catch((error) => {
    console.error('Error: %s', error);
    process.exitCode = 1;
});
