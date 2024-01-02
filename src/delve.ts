import * as fs from 'fs';
import { formatEther, formatUnits, ContractTransactionResponse, MaxInt256 } from 'ethers';
import { DataTable, fromCSV, toCSV, diff } from './datatable';
import * as crypto from 'crypto-js';

//////////////////////////////////
// regression system

type Variable = { name: string; value: bigint };

type ActionFunction = () => Promise<ContractTransactionResponse>;
type CalculationFunction = () => Promise<bigint>;
// TODO: maybe change those any's into templated types
type InstanceCalculationFunction = (instance: any) => Promise<bigint>;
type TypeNameFunction = { name: string; calc: InstanceCalculationFunction };
type RelationCalculationFunction = (a: any, b: any) => Promise<bigint>;
type RelationNameFunction = { name: string; calc: RelationCalculationFunction };

// TODO: define an interface that DelveSetup users should use, that DelveSetup implements
export class DelveSetup {
    public variables = new Map<string, { variable: Variable; initial: bigint }>();
    public calculations = new Map<string, CalculationFunction>(); // insertion order is retained in Map
    public actions = new Map<string, ActionFunction>(); // insertion order is retained in Map

    constructor(
        private aliases = new Map<string, string>(), // rename strings
        public separator = '.',
    ) {}

    private alias(orig: string): string {
        // replace all occurences of aliases keys in the orig string, with the alias value
        // return this.aliases.get(orig) || orig; only replaces the
        let result = orig;
        this.aliases.forEach((_v, _k) => {
            result = result.replace(new RegExp(`(\\b)${_k}(\\b)`, 'g'), `$1${_v}$2`);
        });
        return result;
    }

    public defVariable(name: string, value: bigint): Variable {
        if (this.variables.has(name)) {
            throw Error(`duplicate variable name: '${name}'`);
        }
        let result = { name: this.alias(name), value: value };
        this.variables.set(this.alias(name), { variable: result, initial: value });
        return result;
    }

    public defCalculation(name: string, calc: CalculationFunction): string {
        let rename = this.alias(name);
        this.calculations.set(rename, calc);
        return rename;
    }

    public defAction(name: string, act: ActionFunction): string {
        let rename = this.alias(name);
        this.actions.set(rename, act);
        return rename;
    }

    // define a set of calculations to be applied to all things of a given type
    public typeFunctions = new Map<string, TypeNameFunction[]>();
    public defType(type: string, calcForAll?: TypeNameFunction[]): string {
        if (calcForAll) this.typeFunctions.set(type, calcForAll);
        return type;
    }

    private thingTypes = new Map<string, any[]>();
    public defThing<T extends { name: string }>(that: T, type: string) {
        this.thingTypes.set(type, [...(this.thingTypes.get(type) || []), that]); // store it for the relations below
        let fns = this.typeFunctions.get(type); // returning null is OK as there may just be no functions
        if (fns) {
            fns.forEach((value) => {
                this.calculations.set(this.alias(that.name) + this.separator + this.alias(value.name), () => {
                    return value.calc(that);
                });
            });
        }
        return that.name.concat(' is ').concat(type);
    }

    // TODO: make defRelation delay its evaluation until the regression test is constructed
    // defines the relationship between types of things
    public relationFunctions = new Map<string, RelationNameFunction[]>();
    public defRelation<T1 extends { name: string }, T2 extends { name: string }>(
        forEachType: string,
        withEachType: string,
        calcs: RelationNameFunction[],
    ) {
        let forEachs = this.thingTypes.get(forEachType) || [];
        let withEachs = this.thingTypes.get(withEachType) || [];
        forEachs.forEach((forValue) => {
            withEachs.forEach((withValue) => {
                calcs.forEach((calc) => {
                    if (forValue != withValue) {
                        this.calculations.set(
                            this.alias(forValue.name) + this.separator + this.alias(withValue.name),
                            () => {
                                return calc.calc(forValue, withValue); // curried
                            },
                        );
                    }
                });
            });
        });
        // TODO: return a structure
        // return forEach.concat("_x_").concat(withEach);
    }

    public reset() {
        this.variables.forEach((v) => (v.variable.value = v.initial));
    }
}

type CalculationState = {
    name: string;
    func: CalculationFunction;
    // this is filled in during the calculations
    first: boolean; // the first row of this calculation
    allZeros: boolean; // can be removed for slim file
    prevValue: bigint; // used to determine the above and also work out deltas
    allSame: boolean; // can be removed in skinny file
    prevText: string;
};

