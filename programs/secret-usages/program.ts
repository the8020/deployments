import { text } from "/p/the8020/i18n/mod.ts";
import { msg } from "/p/the8020/deployments/i18n/messages.ts";
import Connections from "../../tables/connections.ts";

const PREFIX = "deployments.peer.";

/** Secret usages for `the8020/secrets`: passwords of connected systems. */
export default async function secretUsages(names: string[]) {
  if (!Array.isArray(names)) return [];
  // Connection passwords are named after the connected system's ID.
  const ids = names.filter((name) => name.startsWith(PREFIX))
    .map((name) => name.slice(PREFIX.length));
  if (ids.length === 0) return [];
  const rows = await Connections.select([
    Connections.id,
    Connections.name,
    Connections.url,
  ]).where(Connections.id, "in", ids).limit(1000).execute();
  return rows.map((row) => ({
    secret: `${PREFIX}${row.id}`,
    title: text(msg("secret_usages.connected_system_name", { name: row.name })),
    detail: row.url,
    open: { program: "the8020/deployments/deployments", arguments: [] },
  }));
}
