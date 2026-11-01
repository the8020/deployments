Parent DOX: [deployments](../AGENTS.md).

# Purpose

- Own this package's presentation catalogs for all 43 built-in languages.

# Ownership

- `locales/` owns package UI text, field help, and displayed metadata.
- `messages.ts` creates deferred references with English source fallback.

# Local Contracts

- All languages in `the8020/i18n/languages.ts` cover every English key.
  Customer-added languages may use fallback.
- Use flat keys and named variables; preserve variables and icon markup in
  translations.
- Keep identifiers, user-entered data, and technical source/log output
  unchanged.
- Shared fields hold message references; resolve text inside the invocation.
- Displayed metadata uses `package.description`, `programs.<name>.description`,
  `services.<name>.description`, `widgets.<name>.title`/`.description`,
  `categories.<path>.title`, and `declarations.<file-stem>.<key>`.

# Work Guidance

- Update every built-in language when changing presentation text.
- Use concise native wording appropriate to each field, action, or message.
  Preserve Portuguese and Chinese variants and Serbian Latin script.

# Verification

- Run `deno task check:i18n` from the package root.

# Child DOX Index

No child documents.
