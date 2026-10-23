Parent DOX: [deployments DOX](../AGENTS.md).

# Purpose

- Store connected systems, queued deployment lists, and deployment run history.

# Ownership

- Own the files beneath this directory.

# Local Contracts

- Connections store remote usernames, never passwords. Passwords belong to the
  existing secrets table and are removed with their connection.

- Run inputs and before/after copies do not depend on later list edits. A unique
  active-run key serializes mutations across nodes.
- Nullable `nextStep` is the unstarted package index. Claiming clears it and
  records execution identity atomically; completion saves outcomes and the next
  index atomically. Null on a running row means in-flight or uncertain,
  including runs created before this column existed, and never authorizes
  replay.
- Run package copies retain exact force columns and approved schema plan across
  detached execution. Admission, claims and checkpoints are short statements; no
  transaction spans activation or network work.
- Lists occupy one of 1,000 unique queue slots; simultaneous inserts cannot
  exceed the queue capacity.

# Work Guidance

# Verification

- From the repository root, run `deno task check` and `deno task test`.

# Child DOX Index

No child DOX documents. This document owns the entire local scope.
