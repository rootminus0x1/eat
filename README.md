# Ethereum Archaeology Tools

A suite of tools to help understand a set of contracts already deployed and to poke that set and observe results of those pokes

## The tools

### dig

Scan the ethereum blockchain and draw a clickable directed graph of contracts
Utilisises etherscan API amongst other things.

### delve

Poke the ethereum blockchain (or a local fork of it) and observe consequences of those pokes

## How to Use

### add this as a git submodule

`$ git submodule add <this repository(http://github.com/rootminus0x1/eat), or a fork> lib/eat`

you can store it in a place other than lib/eat and update the commands referring to lib/eat below

### make sure all the dependencies in the eat/package.json are included in your project

I know this is painful, but the alternative is for this to be released as package which I'm not ready to do
e.g.
`$ yarn add -D ts-node typescript js-yaml @types/js-yaml`

### ensure the tsconfig is compatibe

e.g.

### other things

add to `.gitignore`:

`eat-cache`

note that you can just delete this directory to clear the cache

### run it

`$ yarn ts-node lib/eat/src/dig <my local dig config>`

`$ yarn ts-node lib/eat/src/delve.ts <my local delve config>`

each outputs a set of files that match the config file name
these outputs should be checked into source control, as they form a regression test for changes

## Development

`$ yarn install`

there's no yarn test (yes, yes there should be), instead running the following commands generates new test results files that can be compared with those checked in.

`$ yarn dig <config file>`

`$ yarn delve`
