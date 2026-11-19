import { z } from "/p/the8020/db/fields.ts";
import { requirePermission } from "/p/the8020/auth/mod.ts";
import { getSystemProfile } from "/p/the8020/system/profile.ts";
import Packages from "/p/the8020/packages/tables/packages.ts";

import { deploymentPackageId } from "../types.ts";
import { passwordName } from "./peers.ts";
import { gitURL, packageDevelopmentPeer, remoteVersions } from "./versions.ts";

const recommendations = z.array(
  z.object({
    id: deploymentPackageId,
    source: z.url(),
    version: z.string(),
  }).strict(),
).max(256);

/** Select transport only; the native owner retains version and source protection. */
export async function recommendedSources(value: unknown) {
  await requirePermission("the8020.deployments.apply", "");
  const items = recommendations.parse(value);
  if ((await getSystemProfile()).role === "development") {
    return items.map((item) => ({ package_id: item.id, source: item.source }));
  }
  if (!items.length) return [];
  const installed = new Map((await Packages.select([
    Packages.packageId,
    Packages.source,
    Packages.local,
  ]).where(Packages.packageId, "in", items.map((item) => item.id)).execute())
    .map((row) => [row.packageId, row]));
  const routes = [];
  for (const item of items) {
    const current = installed.get(item.id);
    if (current?.local) {
      routes.push({ package_id: item.id, skip: "local package" });
      continue;
    }
    if (
      current?.source && current.source !== item.source &&
      gitURL(new URL(current.source).origin, item.id) !== current.source
    ) {
      routes.push({ package_id: item.id, skip: "custom source" });
      continue;
    }
    const peer = await packageDevelopmentPeer(
      item.id,
      current?.source ?? undefined,
    );
    // Verify that the development owner can serve this package before native Git fetch.
    await remoteVersions(peer.id, item.id);
    routes.push({
      package_id: item.id,
      source: gitURL(peer.url, item.id),
      secret: passwordName(peer.id),
      username: peer.username,
    });
  }
  return routes;
}
