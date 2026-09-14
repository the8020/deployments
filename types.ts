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
    label: "Commit",
    description: "Exact full Git commit ID. Blank targets remove a package.",
  },
);
export const name = field(z.string().trim().min(1).max(160), {
  label: "Name",
  description: "A short name describing the deployment.",
});
export const systemUrl = field(
  z.url().refine((value) => {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password &&
      !url.search && !url.hash && url.pathname === "/";
  }, "Use an HTTPS system address without a path or credentials."),
  {
    label: "System URL",
    description: "HTTPS address of the connected 80|20 system.",
  },
);
export const remoteUsername = field(
  newUsername.regex(/^(?:[a-z0-9]{3,32})?$/),
  {
    label: "Remote username",
    description: "An enabled account on the remote system.",
  },
);
export const remotePassword = field(
  accountInfo.shape.password.max(1024),
  {
    label: "Remote password",
    description: "The password for this account on the remote system.",
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
      label: "Tag",
      description:
        "A development Git tag, resolved to an exact commit when applied.",
    },
  ).nullable(),
}).strict().refine(
  (value) => !(value.commit && value.tag),
  "Choose a commit or a tag.",
);
export const deploymentItem = z.object({
  packageId: deploymentPackageId,
  before: commit.nullable(),
  target: targetVersion.nullable(),
}).strict().refine(
  (value) =>
    value.target === null ||
    Boolean(value.target.commit || value.target.tag),
  "Choose a target version or removal.",
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
      "Ad hoc deployments contain one package.",
    ),
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
  "Duplicate package IDs in system snapshot.",
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
}).strict();
export type RunItem = z.infer<typeof runItem>;
export const runState = field(
  z.enum(["running", "succeeded", "failed", "interrupted"]),
  {
    label: "Status",
    description: "Outcome of the recorded deployment attempt.",
  },
);

export function parseList(value: unknown): DeploymentList {
  if (new TextEncoder().encode(JSON.stringify(value)).byteLength > 512 * 1024) {
    throw new Error("Deployment lists must be no larger than 512 KiB.");
  }
  return deploymentList.parse(value);
}
