# ADR 0021: Metadata cache and a REST-only `describe_table`

- Status: Accepted
- Date: 2026-11-03

## Context

Agents call `list_objects` and `describe_table` repeatedly, within a session and across sessions, for metadata that changes rarely. Each call goes to Databricks again:

- `describe_table` always runs a SQL query on `system.information_schema.table_tags` and `column_tags` to read tags, so every description starts a SQL warehouse when none is running. `sample_rows` and `lineage` add further SQL queries.
- `list_objects` pages through the Unity Catalog API. The tables of a schema come at most 50 per page, so a schema with 2000 tables takes 40 requests.

The Unity Catalog REST API gives everything a description needs without a warehouse. `GET /api/2.1/unity-catalog/tables/{full_name}` returns the columns (`name`, `type_text`, `nullable`, `comment`), the table comment, `table_constraints` (primary and foreign keys), `created_at`, `created_by`, `updated_at` and `updated_by`.

There is no cheaper way to check whether one table changed. `GET .../tables/{full_name}/exists` returns only `table_exists`, `GET /api/2.1/unity-catalog/table-summaries` returns no timestamps, and reading `updated_at` takes the same `GET` as the full description. The API reference does not document which changes update `updated_at`.

## Decision

### `describe_table` uses only the REST API

`describe_table` never starts a warehouse. Its only call is `GET /api/2.1/unity-catalog/tables/{full_name}`.

- **Removed:** tags, `sample_rows` and `lineage`, with their code in `src/metadata.ts`. A sample is a query: the agent runs it with `execute_sql`.
- **Kept:** full name, table type, format, comment, owner, columns (name, type, nullable, comment), `primaryKey`, `foreignKeys`, clustering and partitioning columns, and `notes`.
- **Added:** `createdAt`, `createdBy`, `updatedAt` and `updatedBy`, with the times in ISO 8601. `viewDefinition` is not returned: it can be long and the agent does not need it to write SQL.

### What is cached

Two kinds of cache entry, each holding the full answer of one Databricks lookup:

| Kind      | Key                                                                           | Value                                                        |
| --------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------ |
| `table`   | Full table name, lowercase                                                    | The description of `describe_table`                          |
| `listing` | Empty (catalogs), `catalog` (schemas) or `catalog.schema` (tables), lowercase | The full listing of that level, before `pattern` and `limit` |

`list_objects` applies `pattern` and `limit` to the cached listing, so one entry serves every pattern and limit. `search_metadata` and `execute_sql` are not cached: a search is free text and runs on a warehouse, and a query returns data.

Keys are lowercase because Unity Catalog names are case-insensitive.

### Freshness: a fixed TTL

- An entry is fresh for a fixed TTL, 24 hours by default (`DAK_CACHE_TTL` in seconds). Expiry is computed when the entry is read, from the time it was loaded, so a new TTL applies at once to existing entries.
- A fresh entry is served with no call to Databricks. An expired entry is loaded again and replaced.
- `refresh: true` on `describe_table` and `list_objects` skips the cache; the fresh answer replaces the entry.
- Each reload compares the new value with the stored one and counts whether it changed, so the statistics show whether the TTL is too short.
- Errors are never cached, and a failed reload returns the error, never the stale value: a revoked permission must show.
- Writes through `execute_sql` do not invalidate entries. The agent uses `refresh: true` after a DDL change.

Each cached tool answer carries `cache: { status, cachedAt }`. The status is `hit` (served from the cache), `miss` (no entry), `expired` (entry reloaded after its TTL), `refreshed` (reload forced with `refresh`) or `bypassed` (the cache failed and the call went straight to Databricks). The execution scope also records the status on the final log entry of the call (ADR 0013).

### Identity

Unity Catalog permissions are the security boundary, so two identities never share an entry. Every entry belongs to a **cache identity**: a SHA-256 hash, computed locally, of the workspace host, the authentication method and the credential that identifies the principal:

| Method    | Credential in the hash |
| --------- | ---------------------- |
| PAT       | The token              |
| OAuth M2M | The `client_id`        |
| OAuth U2M | The profile name       |

The cache does not compute the identity: the credentials resolved by the workspace session provide it (ADR 0014). It needs no request and no preview API, and stores no secret in clear.

In HTTP mode every client acts as the server's single Databricks identity (`docs/design.md`, 4.5), so they share its entries, which is correct: each of them would get the same answer from the API. Two servers with different credentials that share `DAK_STORAGE_DIR` are kept apart. If on-behalf-of authentication is added, the principal it validates becomes the cache identity without changing the cache.

### Storage

A disposable SQLite file, `cache.db` in `DAK_STORAGE_DIR`, through `node:sqlite` (no new dependency), separate from `logs.db` so it can be deleted or purged on its own.

