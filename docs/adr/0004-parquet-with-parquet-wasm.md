# ADR 0004: Parquet with `parquet-wasm` from Arrow chunks

- Status: Accepted
- Date: 2026-10-19

## Context

The API does not return Parquet and Node.js cannot write it out of the box. Two options were compared.

| Option                                           | Time per chunk | Extra memory | Types                                     |
| ------------------------------------------------ | -------------: | -----------: | ----------------------------------------- |
| `parquet-wasm` over `ARROW_STREAM`               |         137 ms |       ~35 MB | Preserved, including `STRUCT` and `ARRAY` |
| `hyparquet-writer` over `JSON_ARRAY` (synthetic) |         438 ms |       217 MB | Manual mapping; nested types are lost     |

The first row was measured with a real chunk of `samples.tpch.lineitem` (21 MB of Arrow); the second one, with synthetic data of 200,000 rows.

## Decision

Add `parquet-wasm` 0.9.0 (MIT or Apache-2.0, no transitive dependencies, 16 MB installed because it ships three builds; the Node WebAssembly file is 5.3 MB) as the only new dependency, pinned to an exact version. It is imported from `parquet-wasm/node`.

Each `ARROW_STREAM` chunk is passed as is to `Table.fromIPCStream` and written with `writeParquet`, with ZSTD and the other options at their defaults.

| Configuration tested       |   Time |   Size |
| -------------------------- | -----: | -----: |
| No compression             |  87 ms | 8.2 MB |
| SNAPPY                     | 109 ms | 5.0 MB |
| ZSTD                       | 137 ms | 4.0 MB |
| ZSTD without dictionary    |  99 ms | 3.7 MB |
| ZSTD, row groups of 64,000 | 132 ms | 4.1 MB |

## Consequences

- `dak` does not interpret data: it does not build schemas or decompress anything.
- Removing the dictionary improves only 7% and depends on the data, so the default is kept.
- The conversion is synchronous (0.1 to 0.2 s per chunk) and briefly blocks the server.
- Memory stays stable over 16 consecutive conversions.
- To be tested in the integration suite: `NULL`, `DATE`, `BINARY` and `MAP` with real data.
- The package is below version 1.0, hence the exact pin.