// each Delver uses a DelveSetup
export class Delver {
    // what to show
    private calculations: CalculationState[] = [];

    // TODO:
    // attach a file name to the datatable
    private runData: DataTable;
    private runDelta: DataTable;
    private runParameters: DataTable;
    private runErrors: DataTable;
    private runErrorsMap = new Map<string, string>(); // map of error message to error hash string, stored in file .errors.csv

    public hasIndependent(v: Variable): boolean {
        //return this.runData.keyFields.includes(v.name);
        return this.independents.map((i) => i.name).includes(v.name);
    }

    // TODO: get rid of the variables - they are all actions, maybe?
    constructor(
        public setup: DelveSetup,
        public independents: Variable[],
        public actions: string[],
        calculationFilter?: string[],
    ) {
        // initialise the datatable
        // reset all the variables to their initial values
        this.setup.reset();

        // default calculations to sorted (case-insensitive) list
        for (let calcName of calculationFilter ||
            [...this.setup.calculations.keys()].sort((a, b) =>
                a.toLowerCase() < b.toLowerCase() ? -1 : a.toLowerCase() > b.toLowerCase() ? 1 : 0,
            )) {
            // TODO: ensure the calculations ae properly aliased (the ones from system should already be)
            // maybe we don't allow selection because we have slim, deltas, slim-deltas reports and
            let calcFn = this.setup.calculations.get(calcName);
            if (calcFn) {
                this.calculations.push({
                    name: calcName,
                    func: calcFn,
                    first: true,
                    allZeros: true,
                    allSame: true,
                    prevValue: 0n,
                    prevText: '',
                });
            } else {
                throw 'unknown calculation: ' + calcName;
            }
        }

        const keyFields = [...this.independents.map((v) => v.name), 'actionName'];
        const dataFields = [
            'actionResult',
            'gasUsed(wei)',
            'gasUsed(price=50gweix$2500)',
            'whatChanged',
            ...this.calculations.map((state) => state.name),
        ];

        this.runData = new DataTable(keyFields, dataFields);
        this.runDelta = new DataTable(keyFields, dataFields);

        const parameters = Array.from(this.setup.variables.values()).filter((v) => !this.hasIndependent(v.variable));
        this.runParameters = new DataTable(
            [],
            parameters.map((v) => v.variable.name),
        );
        this.runParameters.addRow(parameters.map((v) => formatEther(v.variable.value)));
        this.runErrors = new DataTable(['code', 'message'], []);
    }