- WAL, `synchronous=NORMAL` and `busy_timeout=5000`: several `dak` processes share the file, and losing the last writes in a crash only costs a reload.
- One `WITHOUT ROWID` table keyed by (identity, kind, key), holding the JSON value, the load times and the counters, with an index on the last use for the purge. Prepared statements and `UPSERT`.
- `PRAGMA user_version` holds the schema version. A file with another version, or one that cannot be opened, is deleted and created again.
- Owner-only permissions outside Windows, as for `logs.db`.
- Entries not used for 30 days are purged at startup and every 24 hours, with a timer that does not keep the process alive, as the log service does (section 6.3 of the design). This works the same in stdio mode and in a long-running HTTP server.
- `loadDatabaseSync`, today copied in the log repository and the SQLite export sink, moves to one shared module.

The cache never breaks a tool call. When it fails to read or write, the call goes straight to Databricks, its answer carries the status `bypassed` and the failure is logged as `warn`.

### Statistics

Two resources, not tools (ADR 0006):

- `resource://cache/stats`: the totals of the current cache identity, summed over its live entries and split by kind: entries, hits, misses, expirations, refreshes, reloads with and without changes, hit ratio, estimated time saved (each entry's hits times the duration of its last load) and the time the oldest entry was first loaded.
- `resource://cache/entry/table/{full_name}` and `resource://cache/entry/listing/{path}`: one entry with its counters, `cachedAt`, `expiresAt`, `lastUsedAt` and the duration of its last load.

Statistics are limited to the current identity: mixing identities distorts the figures and reveals what another identity looks up. Counters of a purged entry are lost; it had not been used for 30 days. `bypassed` answers are not counted, because the cache failed; they are in the log. `dak doctor` checks that `cache.db` opens and is writable, its schema version and the effective TTL, and says when the cache is disabled.

### Configuration

| Setting   | Environment     | Default | Meaning                                       |
| --------- | --------------- | ------- | --------------------------------------------- |
| Cache TTL | `DAK_CACHE_TTL` | `86400` | Seconds an entry is fresh; `0` disables cache |

With the cache disabled, no `cache.db` is opened, the answers carry no `cache` field and the resources say that the cache is disabled.

## Alternatives considered

- _`DESCRIBE TABLE EXTENDED ... AS JSON` or `information_schema` as the source_: they need a running warehouse. Rejected.
- _Tags through the Entity Tag Assignments API_ (`GET /api/2.1/unity-catalog/entity-tag-assignments/{entity_type}/{entity_name}/tags`): no warehouse, but one call per entity, so a table with 200 columns takes 201 calls. Tags are not needed for now. Rejected.
- _Revalidate an expired entry by comparing `updated_at`_: reading `updated_at` costs the same `GET` as the description, and what updates it is not documented. Rejected in favour of reloading.
- _Stale-while-revalidate_: it serves stale data before knowing whether the permission still holds, against the rule that errors show. Rejected.
- _Adaptive TTL (longer after unchanged reloads)_: it saves a few cheap reloads at the cost of an expiry that is harder to predict. Deferred until the statistics justify it.
- _Cache identity from `GET /api/2.0/preview/scim/v2/Me`_: exact, but a Public Preview API with no documented behaviour for service principals, and a request per session. _From the `sub` claim of the OAuth token_: depends on a token format that Databricks does not document. Both rejected.
- _Invalidate entries when `execute_sql` runs DDL_: it needs SQL parsing that is fragile. Rejected.
- _An in-memory cache only_: lost at the end of each stdio session and not shared between processes. Rejected.
- _A table in `logs.db`_: it couples the cache to the log retention and to log diagnostics. Rejected.
- _Lifetime counters that survive the purge_: more state for figures about entries unused for a month. Deferred.

## Consequences

- The public contract of `describe_table` changes: `sample_rows`, `lineage` and the tags disappear, and `createdAt`, `createdBy`, `updatedAt`, `updatedBy`, `refresh` and `cache` appear. `list_objects` gains `refresh` and `cache`. Clients that relied on the removed fields must use `execute_sql`.
- No implicit warehouse start remains. `search_metadata` and `execute_sql` still use a warehouse, because the agent asks for them.
- `dak doctor` loses its lineage system tables check, and its `information_schema` check only concerns `search_metadata`.
- A description can be up to 24 hours old. The answer shows `cachedAt`, and `refresh: true` reloads it.
- A new login with another account under the same U2M profile keeps the same cache identity. `cache.db` is in the user's own state directory, so this only affects one person with two accounts.
- The tool definitions stay within the budget that the tests assert (`docs/design.md`, 4.1): `sample_rows` and `lineage` leave, `refresh` arrives in two tools.
- The README, the guide, `docs/architecture.md` and its diagram change with the implementation.
