Parent DOX: [deployments DOX](../AGENTS.md).

# Purpose

- Own package comparison, peer transport, runs, rollback, and deployment
  screens.

# Ownership

- Own the files beneath this directory.

# Local Contracts

- Collection creation/import, comparison/review operations, version selection,
  disconnect, refresh, and backend paging belong in the relevant list toolbar.
  System settings, form saves, related-page navigation, and run-level rollback
  stay in screen headers.

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
- Snapshots, comparison baselines and run outcomes share `observation.ts`.
  Native repository `absent` and `empty` statuses mean no installed commit;
  uninitialized/corrupt source and inspection errors remain failures. Git HEAD
  is installed-source evidence; ready catalog metadata must also match it.
  Incomplete equal-version targets remain visible in differences. Failed
  observation retains the run lock for reconciliation.
- Comparisons select any pipeline stage independently of the development Git
  source. Preserve selection through the differences/all toggle and detail
  editing. Ad hoc review/edit/rebase retains a null deployment-list reference.
- Ad hoc single-package apply input may carry exact `forceColumns` and
  `approvedPlan`. Preserve `the8020.deployments.apply`, target identity and
  observed before/after evidence; removal and multi-package destructive consent
  reject. Forward those options to native package synchronization, which shares
  DB cleanup/repair/recovery with development. Run history retains force scope;
  a failed run never replays itself automatically.
- `runs.ts` admits with a unique-key conflict target, returning an actionable
  existing-run reference while unrelated SQL failures propagate. Continuations
  claim one queued index atomically, record their exact Worker identity before
  mutation, and save the package outcome and next index together. Each event
  gets the existing ten-minute limit; a stuck single activation stays subject to
  that limit. Minute events query only the unique active run and resume only
  unstarted steps. Authorization and immutable inputs are accepted at admission;
  minute continuations execute that accepted work as system.
- Apply and continuation programs export `deployments.run.active`. Check
  execution redispatches queued work; an in-flight step requires explicit
  inactive/`target_not_found` evidence, no unfinished native activation, settled
  database status, and successful source inspection before marking the run
  interrupted and releasing its lock. Timeouts, unavailable targets, pending
  native recovery and corrupt source keep it locked. Reconciliation never
  replays a claimed package or turns interruption into run success. Operators
  inspect native activation/database state and finish supported native recovery
  before retrying Check execution; a fresh reviewed deployment can then proceed.

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
