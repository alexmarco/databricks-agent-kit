# ADR 0012: Warehouse selection module

- Status: Accepted
- Date: 2026-10-19

## Context

ADR 0009 moved statement execution into the statement lifecycle module and left `src/sql.ts` holding only warehouse selection, behind the name `createSqlService`. That name no longer describes the file: it does not run SQL. The responsibility is a separate one with its own state (the remembered automatic choice) and its own rules. Issue #9 (spec: issue #3) gives it a module with its own name, file and suite.

## Decision

The **warehouse selection** module lives in `src/warehouses.ts`: `createWarehouseSelection(client, { defaultWarehouseId, onWarehouseChosen? })` returns a `WarehouseSelection` with two methods.

| Method            | Behaviour                                                                                                                                                                                                                                  |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `resolve(explicit?)` | The warehouse id to use. An explicit id wins, then `defaultWarehouseId` (setting or profile), then the automatic choice: a running warehouse, else a serverless one, else the first accessible one. No accessible warehouse is a `SqlError` that names `DATABRICKS_WAREHOUSE_ID` |
| `list()`          | The accessible warehouses (`WarehouseSummary`) with the default marked: the configured one, or the one the automatic choice would pick                                                                                                    |

- **The automatic choice is remembered** for the life of the module; a failed choice (no warehouse) is not, so a later call retries. An explicit or configured warehouse never lists warehouses.
- **The choice event is emitted once**, when the automatic choice is made, through `onWarehouseChosen({ warehouseId, name, reason })` with `reason` one of `running`, `serverless`, `first`. A failure of the callback never fails the request. Neither an explicit or configured warehouse nor `list()` emits it.
- **Method names drop the noun**: the module is `warehouses`, so `warehouses.resolve()` and `warehouses.list()` replace `sql.resolveWarehouse()` and `sql.listWarehouses()`. The `resolveWarehouse` option of the statement lifecycle keeps its name: there it describes the injected function (`resolveWarehouse: warehouses.resolve`).
- **Callers hold it as `warehouses`**: the server (`resource://databricks/warehouses` calls `warehouses.list()`), the composition in `src/cli.ts` and the doctor, which builds its own selection and passes `warehouses.resolve` to the lifecycle. The `warehouse_id` argument handling, the resource and the log entry ("Warehouse chosen automatically", `info`, once) are unchanged.
- **Dependencies point one way**: the module depends on `DatabricksClient` and on `SqlError` from the lifecycle module (for the actionable error); the lifecycle depends on a function, not on this module.

Alternatives considered:

- *Keep `src/sql.ts` and the `SqlService` name*: the name promises SQL execution that the module does not offer. Rejected.
- *Fold selection into the statement lifecycle*: it would mix a stateful discovery concern with statement submission and polling, which is what the spec separates. Rejected.
- *A class with `resolveWarehouse` and `listWarehouses` kept as names*: `warehouses.resolveWarehouse()` repeats the noun at every call site. Rejected.

## Consequences

- The selection rules are tested only in `test/warehouses.test.ts`, at the module interface against a fake Databricks client; the old `test/sql.test.ts` is gone.
- Server tests fake `WarehouseSelection` (`warehouses` in the shared test helpers) and keep their behavioural assertions; the end-to-end tests are unchanged.
- ADR 0009 is not rewritten: where it says that warehouse selection stays in `src/sql.ts`, this ADR is the current state.
- The workspace session module (issue #8) builds one `WarehouseSelection` per session, with the choice hook connected to the log service, and hands `warehouses.resolve` to the lifecycle.
