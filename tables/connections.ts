import { t, table, type TableDatabase } from "/p/the8020/db/mod.ts";
import { connection } from "../types.ts";
const Connections = table("the8020__deployments__connections", {
  id: t.from(connection.shape.id).primaryKey(),
  name: t.from(connection.shape.name),
  role: t.from(connection.shape.role),
  url: t.from(connection.shape.url),
  username: t.from(connection.shape.username).default(""),
}, { indexes: [{ columns: ["url"], unique: true }] });
declare module "/p/the8020/db/types.ts" {
  interface Database extends TableDatabase<typeof Connections> {}
}
export default Connections;
