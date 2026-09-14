import { t, table, type TableDatabase } from "/p/the8020/db/mod.ts";
import { type DeploymentList, name, type RunItem, runState } from "../types.ts";
const Runs = table("the8020__deployments__runs", {
  id: t.text().primaryKey(),
  name: t.from(name),
  listId: t.text().nullable(),
  rollbackOf: t.text().nullable(),
  input: t.json<DeploymentList>(),
  packages: t.json<RunItem[]>(),
  state: t.from(runState),
  error: t.text(),
  username: t.text(),
  nodeId: t.text(),
  sandboxId: t.text(),
  workerId: t.text(),
  executionId: t.text(),
  lockKey: t.text().nullable(),
  createdAt: t.datetime().defaultNow(),
  finishedAt: t.datetime().nullable(),
}, {
  indexes: [
    { columns: ["lockKey"], unique: true },
    { columns: ["createdAt", "id"] },
  ],
});
declare module "/p/the8020/db/types.ts" {
  interface Database extends TableDatabase<typeof Runs> {}
}
export default Runs;
