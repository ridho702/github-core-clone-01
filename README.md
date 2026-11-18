# github-core-clone-01

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/ridho702/github-core-clone-01/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/ridho702/github-core-clone-01/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A GitHub-compatible git forge in a single Node process: repositories, branches and commits, issues, pull requests, GraphQL v4, MCP tools, and git-over-HTTP (smart protocol v0 and v2, fetch and push). Built by an AI agent for make.fun's "Build a GitHub-compatible git forge" bounty, $500 in USDC.

## Run it

```sh
MAKEFUN_ENV_URL=http://127.0.0.1:8080 MAKEFUN_SHOP_TOKEN=dev-token node main.ts
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=pxdmc197&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>

## Running

Requires Node 22 or newer. No dependencies, no install step, no build step — the server is plain TypeScript with erasable syntax, run directly with Node's type stripping.

`main.ts` binds an ephemeral port, registers it with the environment at `MAKEFUN_ENV_URL`, and exits when the environment reports the trial is done. `MAKEFUN_SHOP_TOKEN` is the bearer token the REST, GraphQL and MCP surfaces accept (defaults to `dev-token` when unset, for local runs only).

## What it implements

- **Git over HTTP** — `info/refs` (protocol v0 and v2 advertisements), `git-upload-pack` (`ls-refs` and `fetch`, including shallow/deepen, ACK/NAK, packfile sideband), and `git-receive-pack` (fast-forward enforcement with `report-status`). Pack files are written without deltas and read with full OFS/REF delta support; annotated tags peel; empty repositories advertise an unborn `HEAD`.
- **REST v3** — repositories (create/list/get/patch/delete, paginated), branches, commits, refs, contents (create/update/delete files, directory listings), labels, issues and comments, pull requests (create, files diff, squash merge with conflict detection). Every reply is JSON with an `X-GitHub-Request-Id` header; missing tokens get 401, unknown owners get 404, duplicate repos get 422.
- **GraphQL v4** — `viewer`, `repository`, `node`, `__type` and the `createIssue`, `closeIssue`, `createPullRequest`, `mergePullRequest` and `addComment` mutations, with cursor pagination on issues, pull requests and files, and batching. A query for an unknown field answers 200 with an `errors` entry naming the field.
- **MCP** — Streamable HTTP (revision 2026-07-28), `server/discover` and `initialize`, `tools/list` and `tools/call` for `create_repo`, `get_repo`, `create_issue`, `list_issues`, `create_pull_request`, `merge_pull_request` (plus `get_issue` and `list_pull_requests`), with JSON-RPC errors for unknown tools and missing arguments.
- **One store** — all four surfaces read and write the same in-memory state, so a pull request merged over MCP shows up in REST and GraphQL, and a commit pushed over git is visible in the contents API.

## Architecture

| File | Contents |
| --- | --- |
| `main.ts` | The entry ↔ environment lifecycle (bind, register, wait for done). Not part of the forge. |
| `app.ts` | HTTP server, routing, auth, body parsing, request-id header. |
| `store.ts` | The in-memory model: repos, refs, objects, issues, pull requests, plus merge/diff helpers and the fetch object-selection logic. |
| `git.ts` | The git object model (SHA-1 ids, commits, trees), pkt-line codec, pack read/write, graph walks. |
| `git-http.ts` | The smart HTTP git endpoints: info/refs, ls-refs, fetch, receive-pack. |
| `rest.ts` | The REST v3 surface. |
| `graphql.ts` | A small GraphQL parser and executor for the v4 surface. |
| `mcp.ts` | The MCP server: discovery, tools/list, tools/call. |

The default viewer is the seeded user `adaiversen` (id 1000); repositories are owned by the viewer unless created under another owner, in which case reads answer 404.

## Development

Typecheck with `npx tsc --noEmit` (or run directly — `node main.ts` type-strips on the fly). To grade locally against the kit's conformance suite, start the server with a token and run the kit runner:

```sh
MAKEFUN_SHOP_TOKEN=dev-token node main.ts &
node --experimental-strip-types <kit>/sdk/run.ts --url http://127.0.0.1:<port> --token dev-token --json
```
