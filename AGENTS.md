Parent DOX: [8020 workspace](../AGENTS.md).

Framework source:
[agent0ai/dox/AGENTS.md](https://github.com/agent0ai/dox/blob/765ae4ac02cc884eefcd41a3d0f71941721adb89/AGENTS.md).

# DOX framework

- DOX is highly performant AGENTS.md hierarchy installed here
- Agent must follow DOX instructions across any edits

## Core Contract

- AGENTS.md files are binding work contracts for their subtrees
- Work products, source materials, instructions, records, assets, and durable
  docs must stay understandable from the nearest applicable AGENTS.md plus every
  parent AGENTS.md above it

## Read Before Editing

1. Read the root AGENTS.md
2. Identify every file or folder you expect to touch
3. Walk from the repository root to each target path
4. Read every AGENTS.md found along each route
5. If a parent AGENTS.md lists a child AGENTS.md whose scope contains the path,
   read that child and continue from there
6. Use the nearest AGENTS.md as the local contract and parent docs for repo-wide
   rules
7. If docs conflict, the closer doc controls local work details, but no child
   doc may weaken DOX

Do not rely on memory. Re-read the applicable DOX chain in the current session
before editing.

## Update After Editing

Every meaningful change requires a DOX pass before the task is done.

Update the closest owning AGENTS.md when a change affects:

- purpose, scope, ownership, or responsibilities
- durable structure, contracts, workflows, or operating rules
- required inputs, outputs, permissions, constraints, side effects, or artifacts
- user preferences about behavior, communication, process, organization, or
  quality
- AGENTS.md creation, deletion, move, rename, or index contents

Update parent docs when parent-level structure, ownership, workflow, or child
index changes. Update child docs when parent changes alter local rules. Remove
stale or contradictory text immediately. Small edits that do not change behavior
or contracts may leave docs unchanged, but the DOX pass still must happen.

## Hierarchy

- Root AGENTS.md is the DOX rail: project-wide instructions, global preferences,
  durable workflow rules, and the top-level Child DOX Index
- Child AGENTS.md files own domain-specific instructions and their own Child DOX
  Index
- Each parent explains what its direct children cover and what stays owned by
  the parent
- The closer a doc is to the work, the more specific and practical it must be

## Child Doc Shape

- Create a child AGENTS.md when a folder becomes a durable boundary with its own
  purpose, rules, responsibilities, workflow, materials, or quality standards
- Work Guidance must reflect the current standards of the project or user
  instructions; if there are no specific standards or instructions yet, leave it
  empty
- Verification must reflect an existing check; if no verification framework
  exists yet, leave it empty and update it when one exists

Default section order:

- Purpose
- Ownership
- Local Contracts
- Work Guidance
- Verification
- Child DOX Index

## Style

- Keep docs concise, current, and operational
- Document stable contracts, not diary entries
- Put broad rules in parent docs and concrete details in child docs
- Prefer direct bullets with explicit names
- Do not duplicate rules across many files unless each scope needs a local
  version
- Delete stale notes instead of explaining history
- Trim obvious statements, repeated rules, misplaced detail, and warnings for
  risks that no longer exist

## Closeout

1. Re-check changed paths against the DOX chain
2. Update nearest owning docs and any affected parents or children
3. Refresh every affected Child DOX Index
4. Remove stale or contradictory text
5. Run existing verification when relevant
6. Report any docs intentionally left unchanged and why

## User Preferences

When the user requests a durable behavior change, record it here or in the
relevant child AGENTS.md

## Child DOX Index

- [cbus/AGENTS.md](cbus/AGENTS.md): Secure connected-system setup commands.
- [tables/AGENTS.md](tables/AGENTS.md): Connected systems, deployment lists, and
  run history.
- [src/AGENTS.md](src/AGENTS.md): Comparison, transport, execution, and UUI
  workflows.
- [programs/AGENTS.md](programs/AGENTS.md): Deployments administration and apply
  entrypoints.
- [services/AGENTS.md](services/AGENTS.md): Authenticated peer communication and
  development Git transport.

# Purpose

- Own `the8020/deployments`: package promotion between independent systems.

# Ownership

- Own connected-system configuration, portable lists, queued reception, live
  comparison, selection, ad hoc updates, rollback, and immutable run records.
- `the8020/system/profile.ts` owns system identity/name/role. The packages API
  owns application package editing; native Git synchronization owns activation.

# Local Contracts

- Chains have any length; each target has its own database and shared code tree.
  Lists identify their development Git source separately from their target so
  promotion through test/preproduction never needs upstream credentials.
- Only development systems serve Git. The entire peer service is authenticated;
  ordinary HTTP Basic headers work with Git clients and peer requests. Each
  connection configures an enabled remote account's username and password over
  HTTP or HTTPS. The system owner chooses the transport and manages network
  security; do not require HTTPS or add a separate opt-in for HTTP. Upstream
  repository credentials stay on their owning development system. Incoming
  requests never execute or activate deployment instructions.
- Runs record version identifiers, not copies of the underlying content.
  Restoring a version requires it to remain available from its source; missing
  sources or versions fail normally.
- Connections are operator-configured HTTP or HTTPS URLs and usernames with
  pinned `sys-` system IDs. Passwords use the encrypted secrets-package store
  under `deployments.peer.<system ID>`; connection listings and run/list records
  never contain passwords. Disconnect removes the connection and its saved
  secret. Authenticated incoming lists remain queued proposals, bounded and
  immutable; processing requires the local `deployments.apply` permission and
  live review.
- `deployments.connect <url> <username> --password-stdin` invokes the ordinary
  connection API with execution-scoped secure input. It supports unattended
  deployment bootstrap without passwords in arguments, source, or image layers.
- Lists carry full package IDs and exact commits or tags. Interactive selection
  pins a commit; imported tags resolve during ordinary Git synchronization and
  the run records that exact commit. Explicit null targets mean removal.
- Runs copy their input and actual package before/after state. Completed runs
  are immutable. Rollback is a new run restoring only the original affected
  packages and refuses drift unless it is reviewed as a new deployment.
- Serialize runs across nodes in the shared database, without holding a SQL
  transaction over network or activation. Unknown execution outcomes retain the
  lock until reconciled; never automatically replay a run after interruption.
- Reuse ordinary Zod fields, UUI Model/list selection, toolbar buttons, detail
  pages, and modals. Lists default to differences and preserve selected targets.

# Work Guidance

- Build only what the request and established contracts require. Before adding a
  mechanism, identify that need and why existing owners or standard tools cannot
  meet it. Do not invent stronger guarantees for hypothetical cases. Remove
  unsupported additions at closeout; agent-written tests and DOX do not
  authorize them. Preserve required correctness, security, and data integrity.

- Keep deployment workflows out of the kernel. Preserve running work through the
  ordinary source publication and service generation lifecycle.

# Verification

- `deno task check` formats, lints, and type-checks the package.
- `deno task test` exercises normal source with the SQL/kernel bridge and real
  local Git transport where applicable.
- `deno task test:browser` runs the package-owned scenario through the existing
  UUI browser harness; native activation is qualified separately.
- `python3 native_e2e.py --runtime-root /root/8020/test<N>` uses an existing
  qualified rootless OS/toolchain image, stages the current generic runtime
  sources, and creates freshly numbered independent test instances. It limits
  descendants to two CPUs, 3,584 MiB aggregate proportional memory, and 900
  seconds, and stops below 750 MiB available host memory. Empty sandboxes are
  not retained; fixture service Workers retain only one second of idle time. It
  verifies independent short IDs/master keys, private-service challenges, secure
  connection commands in both directions over loopback, encrypted secret rows,
  same-hostname login/logout isolation, real HTTP Git activation, ad hoc
  updates, removal, rollback, and roles.
