Parent DOX: [deployments DOX](../AGENTS.md).

# Purpose

- Expose connected-system setup through ordinary package commands.

# Ownership

- Own flat `commands/*.toml` declarations.

# Local Contracts

- `deployments.connect` verifies the remote identity through `saveConnection`.
- Passwords travel only through execution-scoped secure input.

# Work Guidance

# Verification

- `deno task check` and `deno task test` verify the owning implementation.

# Child DOX Index

No child DOX documents. This document owns the entire local scope.
