import { Project } from 'ts-morph';

const project = new Project();
project.addSourceFilesAtPaths('src/**/*.ts');

const globalVariables: string[] = [];

project.getSourceFiles().forEach((sourceFile) => {
    sourceFile.getVariableDeclarations().forEach((variableDeclaration) => {
        const variableName = variableDeclaration.getName();
        const isGlobal = !variableDeclaration
            .getAncestors()
            .some((ancestor) => ancestor.getKindName().startsWith('Function'));

        // Exclude if the variable is a function
        const isFunction = variableDeclaration.getType().getCallSignatures().length > 0;

        if (isGlobal && !isFunction) {
            globalVariables.push(variableName);
        }
    });
});

console.log('Global Variables:', globalVariables);
