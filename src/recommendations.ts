import { z } from "/p/the8020/db/fields.ts";
import { requirePermission } from "/p/the8020/auth/mod.ts";
import { getSystemProfile } from "/p/the8020/system/profile.ts";
import Packages from "/p/the8020/packages/tables/packages.ts";
import Connections from "../tables/connections.ts";
import { connection, deploymentPackageId } from "../types.ts";
import { passwordName } from "./peers.ts";
import { gitURL, remoteVersions } from "./versions.ts";

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
  const peers = z.array(connection).parse(
    await Connections.selectAll().limit(1001).execute(),
  );
  if (peers.length > 1000) throw new Error("Too many deployment connections.");
  const defaults = peers.filter((peer) => peer.role === "development");
  const routes = [];
  for (const item of items) {
    const current = installed.get(item.id);
    const existing = peers.find((peer) =>
      gitURL(peer.url, item.id) === current?.source
    );
    if (current?.local) {
      routes.push({ package_id: item.id, skip: "local package" });
      continue;
    }
    if (current?.source && current.source !== item.source && !existing) {
      if (gitURL(new URL(current.source).origin, item.id) === current.source) {
        throw new Error(`Reconnect the development source for ${item.id}.`);
      }
      routes.push({ package_id: item.id, skip: "custom source" });
      continue;
    }
    const peer = existing ?? (defaults.length === 1 ? defaults[0] : undefined);
    if (!peer) {
      throw new Error(
        `No unambiguous development source for ${item.id}. Connect one development system or deploy this package from the selected development system first.`,
      );
    }
    // Refresh upstream refs only on their development owner before native Git fetch.
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
