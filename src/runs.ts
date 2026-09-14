import { context } from "@the8020/context";
import { kernel, WorkerInvokeError } from "@the8020/kernel";
import { requirePermission } from "/p/the8020/auth/mod.ts";
import { getSystemProfile } from "/p/the8020/system/profile.ts";
import Runs from "../tables/runs.ts";
import Lists from "../tables/lists.ts";
import Packages from "/p/the8020/packages/tables/packages.ts";
import {
  commit,
  type DeploymentList,
  deploymentRequest,
  parseList,
  type RunItem,
} from "../types.ts";
import { changeKind, checkBaseline, rollbackList } from "./comparison.ts";
import { credentials, localSnapshot } from "./peers.ts";
import { developmentSource, gitURL, remoteVersions } from "./versions.ts";

const activeRuns = new Set<string>();

async function observedVersion(packageId: string) {
  const row = await Packages.select([Packages.state]).where(
    Packages.packageId,
    "=",
    packageId,
  )
    .where(Packages.state, "!=", "retired").executeTakeFirst();
  if (!row) return { commit: null, state: "retired" };
  // Filesystem publication precedes catalog completion. Observe Git even when a
  // later schema hook fails, rather than reporting the previous catalog commit.
  const repository = await kernel.packages.repository.inspect(packageId);
  return { commit: commit.parse(repository.head), state: row.state };
}
export const workerFunctions = {
  "deployments.run.active": (input: unknown) => {
    if (typeof input !== "string") throw new Error("Run ID is required.");
    return activeRuns.has(input);
  },
};

export async function inspectRun(id: string) {
  await requirePermission("deployments.view", "");
  return await Runs.selectAll().where(Runs.id, "=", id)
    .executeTakeFirstOrThrow();
}

/** Called in a finite ordinary program Worker, independently of UUI navigation. */
export async function executeRun(
  value: unknown,
  listId: string | null = null,
  rollbackOf: string | null = null,
) {
  await requirePermission("deployments.apply", "");
  const input = parseList(value);
  const local = await getSystemProfile();
  if (input.targetSystemId !== local.id) {
    throw new Error("This deployment targets another system.");
  }
  if (listId) {
    const list = await Lists.selectAll().where(Lists.id, "=", listId)
      .executeTakeFirstOrThrow();
    if (JSON.stringify(parseList(list.payload)) !== JSON.stringify(input)) {
      throw new Error("Deployment list does not match its saved input.");
    }
  }
  if (rollbackOf) {
    const original = await inspectRun(rollbackOf);
    if (original.state === "running") {
      throw new Error("A running deployment cannot be rolled back.");
    }
    const expected = rollbackList(original.input, original.packages);
    if (
      JSON.stringify(expected.packages) !== JSON.stringify(input.packages) ||
      expected.sourceSystemId !== input.sourceSystemId ||
      expected.targetSystemId !== input.targetSystemId
    ) {
      throw new Error("Rollback input does not match the recorded run.");
    }
  }
  const id = crypto.randomUUID();
  const items: RunItem[] = input.packages.map((item) => ({
    packageId: item.packageId,
    before: item.before,
    requested: item.target?.commit ?? null,
    requestedTag: item.target?.tag ?? null,
    after: item.before,
    change: "unchanged",
    processed: false,
    state: "pending",
    error: "",
  }));
  // A unique nullable key is shared by every node; interrupted runs keep it.
  await Runs.insert({
    id,
    name: input.name,
    listId,
    rollbackOf,
    input,
    packages: items,
    state: "running",
    error: "",
    lockKey: "apply",
    username: context.username,
    nodeId: context.nodeId,
    sandboxId: context.sandboxId,
    workerId: context.workerId,
    executionId: context.jobRunId ?? context.id,
    createdAt: new Date(),
    finishedAt: null,
  }).execute();
  activeRuns.add(id);
  try {
    let failure = "";
    let unknownOutcome = false;
    try {
      const before = (await localSnapshot(items.map((item) =>
        item.packageId
      ))).packages;
      for (const item of items) {
        item.before = before.find((row) =>
          row.packageId === item.packageId
        )?.commit ?? null;
        item.after = item.before;
      }
      await Runs.update({ packages: items }).where(Runs.id, "=", id).execute();
      const source = await developmentSource(input.sourceSystemId);
      checkBaseline(input, before);
      for (const item of items) {
        let observationError: unknown;
        let history: Awaited<ReturnType<typeof remoteVersions>>["versions"] =
          [];
        try {
          if (item.before && (item.requested || item.requestedTag)) {
            history =
              (await remoteVersions(input.sourceSystemId, item.packageId))
                .versions;
          }
          checkBaseline({
            ...input,
            packages: input.packages.filter((row) =>
              row.packageId === item.packageId
            ),
          }, (await localSnapshot([item.packageId])).packages);
          item.processed = true;
          await Runs.update({ packages: items }).where(Runs.id, "=", id)
            .execute();
          if (item.requested === null && item.requestedTag === null) {
            if (item.before !== null) {
              await kernel.packages.delete(item.packageId, true);
            }
          } else {
            const [author, repository] = item.packageId.split("/") as [
              string,
              string,
            ];
            await kernel.packages.index.set({
              author,
              repository,
              source: gitURL(source.url, item.packageId),
              commit: item.requested ?? "",
              secret: "",
              tag: item.requestedTag ?? "",
              local: false,
            });
            const access = await credentials(source);
            const results = await kernel.packages.synchronize(
              [item.packageId],
              access.password,
              access.username,
            );
            if (results[0]?.commit) {
              const resolved = commit.parse(results[0].commit);
              if (item.requested && item.requested !== resolved) {
                throw new Error("Activation resolved a different commit.");
              }
              item.requested = resolved;
            }
            if (results.length !== 1 || !results[0]!.success) {
              throw new Error(
                results[0]?.error || "Package activation failed.",
              );
            }
          }
          const actual = await observedVersion(item.packageId);
          item.after = actual.commit;
          if (
            item.after !== item.requested ||
            actual.commit && actual.state !== "ready"
          ) {
            throw new Error(
              "Activated package does not match the requested version.",
            );
          }
          item.state = "succeeded";
        } catch (error) {
          item.state = "failed";
          item.error = message(error);
        } finally {
          // Publication can complete before a later hook fails; inspect actual state.
          try {
            item.after = (await observedVersion(item.packageId)).commit;
            item.change = changeKind(item.before, item.after, history);
            await Runs.update({ packages: items }).where(Runs.id, "=", id)
              .execute();
          } catch (error) {
            unknownOutcome = true;
            observationError = error;
          }
        }
        if (observationError) throw observationError;
        if (item.state === "failed") throw new Error(item.error);
      }
    } catch (error) {
      failure = message(error);
    }
    await Runs.update({
      packages: items,
      state: unknownOutcome ? "running" : failure ? "failed" : "succeeded",
      error: failure,
      lockKey: unknownOutcome ? "apply" : null,
      finishedAt: unknownOutcome ? null : new Date(),
    }).where(Runs.id, "=", id).execute();
    return id;
  } finally {
    activeRuns.delete(id);
  }
}

