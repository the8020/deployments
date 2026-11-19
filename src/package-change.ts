import { localizedText } from "/p/the8020/i18n/mod.ts";
import { msg } from "../i18n/messages.ts";
import { requirePermission } from "/p/the8020/auth/mod.ts";
import { kernel } from "@the8020/kernel";
import { context } from "@the8020/context";
import Packages from "/p/the8020/packages/tables/packages.ts";
import { resolvePackageSelection } from "/p/the8020/packages/src/admin.ts";
import { passwordName } from "./peers.ts";
import { getSystemProfile } from "/p/the8020/system/profile.ts";
import { executeRun } from "./runs.ts";
import {
  developmentSource,
  gitURL,
  packageDevelopmentPeer,
} from "./versions.ts";
import { observedVersion } from "./observation.ts";
import {
  commit as commitField,
  type DeploymentList,
  deploymentPackageId,
} from "../types.ts";

export async function changePackage(
  packageId: string,
  commit: string,
  upstream: string | undefined,
  options: {
    before?: string;
    repair?: { source: string; secret?: string };
    forceColumns?: string[];
    approvedPlan?: string;
  } = {},
) {
  deploymentPackageId.parse(packageId);
  commitField.parse(commit);
  const local = await getSystemProfile();
  const peer = options.repair
    ? undefined
    : await packageDevelopmentPeer(packageId, upstream);
  const before = options.before ?? (await observedVersion(packageId)).commit;
  return await executeRun(
    {
      schema: 1,
      id: crypto.randomUUID(),
      name: packageId,
      sourceSystemId: peer?.id ?? local.id,
      targetSystemId: local.id,
      packages: [{ packageId, before, target: { commit, tag: null } }],
    },
    null,
    null,
    options.forceColumns,
    options.approvedPlan,
    { repair: options.repair },
  );
}

export async function syncPackageOnNode(
  row: { node: string; packageId: string; before: string; desired: string },
  rollback?: { id: string; input: DeploymentList },
) {
  await requirePermission(
    "the8020.packages.package.synchronize",
    row.packageId,
  );
  const local = await getSystemProfile();
  const index = await Packages.selectAll().where(
    Packages.packageId,
    "=",
    row.packageId,
  ).executeTakeFirstOrThrow();
  const selected = index.state === "retired"
    ? ""
    : index.requestedTag
    ? "tag:" + index.requestedTag
    : index.requestedCommit ?? index.activeCommit ??
      (index.local ? "" : "latest");
  const tag = row.desired.startsWith("tag:") ? row.desired.slice(4) : undefined;
  const desired = row.desired && !rollback
    ? await resolvePackageSelection(row.packageId, {
      source: index.source ?? undefined,
      secret: index.secretName ?? undefined,
      tag,
      commit: tag || row.desired === "latest" ? undefined : row.desired,
    })
    : row.desired;
  // An earlier selected node can already have pinned the reviewed legacy selector.
  if (!rollback && selected !== row.desired && selected !== desired) {
    throw new Error(
      await localizedText(
        msg(
          "errors.changed_since_review_compare_and_create_a_new_deployment_list",
          { value1: row.packageId },
        ),
      ),
    );
  }
  // An already unreachable node must not take the shared deployment lock.
  if (row.node !== context.nodeId) {
    await kernel.packages.waitForNodePackage(row.node, row.packageId);
  }
  const peer = row.desired && local.role !== "development"
    ? await developmentSource(
      (await packageDevelopmentPeer(row.packageId, index.source ?? undefined))
        .id,
    )
    : undefined;
  const route = peer
    ? {
      source: gitURL(peer.url, row.packageId),
      transport_username: peer.username,
      transport_secret: passwordName(peer.id),
    }
    : {
      source: index.source ?? "",
      transport_secret: index.secretName ?? undefined,
    };
  return await executeRun(
    rollback?.input ?? {
      schema: 1,
      id: crypto.randomUUID(),
      name: row.packageId,
      sourceSystemId: peer?.id ?? local.id,
      targetSystemId: local.id,
      packages: [{
        packageId: row.packageId,
        before: row.before || null,
        target: desired ? { commit: desired, tag: null } : null,
      }],
    },
    null,
    rollback?.id ?? null,
    [],
    undefined,
    {
      node: row.node,
      synchronize: async () => {
        if (!rollback && desired !== selected) {
          const result = await Packages.update({
            requestedCommit: desired,
            requestedTag: null,
            revision: index.revision + 1,
          }).where(Packages.packageId, "=", row.packageId).where(
            Packages.revision,
            "=",
            index.revision,
          ).returning("packageId").executeTakeFirst();
          if (!result) {
            throw new Error(
              await localizedText(
                msg(
                  "errors.changed_since_review_compare_and_create_a_new_deployment_list",
                  { value1: row.packageId },
                ),
              ),
            );
          }
        }
        await kernel.packages.syncNode(
          row.node,
          row.packageId,
          row.before,
          desired,
          route,
          Boolean(rollback),
        );
        if (peer && !rollback) {
          await Packages.update({ transportSource: route.source }).where(
            Packages.packageId,
            "=",
            row.packageId,
          ).where(Packages.transportSource, "is", null).execute();
        }
      },
    },
  );
}
