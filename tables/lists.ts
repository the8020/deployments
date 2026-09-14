import { t, table, type TableDatabase } from "/p/the8020/db/mod.ts";
import { type DeploymentList, deploymentList } from "../types.ts";
const Lists = table("the8020__deployments__lists", {
  id: t.from(deploymentList.shape.id).primaryKey(),
  slot: t.integer().unique(),
  name: t.from(deploymentList.shape.name),
  targetSystemId: t.from(deploymentList.shape.targetSystemId),
  payload: t.json<DeploymentList>(),
  received: t.boolean(),
  createdAt: t.datetime().defaultNow(),
}, { indexes: [{ columns: ["createdAt", "id"] }] });
declare module "/p/the8020/db/types.ts" {
  interface Database extends TableDatabase<typeof Lists> {}
}
export default Lists;
