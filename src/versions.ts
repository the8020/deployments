import { localizedText as resolveMessage } from "/p/the8020/i18n/mod.ts";
import { msg as messageSymbol } from "/p/the8020/deployments/i18n/messages.ts";
import { kernel } from "@the8020/kernel";
import { requireDevelopment } from "/p/the8020/system/profile.ts";
import { prepareTexts, text } from "/p/the8020/i18n/mod.ts";
import { msg } from "../i18n/messages.ts";
import { deploymentPackageId, packageVersions } from "../types.ts";
import {
  credentials,
  getConnection,
  remoteSnapshot,
  servicePath,
} from "./peers.ts";

export async function developmentSource(id: string) {
  const peer = await getConnection(id);
  if ((await remoteSnapshot(id)).system.role !== "development") {
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
  // The development owner alone may refresh its upstream references/secrets.
  return packageVersions.parse(
    await kernel.packages.versions.list(packageId, 1000),
  );
}

export async function remoteVersions(source: string, packageId: string) {
  const peer = await developmentSource(source);
  const { request } = await import("./peers.ts");
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
