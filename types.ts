import { text as localizedText } from "/p/the8020/i18n/mod.ts";
import { msg } from "/p/the8020/deployments/i18n/messages.ts";
import { field, fieldMetadata, z } from "/p/the8020/db/fields.ts";
import { packageId } from "/p/the8020/packages/types/package.ts";
import { sourceInfo } from "/p/the8020/packages/types/source.ts";
import { accountInfo, newUsername } from "/p/the8020/users/types/user.ts";
import { systemProfile } from "/p/the8020/system/profile.ts";

export const deploymentPackageId = field(
  packageId.regex(
    /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/,
  ).max(200),
  fieldMetadata(packageId) ?? {},
);
export const commit = field(
  sourceInfo.shape.commit.regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/),
  {
    label: msg("types.commit"),
    description: msg("types.exact_full_git_commit_id_blank_targets"),
  },
);
export const name = field(z.string().trim().min(1).max(160), {
  label: msg("types.name"),
  description: msg("types.a_short_name_describing_the_deployment"),
});
export const systemUrl = field(
  z.url().refine((value) => {
    const url = URL.parse(value);
    return url !== null &&
      (url.protocol === "http:" || url.protocol === "https:") &&
      !url.username && !url.password &&
      !url.search && !url.hash && url.pathname === "/";
  }, {
    error: () =>
      localizedText(msg("types.use_an_http_or_https_system_address")),
  }),
  {
    label: msg("screens.system_url"),
    description: msg("types.http_or_https_address_of_the_connected"),
  },
);
export const remoteUsername = field(
  newUsername.regex(/^(?:[a-z0-9][a-z0-9_-]{1,30}[a-z0-9])?$/),
  {
    label: msg("types.remote_username"),
    description: msg("types.an_enabled_account_on_the_remote_system"),
  },
);
export const remotePassword = field(
  accountInfo.shape.password.max(1024),
  {
    label: msg("types.remote_password"),
    description: msg("types.the_password_for_this_account_on_the"),
  },
);
export const connection = systemProfile.extend({
  url: systemUrl,
  username: remoteUsername,
}).strict();
export type Connection = z.infer<typeof connection>;
export const targetVersion = z.object({
  commit: commit.nullable(),
  tag: field(
    sourceInfo.shape.tag.max(200).regex(/^[A-Za-z0-9][A-Za-z0-9._/-]*$/),
    {
      label: msg("types.tag"),
      description: msg("types.a_development_git_tag_resolved_to_an"),
    },
  ).nullable(),
}).strict().refine(
  (value) => !(value.commit && value.tag),
  { error: () => localizedText(msg("types.choose_a_commit_or_a_tag")) },
);
export const deploymentItem = z.object({
  packageId: deploymentPackageId,
  before: commit.nullable(),
  target: targetVersion.nullable(),
}).strict().refine(
  (value) =>
    value.target === null ||
    Boolean(value.target.commit || value.target.tag),
  {
    error: () => localizedText(msg("types.choose_a_target_version_or_removal")),
  },
);
export const deploymentList = z.object({
  schema: z.literal(1),
  id: z.uuid(),
  name,
  sourceSystemId: systemProfile.shape.id,
  targetSystemId: systemProfile.shape.id,
  packages: z.array(deploymentItem).min(1).max(1000),
}).strict().refine(
  (value) =>
    new Set(value.packages.map((item) => item.packageId)).size ===
      value.packages.length,
  "A package may occur only once.",
);
export type DeploymentList = z.infer<typeof deploymentList>;
export const deploymentRequest = z.union([
  z.object({ listId: z.uuid() }).strict(),
  z.object({ rollbackOf: z.uuid() }).strict(),
  z.object({
    input: deploymentList.refine(
      (value) => value.packages.length === 1,
      {
        error: () =>
          localizedText(msg("types.ad_hoc_deployments_contain_one_package")),
      },
    ),
    forceColumns: z.array(z.string().min(1).max(127)).max(256).optional(),
    approvedPlan: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  }).strict(),
]);
export type DeploymentItem = z.infer<typeof deploymentItem>;
export const packageState = z.object({
  packageId: deploymentPackageId,
  commit: commit.nullable(),
  state: z.string(),
}).strict();
export type PackageState = z.infer<typeof packageState>;
export const snapshot = z.object({
  system: systemProfile,
  packages: z.array(packageState).max(10000),
}).strict().refine(
  (value) =>
    new Set(value.packages.map((row) => row.packageId)).size ===
      value.packages.length,
  {
    error: () =>
      localizedText(msg("types.duplicate_package_ids_in_system_snapshot")),
  },
);
export type Snapshot = z.infer<typeof snapshot>;
export const packageVersions = z.object({
  package_id: deploymentPackageId,
  current_commit: commit.optional(),
  selected_commit: commit.optional(),
  versions: z.array(z.object({
    commit,
    parents: z.array(commit).max(100).nullable(),
    short_commit: z.string().max(64),
    authored_at: sourceInfo.shape.authoredAt.max(100),
    author: sourceInfo.shape.author.max(1000),
    subject: sourceInfo.shape.subject.max(10000),
    tags: z.array(sourceInfo.shape.tag.max(200)).max(1000),
    current: z.boolean(),
    selected: z.boolean(),
  })).max(1000),
});
export const runItem = z.object({
  packageId: deploymentPackageId,
  before: commit.nullable(),
  requested: commit.nullable(),
  requestedTag: targetVersion.shape.tag,
  after: commit.nullable(),
  change: z.enum([
    "unchanged",
    "added",
    "removed",
    "upgraded",
    "downgraded",
    "changed",
  ]),
  processed: z.boolean(),
  state: z.enum(["pending", "succeeded", "failed"]),
  error: z.string(),
  forceColumns: z.array(z.string()).optional(),
  approvedPlan: z.string().regex(/^[a-f0-9]{64}$/).optional(),
}).strict();
export type RunItem = z.infer<typeof runItem>;
export const runState = field(
  z.enum(["running", "succeeded", "failed", "interrupted"]),
  {
    label: msg("types.status"),
    description: msg("types.outcome_of_the_recorded_deployment_attempt"),
  },
);

export function parseList(value: unknown): DeploymentList {
  if (new TextEncoder().encode(JSON.stringify(value)).byteLength > 512 * 1024) {
    throw new Error("Deployment lists must be no larger than 512 KiB.");
  }
  return deploymentList.parse(value);
}
