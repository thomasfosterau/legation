# legation

A modular sync engine built on [Effect](https://effect.website): named mutations replayed by server-authoritative rebase, CVR-tracked row patches downstream, typed collections with live queries, offline-first clients and a customisable transport.

> [!CAUTION]
> Experimental and pre-1.0, largely written with Claude Code. The API may change between minor versions. ESM only; targets Effect v4.

## Install

```sh
pnpm add @thomasfosterau/legation effect
```

Add the adapter packages your runtime needs; each package README lists its peers. `effect` is a peer: install one copy.

## Usage

```ts
const { client } = yield * Client.make({ nodes, mutations, clientGroupId, transport });
yield * client.subscribe(openTodos); // pin a read so the replica holds it
yield * client.mutate("todo/set", { id: "1", title: "ship it", done: false });
const rows = yield * client.query(openTodos);
```

A complete in-process example (server, client and loopback transport) is in [docs/overview.md](docs/overview.md#quick-start-in-process).

## Packages

| Package                                                                      | What it is                                                                                                                   |
| ---------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| [`@thomasfosterau/legation`](packages/effect)                                | The engine: collections, mutations, client, server, backend contract; `./internal` (adapter seams) and `./sql` (SQL backend) |
| [`@thomasfosterau/legation-browser`](packages/browser)                       | Service-worker host, elected tab host, IndexedDB store, tab mirrors, Cache API HTTP cache                                    |
| [`@thomasfosterau/legation-jsonapi`](packages/jsonapi)                       | JSON:API loaders, derived sync and REST handlers, the replica-served façade                                                  |
| [`@thomasfosterau/legation-alchemy-cloudflare`](packages/alchemy-cloudflare) | Cloudflare deployment on Alchemy: Durable Object rooms, fan-out, D1                                                          |
| [`@thomasfosterau/legation-auth`](packages/auth) (unpublished)               | effect-auth identities and read scopes for the sync tier                                                                     |
| [`@thomasfosterau/legation-svelte`](packages/svelte)                         | Svelte 5 hooks and the SvelteKit surface (`./kit`)                                                                           |
| [`@thomasfosterau/legation-devtools`](packages/devtools)                     | Headless devtools core and a Svelte panel                                                                                    |

## Docs

- [docs/overview.md](docs/overview.md): architecture, the quick start and the example apps.
- [CONTEXT.md](CONTEXT.md): the glossary. [docs/adr/](docs/adr/): design decisions.
- [docs/CONTRIBUTING.md](docs/CONTRIBUTING.md): workflow, toolchain and gates.
- [docs/PUBLISHING.md](docs/PUBLISHING.md), [docs/SECURITY.md](docs/SECURITY.md).

## License

[MIT](LICENSE.md)
