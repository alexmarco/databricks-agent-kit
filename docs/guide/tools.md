# Tools

`dak` exposes five tools. The definitions stay under 2,500 characters in total, so they cost little context in every
session.

| Tool              | Parameters                                                                                  | Purpose                                                                                                                                           |
| ----------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `list_objects`    | `catalog?`, `schema?`, `pattern?`, `limit?`, `refresh?`                                     | Without arguments, catalogs. With `catalog`, its schemas. With `catalog` and `schema`, its tables. `pattern` is a substring or a glob. Cached     |
| `describe_table`  | `full_name`, `refresh?`                                                                     | Columns, comments, primary and foreign keys, clustering, partitioning, owner and created or updated time and user. It starts no warehouse. Cached |
| `search_metadata` | `query`, `catalog?`, `limit?`                                                               | Find tables and columns by name or comment                                                                                                        |
| `execute_sql`     | `statement`, `parameters?`, `catalog?`, `schema?`, `row_limit?`, `warehouse_id?`, `export?` | One statement with `:name` parameters and bounded results. With `export`, the full result goes to a file                                          |
| `get_statement`   | `statement_id`, `wait_seconds?`, `cancel?`                                                  | Follow up a statement still running after 30 seconds, or an export. `wait_seconds` goes from 0 to 30. `cancel: true` cancels it                   |

## The usual workflow

Data questions follow the same path. The tools are designed for it, and they replace Genie for this purpose.

```mermaid
---
config:
  sequence:
    width: 120
    actorMargin: 40
    noteMargin: 8
---
sequenceDiagram
  participant A as Agent
  participant D as dak
  participant U as Unity Catalog
  participant W as SQL warehouse

  rect rgba(122, 79, 214, 0.14)
    Note over A,W: search_metadata
    A->>D: search_metadata("orders")
    D->>U: information_schema lookup
    U-->>D: matching tables<br/>and columns
    D-->>A: candidates
  end

  rect rgba(47, 111, 219, 0.14)
    Note over A,W: describe_table
    A->>D: describe_table(full_name)
    D->>U: table metadata
    D-->>A: columns, keys,<br/>owner, audit times
  end

  rect rgba(30, 158, 98, 0.14)
    Note over A,W: execute_sql
    A->>D: execute_sql(aggregated query)
    D->>W: read-only check,<br/>then the statement
    W-->>D: bounded result
    D-->>A: rows, truncated flag
  end

  opt Result too large
    rect rgba(30, 158, 98, 0.14)
      Note over A,W: execute_sql with export
      A->>D: execute_sql(...,<br/>export = parquet)
      D-->>A: statementId and<br/>export descriptor
    end
    rect rgba(224, 123, 0, 0.14)
      Note over A,W: get_statement
      A->>D: get_statement(statementId,<br/>wait_seconds = 30)
      D-->>A: export status and files
    end
  end
```

Aggregate in SQL when the result is large, and pass `export` when you need the full data in a file. The better your Unity
Catalog comments and keys, the better the agent's SQL.

## Details the table leaves out

- **`list_objects`** returns `truncated` when more objects matched than `limit` (default 100, maximum 500). `schema` without
  `catalog` is an error.
- **`search_metadata`** returns 50 matches by default, and at most 200.
- **`describe_table`** makes one Unity Catalog API call and no SQL statement, so it works with no running warehouse. It
  returns no tags, sample or lineage: ask for a sample with `execute_sql`. Times are ISO 8601.
- **Metadata cache.** `describe_table` and `list_objects` answer from `cache.db` while the entry is fresh, without a request
  to Databricks. A listing is cached whole, one entry per level, so one entry serves every `pattern` and `limit`.
  The `cache` field of the answer has the `status`, which is `hit` (served from a fresh entry), `miss` (no entry yet),
  `expired` (reloaded after the TTL), `refreshed` (reloaded because of `refresh: true`) or `bypassed` (the cache could not
  be read or written, so the answer came straight from Databricks and a `warn` is logged), and `cachedAt`, the ISO 8601
  time the answer was loaded. Pass `refresh: true` when you suspect a table or schema changed, for example after a DDL statement: the
  fresh answer replaces the entry. An error is never cached, and a failed reload returns the error, never the old answer.
  The TTL is `DAK_CACHE_TTL`, see [configuration](/guide/configuration). With `DAK_CACHE_TTL=0` the answers have no `cache`
  field.
- **`execute_sql`** takes `parameters` as a list of `{ name, value, type? }`. The value goes through the API and is never
  interpolated into the SQL text.
- **`get_statement`** follows any statement that is still running. A statement that runs longer than 30 seconds returns
  its `statement_id` so you can wait for it.

## Results and limits

- Results hold 100 rows by default. `row_limit` sets the number of rows, up to `DAK_MAX_ROWS` (default 1000).
- The result is also capped by size, at 100 KB.
- Both limits are applied by Databricks (`row_limit` and `byte_limit` of the Statement Execution API) and again by `dak`.
  A `LIMIT` clause is not needed, and a large result never floods the agent's context.
- `truncated: true` tells the agent to aggregate, filter or export.

The read-only check that runs before every statement is covered in [read-only mode](/guide/read-only).
