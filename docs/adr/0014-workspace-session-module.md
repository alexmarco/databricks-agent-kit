# ADR 0014: Workspace session module

- Status: Accepted
- Date: 2026-10-19

## Context

`src/cli.ts` built the Databricks side of the server by hand. `runMcp` resolved credentials and created the client, the warehouse selection, the statement lifecycle, the metadata service and the export manager inside a memoized loader. It exposed them to the MCP server through a `Proxy` (`lazy`) that needed a special case for `then` (it already caused a bug fix), and it kept a loose variable (`createdExports`) so that shutdown could close the exports without triggering credential resolution. `runDoctorCommand` rebuilt its own client, warehouse selection and statement lifecycle with smaller limits through eight injected dependencies. Credentials, hooks and limits were therefore wired in two places that could drift apart, and the composition was only tested end to end. Issue #8 (spec: issue #3) puts the composition behind one module.

## Decision

A new module, the **workspace session** (`src/workspace-session.ts`), owns resolving credentials, creating the Databricks modules from settings, the hooks that connect them to the log service, and closing. It has two entry points over one construction path.

**`connectWorkspace(adapters, options)`** resolves credentials once and builds a `WorkspaceConnection`: `{ auth, client, warehouses, statements }`. The doctor uses it.

**`createWorkspaceSession(adapters, options)`** is what the server uses. It returns a `WorkspaceSession`:

| Member        | Behaviour                                                                                                                                                                                                                                                              |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `workspace()` | The `Workspace`: the connection plus `metadata` and `exports`. The first call resolves credentials and builds everything; later calls return the same workspace. A failed resolution is not remembered: the next call tries again, so fixing credentials needs no restart |
| `scope`       | The one `ExecutionScope` of the session, created from its log service. The lifecycle (`annotate`), the export manager and the MCP server share it, so diagnostics always reach the final entry                                                                          |
| `close()`     | Cancels the running exports (and their Databricks statements). It never resolves credentials: when no workspace was created, or the last resolution failed, there is nothing to close                                                                                  |

Inputs:

| Input                                    | Meaning                                                                                                                                                                                                                                                                      |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `adapters.resolveAuth(onRefresh?)`       | Resolves credentials; `onRefresh(method)` is called each time an OAuth token is fetched                                                                                                                                                                                      |
| `adapters.createClient(auth, observers)` | Creates the REST client; `observers` are `onRetry` and `onRequest`                                                                                                                                                                                                           |
| `adapters.fetch`, `adapters.sleep`       | Plain `fetch` (presigned chunk downloads, ADR 0003) and the timer, for the export manager and the polling of the lifecycle                                                                                                                                                   |
| `options.warehouseId`                    | Configured warehouse; the profile's warehouse is the fallback (`options.warehouseId ?? auth.profileWarehouseId`)                                                                                                                                                             |
| `options.limits`                         | `maxRows`, `allowWrites`, `maxResultBytes` and optional `maxExportBytes` of the statement lifecycle                                                                                                                                                                          |
| `options.logs`                           | Log service. With it the session writes "Databricks credentials resolved" on the lifecycle execution and connects the token refresh, retry, request and "Warehouse chosen automatically" events to `logs.current()`. Without it (the doctor) no hook is installed and the lifecycle gets no scope |
| `options.exportDir`                      | Export directory (session only)                                                                                                                                                                                                                                              |

- **One instance per session.** The warehouse selection, and so its remembered automatic choice and its once-only event, lives in the workspace: a new session starts with no choice. The workspace is built once and reused, including by every HTTP request, which gives each MCP server instance the same modules.
- **The doctor keeps its smaller limits as options.** `src/doctor.ts` owns `DOCTOR_LIMITS` (`maxRows` 10, writes disabled, `maxResultBytes` 10 000) and `src/cli.ts` passes them to `connectWorkspace`. The doctor passes no `logs`, so its lifecycle has no scope, as before. Its dependencies shrink from `resolveAuth`, `createClient` and `createStatements` to one `connect()` that returns the connection; the report does not change.
- **The MCP server asks the session instead of holding a proxy.** `ServerDependencies.workspace()` replaces `warehouses`, `statements`, `metadata` and `exports`. Each tool handler and the warehouses resource awaits it inside the execution scope, so a failed resolution becomes the single final entry and the `isError` result of that call. The `Proxy`, its `then` special case and `createdExports` disappear, and the shutdown sequence of `cli.ts` calls `session.close()`.
- **The statement lookup stays in the server** (ADR 0011). It is a pure composition of `statements` and `exports`; the server builds it from the workspace on each `get_statement` call. Moving it into the session would not remove the server's need for `exports.start`.
- **What stays in `src/cli.ts`**: argument parsing, the transport choice, signal and stdin handling, the 401 rate limiter, the stop sequence (stop the transport, `session.close()`, close the logs) and the real adapters.

Alternatives considered:

- *One session that also serves the doctor (optional `logs`, `exports` and `metadata`)*: the doctor would build an export manager it never uses and need a scope it cannot have. Sharing `connectWorkspace` gives the same wiring without that. Rejected.
- *Keep the server dependencies and hand-write lazy facades for each module*: about a dozen one-line delegations that repeat the interfaces of four modules. Rejected in favour of `workspace()`.
- *Pass the scope into the session from `cli.ts`*: nothing would stop a caller from handing the lifecycle and the server different instances, which silently loses `checkMs` and `warehouseId`. The session creates it and exposes it. Rejected.

## Consequences

- The behaviour "starts without credentials, fails the first call with the authentication error, succeeds once they are fixed, closes without resolving credentials" is tested at the interface of one module (`test/workspace-session.test.ts`) against fake adapters, besides the unchanged end-to-end tests.
- `ServerDependencies` changes; the server tests keep their assertions and receive the modules through `workspace`.
- ADR 0011 and ADR 0013 are not rewritten: where they say that the workspace session slice may move the construction, this ADR is the current state.