    private formatError(e: any): string {
        let message = e.message || 'undefined error';
        let code = this.runErrorsMap.get(message); // have we encountered this error text before?
        if (code === undefined) {
            // first time this message has occurred - generate the code
            const patterns: [RegExp, (match: string) => string][] = [
                // specific messages
                [/^(contract runner does not support sending transactions)/, (match) => match[1]],
                // specific messages with extra info
                [/^(.+)\s\(.+"method":\s"([^"]+)"/, (match) => match[1] + ': ' + match[2]], // method in quotes
                // more generic messages
                [/'([^']+)'$/, (match) => match[1]], // message in quotes
                [/:\s([^:]+)$/, (match) => match[1]], // message after last ':'
            ];
            for (const [pattern, processor] of patterns) {
                const matches = message.match(pattern);
                if (matches) {
                    code = processor(matches);
                    break;
                }
            }
            if (code === undefined) {
                //const hash = createHash("sha256").update(message).digest("base64");
                const hash = crypto.SHA3(message, { outputLength: 32 }).toString(crypto.enc.Base64);
                code = 'ERR: '.concat(hash);
            }
            // TODO: ensure the code/message combination is unique
            this.runErrorsMap.set(message, code);
            this.runErrors.addRow([code, message]);
        }
        return code;
    }

    private formatEther(value: bigint) {
        const basic = formatEther(value);
        return basic.endsWith('.0') ? basic.slice(0, -2) : basic;
    }

    private formatWei(value: bigint) {
        const basic = formatUnits(value, 'wei');
        return basic.endsWith('.0') ? basic.slice(0, -2) : basic;
    }

    private formatDelta(before: bigint, after: bigint): string {
        const result = after - before;
        return (result > 0n ? '+' : '') + formatEther(result);
    }

    public async data() {
        // now add one (or more) rows of data:
        // one row, no actions, calculations
        // one row for each action + calculations

        for (let action of ['', ...this.actions]) {
            let dataLine = this.independents.map((variable) => this.formatEther(variable.value));

            let result = '-'; // no action
            let actionGas = 0n;
            const fn = this.setup.actions.get(action);
            if (fn) {
                try {
                    let tx = await fn();
                    let receipt = await tx.wait();
                    actionGas = receipt ? receipt.gasUsed : MaxInt256;
                    result = '\\o/'; // success
                } catch (e: any) {
                    result = this.formatError(e); // failure
                }
            }
            dataLine.push(action);
            dataLine.push(result);
            dataLine.push(this.formatWei(actionGas));
            dataLine.push('$' + formatEther(actionGas * 50n * 10n ** 9n * 2500n));

            const whatChangedIndex = dataLine.push('?') - 1;
            let whatChanged: string[] = []; // nothing changed yet

            let deltaLine = dataLine.slice(); // copy it

            for (let calcState of this.calculations) {
                let dataText: string;
                let deltaText: string;
                try {
                    let value = await calcState.func();
                    dataText = formatEther(value);
                    deltaText = this.formatDelta(calcState.prevValue, value);
                    calcState.allZeros = calcState.allZeros && value === 0n;
                    calcState.prevValue = value;
                } catch (e: any) {
                    dataText = this.formatError(e);
                    deltaText = dataText;
                }
                if (!calcState.first) {
                    calcState.allSame = calcState.allSame && dataText === calcState.prevText;
                    if (calcState.prevText !== dataText) whatChanged.push(calcState.name);
                }
                dataLine.push(dataText);
                deltaLine.push(deltaText);
                calcState.prevText = dataText.slice();
                calcState.first = false;
            } // calculations

            const whatChangeText = whatChanged.join(' ');
            dataLine[whatChangedIndex] = whatChangeText;
            deltaLine[whatChangedIndex] = whatChangeText;

            this.runData.addRow(dataLine);
            this.runDelta.addRow(deltaLine);
        } // actions;
    }

    public async done(fileRoot: string) {
        // TODO: get this passed in?
        let independents = this.independents.map((v) => v.name).join('_x_');
        if (independents !== '') independents = '-' + independents;
        const prefix = `${fileRoot}${independents}`;
        const suffix = '.csv';

        const dataFilePath = `${prefix}-data${suffix}`;
        const dataSlimFilePath = `${prefix}-data-slim${suffix}`;
        const deltaFilePath = `${prefix}-delta${suffix}`;
        const deltaSlimFilePath = `${prefix}-delta-slim${suffix}`;
        const parametersFilePath = `${prefix}-parameters${suffix}`;
        const errorsFilePath = `${prefix}-errors${suffix}`;

        fs.writeFileSync(errorsFilePath, toCSV(this.runErrors));
        fs.writeFileSync(parametersFilePath, toCSV(this.runParameters));

        fs.writeFileSync(dataFilePath, toCSV(this.runData));
        fs.writeFileSync(
            dataSlimFilePath,
            toCSV(
                this.runData,
                this.calculations.filter((c) => c.allSame).map((c) => c.name),
            ),
        );

        fs.writeFileSync(deltaFilePath, toCSV(this.runDelta));
        fs.writeFileSync(
            deltaSlimFilePath,
            toCSV(
                this.runDelta,
                this.calculations.filter((c) => c.allSame).map((c) => c.name),
            ),
        );
    }
    /*
    private compare(fileName: string) {
        const goodFilePath = this.goodDir + fileName;
        const runFilePath = this.runDir + fileName;
        expect(
            fs.existsSync(goodFilePath),
            `The good file (${goodFilePath}) doesn't exist. If this run is good,\n` +
                `      cp ${runFilePath} ${this.goodDir}`,
        ).to.be.true;

        const run = fs.readFileSync(runFilePath, 'utf-8');
        const good = fs.readFileSync(goodFilePath, 'utf-8');
        expect(run).to.equal(
            good,
            'This run is different to the good one.\n' +
                '      Compare the run results to the good resuts, e.g.\n' +
                `         bcompare ${runFilePath} ${goodFilePath}\n` +
                '      Then, if this run is good,\n' +
                `         cp ${runFilePath} ${goodFilePath}`,
        );
    }

    private remove = (fileName: string) => {
        const runFilePath = this.runDir + fileName;
        if (fs.existsSync(runFilePath)) fs.unlinkSync(runFilePath);
    };
    */
}

///////////////////////////////////////
