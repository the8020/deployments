Parent DOX: [deployments DOX](../AGENTS.md).

# Purpose

- Expose deployment administration and finite apply executions.

# Ownership

- Own the files beneath this directory.

# Local Contracts

- Use full program IDs. Interactive navigation uses existing UUI programs;
  background apply uses the generic program runtime.
- Apply requests carry an immutable saved-list or original-run ID, or a single
  ad hoc package input. Resolve larger inputs in the Worker to respect the
  native command size limit; execution uses the native ten-minute maximum.

# Work Guidance

# Verification

- From the repository root, run `deno task check` and `deno task test`.

# Child DOX Index

No child DOX documents. This document owns the entire local scope.
