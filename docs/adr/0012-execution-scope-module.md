# ADR 0012: Execution scope module

- Status: Accepted
- Date: 2026-10-19

## Context

ADR 0007 fixed the logging policy: one entry per call, written when it ends, at the level of the error class. The sequence "open an execution, run inside its scope, write one entry, close it as completed, failed or cancelled" was written by hand three times: in the `tool()` helper of `src/server.ts`, in the recorded branch of `resource()`, and in `runJob` and `start` of the export manager. The rule "exactly one entry per tool call" held by convention in each copy. The diagnostics of a tool call (`checkMs`, `warehouseId`) travelled from the tool handler down to the statement lifecycle and the export manager as a mutable out-parameter (ADR 0009, ADR 0010), so two interfaces carried a logging concern. Issue #7 (spec: issue #3) puts the sequence behind one module and removes the parameter.

## Decision

A new module, the **execution scope** (`src/execution-scope.ts`, `createExecutionScope(logs)`), owns the sequence. It is built on the log service, whose `startExecution`, `run` and `current` it uses; the log service and the log data model do not change.

| Member                                  | Behaviour                                                                                                                                                                                                                                                  |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `run(target, work, entry?)`             | Opens an execution for `target` (`toolName`, `resourceUri`...), runs `work(execution)` with it as the current one, ends it and rethrows the error of `work`, if any, after the execution has ended. `work` receives the execution handle for events of its own |
| `annotate(diagnostics)`                 | Adds `checkMs` or `warehouseId` to the final entry of the current scope (the one `logs.current()` reports); outside any scope it does nothing                                                                                                              |
| `ExecutionCancelled`                    | Error that `work` throws to end the execution as `cancelled`                                                                                                                                                                                               |
| `FinalEntry<T>` (`message`, `arguments?`, `summarize?`) | The optional third argument of `run`: what the single final entry says                                                                                                                                                                     |

Final status and entry:

| Outcome of `work`                  | Status      | Entry                                                                                                                                                            |
| ---------------------------------- | ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Resolves                           | `completed` | With `entry`: one `info` entry `entry.message` with `{ ...arguments, durationMs, ...summarize(result), ...diagnostics }`. Without it: none                       |
| Throws `ExecutionCancelled`        | `cancelled` | None                                                                                                                                                             |
| Throws a `DakError`                | `failed`    | One `warn` entry without stack trace; with `entry` its metadata is `{ ...arguments, durationMs, ...diagnostics }`, without it none                               |
| Throws any other error             | `failed`    | One `error` entry with the stack trace and the same metadata                                                                                                     |

- **The level by error class stays with the log service.** `ExecutionHandle.fail(error, metadata?)` already chooses `warn` or `error` (ADR 0007); the scope calls it and does not decide levels again.
- **Diagnostics travel through the current scope.** They are kept per execution in a `WeakMap` keyed by the execution handle, and `annotate` finds the handle with `logs.current()`, the same way the "warehouse chosen" event already finds its execution. Concurrent scopes therefore never mix: each run has its own record and each async context its own current execution. Outside a scope `logs.current()` is the lifecycle execution, which has no record, so a stray `annotate` is ignored.
- **`ExecutionDiagnostics` moves to this module.** The statement lifecycle takes an optional `scope` option (`Pick<ExecutionScope, "annotate">`) and calls `scope.annotate({ checkMs })` after the read-only check and `scope.annotate({ warehouseId })` when it submits an export. `submit` and `submitExport` lose their `diagnostics` parameter, and so does `exports.start`. Without `scope` (the doctor, the metadata queries' own tests) nothing is reported, as before.
- **Tool calls** use `run({ toolName }, ..., { message: "Tool call completed", arguments: describeArguments(args), summarize })`. The server turns the rethrown error into an `isError` result. **Recorded resource reads** use `run({ resourceUri }, ...)` without `entry`: they write nothing on success and one entry without metadata on failure, as before. **Unrecorded log resource reads** do not use the scope: they open no execution (ADR 0007).
- **Background exports** use `run({ toolName: "export" }, ...)` without `entry`. The export manager keeps writing its own events ("Export started", chunk events, "Export finished" with rows, bytes and duration), which are not the final entry of a call, and ends in `ExecutionCancelled` when the job was cancelled, so a cancelled export is `cancelled` and a failed one is `failed`, by the same rules as a tool call. The manager receives the scope instead of the log service.
- **Who builds it.** `src/cli.ts` creates one scope from the log service and passes it to the statement lifecycle, the export manager and the server (`ServerDependencies.scope`), so that all three see the same record of diagnostics. The workspace session slice may move this construction.

Alternatives considered:

- *Keep the out-parameter and only share the ceremony*: the interfaces of the lifecycle and the manager would keep a logging concern (spec user story 15). Rejected.
- *A second `AsyncLocalStorage` owned by the scope*: two ambient contexts that must be kept in step; `logs.current()` already is the ambient execution. Rejected.
- *Put the final entry into the log service* (`LogService.runTool`): it would learn about arguments, result summaries and diagnostics, which are concerns of the callers; the scope keeps the log service a plain writer. Rejected.
- *Let `work` return its status instead of throwing `ExecutionCancelled`*: every caller would unwrap a result envelope to support one caller that cancels. Rejected.

## Consequences

- "Exactly one entry per call" is enforced where it is implemented and tested through the scope's interface (`test/execution-scope.test.ts`): level by error class, final statuses including cancelled, diagnostics reaching the entry, concurrent scopes.
- The statement lifecycle and export interfaces carry no diagnostics parameter. A new diagnostic is a new optional field of `ExecutionDiagnostics` and an `annotate` call where it is known.
- The content of `resource://logs/*`, the log schema, the metadata keys and the statistics do not change.
- The suites that fake the lifecycle or the export manager report diagnostics through the scope instead of a parameter.
