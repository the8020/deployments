Parent DOX: [deployments DOX](../AGENTS.md).

# Purpose

- Expose connected-system communication and development Git transport.

# Ownership

- Own the files beneath this directory.

# Local Contracts

- The peer service declares authenticated access on every route. Shared service
  admission accepts platform tokens or standard HTTP Basic credentials; no
  service-local password check or token exchange is needed. Git and version
  routes additionally require the development system role.

- Read-only Git serves only confined Git objects and references. Incoming lists
  are untrusted proposals and never activate automatically.

# Work Guidance

# Verification

- From the repository root, run `deno task check` and `deno task test`.

# Child DOX Index

No child DOX documents. This document owns the entire local scope.
