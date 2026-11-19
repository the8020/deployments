import Packages from "/p/the8020/packages/tables/packages.ts";
import Connections from "../tables/connections.ts";
import { localizedText as resolveMessage } from "/p/the8020/i18n/mod.ts";
import { msg as messageSymbol } from "/p/the8020/deployments/i18n/messages.ts";
import { kernel } from "@the8020/kernel";
import {
  getSystemProfile,
  requireDevelopment,
  systemProfile,
} from "/p/the8020/system/profile.ts";
import { prepareTexts, text } from "/p/the8020/i18n/mod.ts";
import { msg } from "../i18n/messages.ts";
import { deploymentPackageId, packageVersions } from "../types.ts";
import {
  credentials,
  getConnection,
  passwordName,
  request,
  servicePath,
} from "./peers.ts";

export async function developmentSource(id: string) {
  const peer = await getConnection(id);
  const local = await getSystemProfile();
  const identity = local.id === id
    ? local
    : systemProfile.parse(await request(await credentials(peer), "/identity"));
  if (identity.id !== id || identity.role !== "development") {
    const message = msg("versions.development_source_required");
    await prepareTexts(message);
    throw new Error(text(message));
  }
  return peer;
}

export function gitURL(url: string, packageId: string) {
  deploymentPackageId.parse(packageId);
  return new URL(`${servicePath}/git/${packageId}.git`, url).href;
}

export async function localVersions(packageId: string) {
  await requireDevelopment();
  deploymentPackageId.parse(packageId);
  // Peers can use the commits held on development even while its upstream is offline.
  return packageVersions.parse(
    await kernel.packages.versions.cached(packageId, 1000),
  );
}

export async function remoteVersions(source: string, packageId: string) {
  if ((await getSystemProfile()).id === source) {
    return await localVersions(packageId);
  }
  const peer = await developmentSource(source);

  const result = packageVersions.parse(
    await request(
      await credentials(peer),
      `/versions/${deploymentPackageId.parse(packageId)}`,
    ),
  );
  if (result.package_id !== packageId) {
    throw new Error(
      await resolveMessage(
        messageSymbol(
          "errors.connected_system_returned_versions_for_another_package",
        ),
      ),
    );
  }
  return result;
}

/** A stored dev adapter has priority. An upstream or new package uses the sole dev. */
export async function packageDevelopmentPeer(
  packageId: string,
  source?: string,
) {
  deploymentPackageId.parse(packageId);
  const settings = await Packages.select([Packages.transportSource]).where(
    Packages.packageId,
    "=",
    packageId,
  ).executeTakeFirst();
  source = settings?.transportSource ?? source;
  const origin = source ? new URL(source).origin : undefined;
  const dev = Connections.selectAll().where(
    Connections.role,
    "=",
    "development",
  );
  if (origin && gitURL(origin, packageId) === source) {
    const existing = await dev.where(Connections.url, "=", origin)
      .executeTakeFirst();
    if (existing) return existing;
    throw new Error(
      await resolveMessage(
        msg("errors.reconnect_source", { value1: packageId }),
      ),
    );
  }
  const peers = await dev.limit(2).execute();
  if (!peers.length) {
    throw new Error(
      await resolveMessage(msg("screens.choose_development_source")),
    );
  }
  const peer = peers.length === 1 ? peers[0] : undefined;
  if (!peer) {
    throw new Error(
      await resolveMessage(
        msg("errors.choose_development_connection", { value1: packageId }),
      ),
    );
  }
  return peer;
}

export async function developmentTransport(packageId: string, source?: string) {
  const peer = await developmentSource(
    (await packageDevelopmentPeer(packageId, source)).id,
  );
  return {
    source: gitURL(peer.url, packageId),
    transport_secret: passwordName(peer.id),
    transport_username: peer.username,
  };
}
