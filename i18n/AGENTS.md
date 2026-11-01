Parent DOX: [deployments](../AGENTS.md).

# Purpose

- Own this package's English and Czech presentation catalogs.

# Ownership

- `locales/` owns package UI text, field help, and displayed metadata.
- `messages.ts` creates deferred references with English source fallback.

# Local Contracts

- English and Czech cover the same keys. Other languages may use fallback.
- Use flat keys and named variables; preserve variables and icon markup in
  translations.
- Keep identifiers, user-entered data, and technical source/log output
  unchanged.
- Shared fields hold message references; resolve text inside the invocation.
- Displayed metadata uses `package.description`, `programs.<name>.description`,
  `services.<name>.description`, `widgets.<name>.title`/`.description`,
  `categories.<path>.title`, and `declarations.<file-stem>.<key>`.

# Work Guidance

- Add or change both English and Czech when changing presentation text.

# Verification

- Run `deno task check:i18n` from the package root.

# Child DOX Index

No child documents.
