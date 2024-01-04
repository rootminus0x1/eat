export class DataTable {
    public data: string[][] = []; // 2d array of strings
    constructor(public keyFields: string[], public fields: string[]) {}

    public addRow(/* keys: bigint[], */ values: string[]) {
        // TODO: check the lengths of the array, etc.
        // TODO: ensure there are no duplicate keys
        this.data.push(values);
    }
}

const formatForCSV = (value: string): string =>
    // If the value contains a comma, newline, or double quote, enclose it in double quotes
    /[,"\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;

const unformatCSV = (csv: string): string =>
    // TODO: undo surrounding '"' and the internal ',', '"' and '\n' characters
    // if first and last char = '"' then do it else do nothing
    csv;

const getRows = (
    dt: DataTable,
    sanitise: (str: string) => string,
    ignoreColumns: string[] = [],
): { header: any[]; data: any[][] } => {
    const specialKeyField = false;
    // the superset headers
    let headerRowOfFields = [...dt.keyFields, ...dt.fields];
    // find the indices of the ignoreColumns
    let ignoreColumn = headerRowOfFields.map((name) => ignoreColumns.includes(name));
    headerRowOfFields = headerRowOfFields.filter((value, index) => !ignoreColumn[index]);
    let dataRowOfFields = dt.data.map((row) => row.filter((value, index) => !ignoreColumn[index]));

    if (specialKeyField) {
        headerRowOfFields = ['key:' + dt.keyFields.length.toString(), ...headerRowOfFields];
        dataRowOfFields = dataRowOfFields.map((row) => [row.slice(0, dt.keyFields.length).join(' x '), ...row]);
    }
    return {
        header: headerRowOfFields.map((heading) => sanitise(heading)),
        data: dataRowOfFields.map((row) => row.map((cell) => sanitise(cell))),
    };
};

export const toCSV = (dt: DataTable, ignoreColumns: string[] = []): string => {
    /*  CSV format
        h1,  h2,  h3\n
       v01, v02, v03\n
       v11, v12, v13\n
        :    :    :
       vn1, vn2, vn3\n
    */
    const rows = getRows(dt, formatForCSV, ignoreColumns);
    return [rows.header, ...rows.data].map((row) => row.join(',')).join('\n');
};

export const toYAMLByRow = (dt: DataTable, ignoreColumns: string[] = []): string => {
    /*  YAML format by row
        0:
         - h1: v01\n
         - h2: v02\n
         - h3: v03\n
        1:
         - h1: v11\n
         - h2: v12\n
         - h3: v13\n
        :
    */
    /*  YAML format by column
        h1:
         - v01\n
         - v11\n
         - :
        h2:
         - v02\n
         - v12\n
         - :
        :
    */
    /*
        const rows = getRows(dt, (str: string) => str, ignoreColumns);
    rows.data.map((v, i) => )
        .map((row) => row.join(','))
        .join('\n');
    */
    return '';
};

export function fromCSV(csv: string): DataTable {
    let lines = csv.split('\n');
    let result: DataTable | null = null;
    for (let l of lines) {
        let line = l.split(',').map((cell) => unformatCSV(cell));
        if (result === null) {
            // first time through, so this line is the header line
            let key = line.shift() || '';
            // the key field has a "n:" leader where n is the number of keys
            let keyCount = 0;
            const match = key.match(/:\s*(\d+)$/);
            if (match) {
                keyCount = parseInt(match[1], 10);
            }
            // we have keyCount key fields
            result = new DataTable(line.slice(0, keyCount), line.slice(keyCount));
        } else {
            result.addRow(line.slice(1));
        }
    }
    return result || new DataTable([], []);
}

interface Mapping {
    actual: number;
    expected: number;
}

export function diff(actual: DataTable, expected: DataTable): string[] {
    let result: string[] = [];
    // check the fields
    let usableKey = true;

    let expectedFields = [...expected.keyFields, ...expected.fields];
    let actualFields = [...actual.keyFields, ...actual.fields];
    let commonFields = new Map<string, Mapping>();
    let expectedToActual = new Map<number, number>(); // [expected row] -> actual row

    // non-matching key fields means that matching cannot be done on key values for
    // aligning rows of data with each other for comparison
    // to align rows on keys we need to record the respective indices of each
    for (let e of expectedFields.keys()) {
        const field = expectedFields[e];
        const isKey = expected.keyFields.includes(field);
        let a = actualFields.indexOf(field);
        if (a < 0) {
            // it's missing in actual report it, but is it a key or not?
            result.push(
                'missing '
                    .concat(isKey ? 'key ' : '')
                    .concat('field: ')
                    .concat(field),
            );
            usableKey &&= !isKey; // if the expected isn't a key field then the key is still usable
        } else {
            // check if both are keys or both not
            if (isKey != actual.keyFields.includes(field)) {
                usableKey = false; // keys must line up
                result.push((!isKey ? 'not ' : '').concat('expected to be key field: ').concat(field));
            }
            // it's common so map it
            commonFields.set(field, { actual: a, expected: e });
        }
    }
    // capture the extra fields
    for (let actualField of actualFields) {
        if (!expectedFields.includes(actualField)) {
            const isKey = actual.keyFields.includes(actualField);
            result.push(
                'extra '
                    .concat(isKey ? 'key ' : '')
                    .concat('field: ')
                    .concat(actualField),
            );
            usableKey &&= !isKey;
        }
    }
    // TODO: look up error table values instead of the *Error:n* values

    // compare the matching field
    // if the keys are matching.
    console.log(result.join('\n'));
    if (usableKey) {
        // create a mapping for actual & expected key values to their respective rows
        let expectedKeyMapping = new Map<string[], number>();

        // for each row, map all the keys
        for (let er = 0; er < expected.data.length; er++) {
            let key = expected.data[er].slice(0, expected.keyFields.length);
            expectedKeyMapping.set(key, er);
        }
        for (let ar = 0; ar < actual.data.length; ar++) {
            let key = actual.data[ar].slice(0, actual.keyFields.length);
            // lookup the key
            let er = expectedKeyMapping.get(key) || -1;
            // save the mapping
            if (er >= 0) expectedToActual.set(er, ar);
        }
    } else {
        // map one to one
        for (let r = 0; r < Math.min(expected.data.length, actual.data.length); r++) {
            expectedToActual.set(r, r);
        }
    }
    // now go through each column matching the expected rows to the actual rows via their keys
    // just match the columns, with no adjustment for row numbers
    for (let column of commonFields.keys()) {
        let mapping = commonFields.get(column) || null;
        if (mapping) {
            // TODO - use the row mapping
            for (const [er, ar] of expectedToActual.entries()) {
                let eValue = expected.data[er][mapping.expected];
                let aValue = actual.data[ar][mapping.actual];
                if (aValue != eValue) {
                    result.push(
                        '['
                            .concat(column)
                            .concat(',')
                            .concat(ar.toString())
                            .concat('|')
                            .concat(er.toString())
                            .concat('] mismatch\n    actual: ')
                            .concat(aValue)
                            .concat('\n  expected: ')
                            .concat(eValue),
                    );
                }
            }
        }
    }
    if (expected.data.length > actual.data.length) {
        result.push(
            'missing rows '
                .concat(actual.data.length.toString())
                .concat('..')
                .concat((expected.data.length - 1).toString()),
        );
    }
    if (actual.data.length > expected.data.length) {
        result.push(
            'extra rows '
                .concat(expected.data.length.toString())
                .concat('..')
                .concat((actual.data.length - 1).toString()),
        );
    }
    return result;
}
