Parent DOX: [deployments DOX](../AGENTS.md).

# Purpose

- Own package comparison, peer transport, runs, rollback, and deployment
  screens.

# Ownership

- Own the files beneath this directory.

# Local Contracts

- Peer requests authenticate with the configured remote account using standard
  HTTP Basic over the owner-selected HTTP or HTTPS connection. Resolve passwords
  only for outbound requests/native Git synchronization, never into connection
  models, URLs, lists, or runs. Saving a connection verifies the remote identity
  and credentials before storing them. Systems shows a masked password entry,
  clears it after each save attempt, and lets selection populate public
  connection fields for credential replacement. Reads and writes use
  `the8020/secrets/mod.ts`, which encrypts credentials in the database.

- Validate peer data before use. Require local permissions for edits and apply.
  Read live target state before mutation; record partial failures honestly.
- Run outcomes inspect installed Git HEAD because source publication can precede
  catalog completion. Failed observation retains the run lock for
  reconciliation.
- Comparisons select any pipeline stage independently of the development Git
  source. Preserve selection through the differences/all toggle and detail
  editing. Ad hoc review/edit/rebase retains a null deployment-list reference.
- `runs.ts` retains a database lock when actual outcomes cannot be observed. The
  apply program exports `deployments.run.active` on its original Worker. Check
  execution releases an abandoned lock only after an explicit inactive answer or
  `target_not_found`; timeouts/unavailable targets keep it locked.
  Reconciliation observes current versions and never replays work.

# Work Guidance

- Runs classify upgrade/downgrade from inspected Git parent links. Missing,
  truncated, or divergent ancestry remains `changed`; dates and tag names never
  determine direction.

# Verification

- From the repository root, run `deno task check` and `deno task test`.
- `deno task test:browser` exercises the real screens and shared browser/session
  stack: differences/all, retained selection, package/version detail, JSON
  export, apply, rollback, ad hoc updates without list references, and mobile
  sizing. It uses the production SQL codec/DDL with native-operation doubles;
  real package activation needs separate native qualification.

# Child DOX Index

No child DOX documents. This document owns the entire local scope.
