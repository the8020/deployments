Parent DOX: [deployments DOX](../AGENTS.md).

# Purpose

- Expose deployment administration and finite apply executions.

# Ownership

- Own the files beneath this directory.

# Local Contracts

- `recommended-sources` is the ordinary internal program used by kernel
  recommendations. It delegates transport selection to `src/recommendations.ts`
  and returns no credential values or package mutations.
- Use full program IDs. Interactive navigation uses existing UUI programs;
  background apply uses the generic program runtime.
- Apply requests carry an immutable saved-list or original-run ID, or a single
  ad hoc package input. Resolve larger inputs in the Worker to respect the
  native command size limit. Apply admits and returns a run ID. Each detached
  `continue` event atomically claims one queued checkpoint: with a persisted
  activation ID it submits the whole staged set together; without one it handles
  one package. The native ten-minute limit covers the whole event, independent
  of browser navigation or initiating-program completion. Minute events recover
  only queued, unstarted checkpoints; they do not replay claimed work.
- `connect` invokes the shared `saveConnection` implementation with URL and
  username arguments and execution-scoped password input. Bootstrap and
  interactive connections use the same identity verification and encrypted
  store.
- `secret-usages` implements the `the8020/secrets` usage contract: a
  `deployments.peer.<system ID>` secret is used while that connection exists.

# Work Guidance

# Verification

- From the repository root, run `deno task check` and `deno task test`.

# Child DOX Index

No child DOX documents. This document owns the entire local scope.
