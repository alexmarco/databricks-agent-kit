# ADR 0002: Columnar JSON output for queries

- Status: Accepted
- Date: 2026-10-19

## Context

The output of `execute_sql` is read by a model, so the criterion is the cost in tokens. It was measured with the `o200k_base` tokenizer (an approximation; the Claude tokenizer is not public) on 100 rows and 8 columns with nulls.

| Format                                    | Tokens | Ratio |
| ----------------------------------------- | -----: | ----: |
| Array of JSON objects                     |   7966 |  100% |
| `{ columns, rows }` (the current one)     |   5555 |   70% |
| `{ columns, rows }` with unquoted numbers |   5467 |   69% |
| CSV with header                           |   5258 |   66% |
| Markdown table                            |   6108 |   77% |

## Decision

Keep `{ columns: [{ name, type }], rows: [[...]] }` with values as text and `null` for SQL `NULL`.

## Consequences

- An array of objects costs 43% more because it repeats the keys in every row.
- CSV saves only 5% more and cannot tell `NULL` from the empty string.
- Writing numbers without quotes saves 1%, but it requires converting `BIGINT` and `DECIMAL` to numbers and losing precision. It is not worth it.
- The real saving is exporting large results instead of returning them ([ADR 0003](0003-export-with-external-links.md)).
