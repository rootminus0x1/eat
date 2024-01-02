import { ContractWithAddress, UserWithAddress, deploy, getUser, getContract } from './blockchain';

import { PAMSystem } from './PokeAndMeasure';

export const addUser = async (system: PAMSystem, name: string, types: string[] = []): Promise<UserWithAddress> => {
    const user = await getUser(name);
    types.map((type) => system.defThing(user, type));
    return user;
};
