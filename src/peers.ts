import { getSecret, setSecret } from "/p/the8020/secrets/mod.ts";
import Secrets from "/p/the8020/secrets/tables/secrets.ts";
import { requirePermission } from "/p/the8020/auth/mod.ts";
import { getSystemProfile, systemProfile } from "/p/the8020/system/profile.ts";
import Packages from "/p/the8020/packages/tables/packages.ts";
import Connections from "../tables/connections.ts";
import Lists from "../tables/lists.ts";
import {
  type Connection,
  connection,
  type DeploymentList,
  parseList,
  remotePassword,
  remoteUsername,
  type Snapshot,
  snapshot,
  systemUrl,
} from "../types.ts";

export const servicePath = "/the8020/deployments/peer";

export async function readJSON(
  response: Response,
  limit = 4 * 1024 * 1024,
): Promise<unknown> {
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`Connected system returned HTTP ${response.status}.`);
  }
  if (!response.body) {
    throw new Error("Connected system returned an empty response.");
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        throw new Error("Connected-system response is too large.");
      }
      chunks.push(value);
    }
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder().decode(bytes));
}

const passwordName = (id: string) =>
  `deployments.peer.${systemProfile.shape.id.parse(id)}`;

export async function credentials(peer: Connection) {
  return {
    url: peer.url,
    username: remoteUsername.min(3).parse(peer.username),
    password: remotePassword.min(1).parse(
      (await getSecret(passwordName(peer.id))).value,
    ),
  };
}

export async function request(
  peer: { url: string; username: string; password: string },
  path: string,
  body?: unknown,
) {
  const bytes = new TextEncoder().encode(
    `${remoteUsername.min(3).parse(peer.username)}:${
      remotePassword.min(1).parse(peer.password)
    }`,
  );
  const headers = new Headers({ Authorization: `Basic ${bytes.toBase64()}` });
  if (body !== undefined) headers.set("Content-Type", "application/json");
  return await readJSON(
    await fetch(new URL(servicePath + path, systemUrl.parse(peer.url)), {
      method: body === undefined ? "GET" : "POST",
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
    }),
  );
}

export async function localSnapshot(packageIds?: string[]): Promise<Snapshot> {
  let query = Packages.select([
    Packages.packageId,
    Packages.activeCommit,
    Packages.state,
  ])
    .where(Packages.state, "!=", "retired").orderBy(Packages.packageId).limit(
      10001,
    );
  if (packageIds) query = query.where(Packages.packageId, "in", packageIds);
  const packages = await query.execute();
  return snapshot.parse({
    system: await getSystemProfile(),
    packages: packages.map((row) => ({
      packageId: row.packageId,
      commit: row.activeCommit,
      state: row.state,
    })),
  });
}

export async function getConnection(id: string) {
  return connection.parse(
    await Connections.selectAll().where(Connections.id, "=", id)
      .executeTakeFirstOrThrow(),
  );
}

export async function remoteSnapshot(id: string): Promise<Snapshot> {
  if ((await getSystemProfile()).id === id) return await localSnapshot();
  const peer = await getConnection(id);
  const result = snapshot.parse(
    await request(await credentials(peer), "/snapshot"),
  );
  if (result.system.id !== id) {
    throw new Error(
      "The connected system identity changed. Reconnect it before continuing.",
    );
  }
  return result;
}

export async function saveConnection(
  url: string,
  username: string,
  password: string,
) {
  await requirePermission("deployments.connections.edit", "");
  const normalized = new URL(systemUrl.parse(url)).origin;
  const profile = systemProfile.parse(
    await request({ url: normalized, username, password }, "/identity"),
  );
  const peer = connection.parse({ ...profile, url: normalized, username });
  await setSecret({ name: passwordName(peer.id), value: password });
  await Connections.insert(peer).onConflict((conflict) =>
    conflict.column("id").doUpdateSet(peer)
  ).execute();
  return peer;
}

export async function removeConnection(id: string) {
  await requirePermission("deployments.connections.edit", "");
  await Connections.delete().where(Connections.id, "=", id).execute();
  await Secrets.delete().where(Secrets.name, "=", passwordName(id)).execute();
}

export async function saveList(value: unknown) {
  await requirePermission("deployments.lists.edit", "");
  const list = parseList(value);
  await storeList(list, false);
  return list;
}

/** Untrusted reception queues a proposal only; it cannot overwrite a saved list. */
export async function receiveList(value: unknown) {
  const list = parseList(value);
  const local = await getSystemProfile();
  if (list.targetSystemId !== local.id) {
    throw new Error("This list targets another system.");
  }
  await getConnection(list.sourceSystemId);
  await storeList(list, true);
  return { id: list.id };
}

async function storeList(list: DeploymentList, received: boolean) {
  // ponytail: bounded proposal queue; archive/delete reviewed lists before 1000.
  const saved = await Lists.selectAll().where(Lists.id, "=", list.id)
    .executeTakeFirst();
  if (saved) {
    if (JSON.stringify(parseList(saved.payload)) !== JSON.stringify(list)) {
      throw new Error(
        "A different deployment list already has this ID. Create a new list.",
      );
    }
    return;
  }
  const used = new Set(
    (await Lists.select([Lists.slot]).limit(1000).execute()).map((row) =>
      row.slot
    ),
  );
  let slot = 0;
  while (used.has(slot)) slot++;
  if (slot >= 1000) {
    throw new Error(
      "The deployment queue is full. Delete reviewed lists first.",
    );
  }
  // The unique slot also bounds simultaneous reception on different nodes.
  await Lists.insert({
    id: list.id,
    slot,
    name: list.name,
    targetSystemId: list.targetSystemId,
    payload: list,
    received,
    createdAt: new Date(),
  }).execute();
}

export async function sendList(value: unknown) {
  await requirePermission("deployments.lists.edit", "");
  const list = parseList(value);
  const peer = await getConnection(list.targetSystemId);
  const target = await remoteSnapshot(peer.id);
  if (target.system.id !== list.targetSystemId) {
    throw new Error("Incorrect target system.");
  }
  await request(await credentials(peer), "/lists", list);
}

export async function deleteList(id: string) {
  await requirePermission("deployments.lists.edit", "");
  await Lists.delete().where(Lists.id, "=", id).execute();
}