/** Only explicit inspection of the original Worker can release an abandoned run. */
export async function reconcileRun(id: string) {
  await requirePermission("deployments.apply", "");
  const run = await inspectRun(id);
  if (run.state !== "running") return run;
  try {
    const active = await kernel.worker.invoke<boolean>({
      nodeId: run.nodeId,
      sandboxId: run.sandboxId,
      workerId: run.workerId,
      function: "deployments.run.active",
      input: id,
    });
    if (active !== false) throw new Error("This deployment is still running.");
  } catch (error) {
    if (
      !(error instanceof WorkerInvokeError) || error.code !== "target_not_found"
    ) throw error;
  }
  const packages = [];
  for (const item of run.packages) {
    const after = (await observedVersion(item.packageId)).commit;
    packages.push({
      ...item,
      after,
      change: after === item.after
        ? item.change
        : changeKind(item.before, after),
      state: item.state === "pending" && item.processed
        ? "failed" as const
        : item.state,
    });
  }
  await Runs.update({
    packages,
    state: "interrupted",
    lockKey: null,
    finishedAt: new Date(),
    error: run.error ||
      "The original execution ended without recording a complete result. Current package versions were inspected; no work was replayed.",
  }).where(Runs.id, "=", id).where(Runs.state, "=", "running").execute();
  return await inspectRun(id);
}

export async function executeRequest(value: unknown) {
  const request = deploymentRequest.parse(value);
  if ("listId" in request) {
    const list = await Lists.selectAll().where(Lists.id, "=", request.listId)
      .executeTakeFirstOrThrow();
    return await executeRun(list.payload, list.id);
  }
  if ("rollbackOf" in request) {
    const run = await inspectRun(request.rollbackOf);
    return await executeRun(
      rollbackList(run.input, run.packages),
      null,
      run.id,
    );
  }
  return await executeRun(request.input);
}

export async function applyList(
  input: DeploymentList,
  listId: string | null = null,
  rollbackOf: string | null = null,
) {
  await requirePermission("deployments.apply", "");
  input = parseList(input);
  if (listId) {
    const saved = await Lists.selectAll().where(Lists.id, "=", listId)
      .executeTakeFirstOrThrow();
    if (JSON.stringify(parseList(saved.payload)) !== JSON.stringify(input)) {
      throw new Error("Deployment list does not match its saved input.");
    }
  }
  // Large saved lists and rollbacks cross the bounded program bus by immutable ID.
  const request = deploymentRequest.parse(
    rollbackOf ? { rollbackOf } : listId ? { listId } : { input },
  );
  const result = await kernel.programs.run({
    programId: "the8020/deployments/apply",
    arguments: [request],
    timeoutMs: 10 * 60 * 1000,
  });
  if (result.state !== "succeeded") {
    throw new Error(
      result.failure ||
        "Deployment execution failed. Inspect Runs before retrying.",
    );
  }
  if (typeof result.result !== "string") {
    throw new Error("Deployment returned no run ID.");
  }
  return await inspectRun(result.result);
}

export async function rollbackRun(id: string) {
  const run = await inspectRun(id);
  if (run.state === "running") {
    throw new Error("A running deployment cannot be rolled back.");
  }
  return await applyList(rollbackList(run.input, run.packages), null, id);
}

function message(error: unknown) {
  return (error instanceof Error ? error.message : String(error)).slice(
    0,
    8000,
  );
}
