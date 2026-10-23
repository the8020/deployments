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
  native command size limit. Apply admits and returns a run ID; `continue`
  executes one atomically claimed package per detached event with the native
  ten-minute maximum. Browser navigation and initiating-program completion do
  not own continuation lifetime. Existing minute events recover only unstarted
  checkpoints after lost delivery or restart.
- `connect` invokes the shared `saveConnection` implementation with URL and
  username arguments and execution-scoped password input. Bootstrap and
  interactive connections use the same identity verification and encrypted
  store.

# Work Guidance

# Verification

- From the repository root, run `deno task check` and `deno task test`.

# Child DOX Index

No child DOX documents. This document owns the entire local scope.
