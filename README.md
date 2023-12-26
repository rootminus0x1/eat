# Ethereum Archaeology Tools

A suite of tools to help understand a set of contracts already deployed and to poke that set and observe results of those pokes

## The tools
### dig
Scan the ethereum blockchain and draw a clickable directed graph of contracts
Utilisises etherscan API amongst other things.

### delve
Poke the ethereum blockchain (or a local fork of it) and observe consequences of those pokes

## How to Use

$ git add submodule <this repository, or a fork>
$ node_ts path/to/eat/src/dig <my local dig config>
$ node_ts path/to/eat/src/delve.ts <my local delve config>

## Development

$ yarn install

there's no yarn test (yes, yes there should be), instead running the following commands generates new test results files that can be compared with those checked in.
$ yarn dig
$ yarn delve
