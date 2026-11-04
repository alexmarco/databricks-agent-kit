# ADR 0024: A disabled metadata cache is an adapter

- Status: Accepted
- Date: 2026-11-04

## Context

[ADR 0021](0021-metadata-cache.md) added the metadata cache and decided that `DAK_CACHE_TTL=0` disables it: no `cache.db` is opened, the answers carry no `cache` field and the cache resources say that the cache is disabled. It modelled the disabled cache as an absent value, `MetadataCache | undefined`, while the other case in which no cache serves a lookup, a `cache.db` that cannot be opened, is already an adapter that answers every lookup from Databricks as `bypassed`.

The absent value made every consumer of the cache decide what to do without one. The metadata service branched twice, in `listObjects` and in `describeTable`; the two cache resources branched on it; and the workspace session built a cache conditionally and closed it with `cache?.close()`. The codebase design review of 2026-11-04 (issue #89) counted the branches and found that the metadata service and the session should not need to know which kind of cache they hold.

## Decision

The disabled cache is `disabledMetadataCache`, one more adapter of the `MetadataCache` interface in `src/metadata-cache.ts`:

| Member        | Disabled cache                                                                                                    |
| ------------- | ----------------------------------------------------------------------------------------------------------------- |
| `enabled`     | `false`. A working cache, and the fallback for a `cache.db` that cannot be opened, are `true`                     |
| `lookup(...)` | Runs `load` every time and gives `{ value }`: no `cache` info, so the answer says nothing about how it was served |
| `entry(...)`  | `undefined`                                                                                                       |
| `stats()`     | The counters of an empty cache                                                                                    |
| `close()`     | Does nothing                                                                                                      |

- **`openMetadataCache` with a TTL of 0 gives it.** It opens nothing and creates no file, as before. The session gives it when it has no cache options, so `Workspace.cache` is always a `MetadataCache`.
- **`lookup` returns `cache?: CacheInfo`.** Only the disabled cache omits it. The metadata service leaves the `cache` field out of the answer when there is no info, so the answers of a disabled cache are the same as before.
- **The metadata service takes `disabledMetadataCache` as the default of its `cache` parameter.** It no longer tests for an absent cache.
- **The cache resources read `enabled`.** The contracts of `stats()` and `entry()` do not change, so the resources need the adapter to say whether it is enabled. One helper of the server answers `{ enabled: true, ... }` for an enabled cache and the disabled message otherwise. The answers of the resources do not change.
- **No change to the settings, the tool schemas or the resource URIs.** ADR 0021 stands; this ADR changes how its disabled case is modelled.

Alternatives considered:

- _The adapter builds the answers of the cache resources_: the server would not branch at all, but the cache interface would carry MCP presentation, including the disabled message, and duplicate `stats()` and `entry()`. Rejected.
- _Keep the absent value_: every new consumer of the cache has to remember the third state. Rejected.
- _Make `cache` a required argument of the metadata service_: dozens of tests that do not exercise the cache would have to pass an adapter for nothing. Rejected in favour of the default.

## Consequences

- The metadata service and the workspace session hold no branch on whether a cache exists. The session still chooses the adapter when it is built, from its options.
- The three states of the cache, working, unopenable and disabled, are each tested through the `MetadataCache` interface (`test/metadata.test.ts`).
- Behaviour visible to the agent and the operator does not change.
