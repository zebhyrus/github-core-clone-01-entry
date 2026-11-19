# github-core-clone-01-entry

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/zebhyrus/github-core-clone-01-entry/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/zebhyrus/github-core-clone-01-entry/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A standalone GitHub-compatible git forge, written in TypeScript with the Node
standard library only. No git binary, no network access, no outside services.

One process serves four surfaces on a single in-memory store:

- **Git smart HTTP** at `/{owner}/{repo}.git`: upload-pack protocol v2
  (capability advertisement, ls-refs, fetch with shallow/deepen support) and
  receive-pack v0 (report-status, side-band-64k, delete-refs). Repositories
  are created through REST only; pushes never invent a repo. Every update
  must fast-forward.
- **REST v3** under `/api/v3`: repositories, branches, git refs, commits,
  contents, labels, issues, and pull requests, including squash merge.
- **GraphQL** at `/api/graphql`: repository, issue, and pull request queries,
  connections with cursor pagination, and mutations.
- **MCP** at `/mcp`: JSON-RPC 2.0 Streamable HTTP with `server/discover`
  (revision 2026-07-28) and the legacy `initialize` handshake, exposing
  tools for repos, issues, and pull requests on the same store as REST.

State is fully deterministic: fixed timestamps, a logical id counter, and
sorted output everywhere, so a replay leaves the same state byte for byte.

## Run

```sh
node --experimental-strip-types main.ts
```

The forge binds an ephemeral port, registers it with the harness at
`$MAKEFUN_ENV_URL/register`, serves until `GET $MAKEFUN_ENV_URL/done`
returns `{"done": true}`, then exits 0. Set `MAKEFUN_SHOP_TOKEN` to the
Bearer token clients must present to the REST, GraphQL, and MCP surfaces.

## Layout

- `main.ts` — lifecycle: bind port 0, register, poll done, exit.
- `app.ts` — HTTP routing and auth gating.
- `store.ts` — in-memory store: git object model, packfiles, trees, merges.
- `git.ts` — pkt-lines, v0/v2 advertisements, ls-refs, fetch, receive-pack.
- `rest.ts` — REST v3 handlers.
- `graphql.ts` — GraphQL parser and executor.
- `mcp.ts` — MCP tools and JSON-RPC handling.

<sub>Entered on [make.fun](https://make.fun/?ref=9srzvfjv&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
