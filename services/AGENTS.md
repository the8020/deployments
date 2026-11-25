Parent DOX: [deployments DOX](../AGENTS.md).

# Purpose

- Expose connected-system communication and development Git transport.

# Ownership

- Own the files beneath this directory.

# Local Contracts

- Shared service admission accepts platform tokens or standard HTTP Basic
  credentials. All peer handlers additionally require
  `the8020.deployments.peer.access`; Git and versions still require the
  development system role. Git serves read-only HTTP discovery and objects, not
  a smart HTTP upload-pack RPC.

- A snapshot requested with `subjects=1` includes available installed commit
  subjects for comparison. Ordinary snapshots retain the original wire format.
- Read-only Git serves only confined Git objects and references. Incoming lists
  are untrusted proposals and never activate automatically.

# Work Guidance

- Fresh install and upgrade index the package-managed `the8020.deployments.peer`
  role without assigning it. On the receiving system, run
  `auth.users.assign <username> the8020.deployments.peer` for each explicitly
  approved incoming peer account, interactive or technical. The existing
  all-permissions administrator role still grants access; prefer dedicated peer
  accounts with only the peer role.
- For existing connections that must stay available through activation, the
  receiving system's operator may pre-grant only the known incoming usernames:
  `auth.users.personal <username>` then
  `auth.roles.grant <username> the8020.deployments.peer.access '*'`. After
  activation, assign the managed role and remove any temporary personal grant
  with `auth.roles.revoke <username> the8020.deployments.peer.access`. The local
  connection table describes outgoing credentials, not incoming authorization.
  Do not infer or auto-grant access from it or from usernames.

# Verification

- From the repository root, run `deno task check` and `deno task test`.

# Child DOX Index

No child DOX documents. This document owns the entire local scope.
