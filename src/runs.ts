import {
  localizedText as resolveMessage,
  text as formatMessage,
} from "/p/the8020/i18n/mod.ts";
import { msg as messageSymbol } from "/p/the8020/deployments/i18n/messages.ts";
import { context } from "@the8020/context";
import { kernel, newId, WorkerInvokeError } from "@the8020/kernel";
import { requirePermission } from "/p/the8020/auth/mod.ts";
import { getSystemProfile } from "/p/the8020/system/profile.ts";
import Runs from "../tables/runs.ts";
import Lists from "../tables/lists.ts";
import Packages from "/p/the8020/packages/tables/packages.ts";
import { z } from "/p/the8020/db/fields.ts";
import { observedVersion, requireSettledActivation } from "./observation.ts";
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

const activeRuns = new Map<string, number>();

export const workerFunctions = {
  "deployments.run.active": (input: unknown) => {
    if (typeof input !== "string") {
      throw new Error(
        formatMessage(messageSymbol("errors.run_id_is_required")),
      );
    }
    return activeRuns.has(input);
  },
};

export async function inspectRun(id: string) {
  await requirePermission("the8020.deployments.view", "");
  return await Runs.selectAll().where(Runs.id, "=", id)
    .executeTakeFirstOrThrow();
}

/** Admit immutable work; version selections run as one staged native set. */
export async function executeRun(
  value: unknown,
  listId: string | null = null,
  rollbackOf: string | null = null,
  forceColumns: string[] = [],
  approvedPlan?: string,
) {
  await requirePermission("the8020.deployments.apply", "");
  const input = parseList(value);
  if (input.packages.length > 256) {
    throw new Error(
      await resolveMessage(
        messageSymbol("errors.a_deployment_may_contain_at_most_256_packages"),
      ),
    );
  }
  if (
    input.packages.length > 1 &&
    input.packages.some((item) => item.target === null)
  ) {
    throw new Error(
      await resolveMessage(
        messageSymbol("errors.package_removal_must_be_deployed_separately"),
      ),
    );
  }
  if (
    (forceColumns.length || approvedPlan) &&
    (input.packages.length !== 1 || input.packages[0]?.target === null)
  ) {
    throw new Error(
      await resolveMessage(
        messageSymbol(
          "errors.schema_force_requires_one_explicit_package_version_package_removal_is",
        ),
      ),
    );
  }
  const local = await getSystemProfile();
  if (input.targetSystemId !== local.id) {
    throw new Error(
      await resolveMessage(
        messageSymbol("errors.this_deployment_targets_another_system"),
      ),
    );
  }
  const activationId = input.packages[0]!.target === null ? null : newId("act");
  if (activationId) {
    await requireSetProtocol();
    const source = await developmentSource(input.sourceSystemId);
    setInput(activationId, input, source.url);
  }
  if (listId) {
    const list = await Lists.selectAll().where(Lists.id, "=", listId)
      .executeTakeFirstOrThrow();
    if (JSON.stringify(parseList(list.payload)) !== JSON.stringify(input)) {
      throw new Error(
        await resolveMessage(
          messageSymbol(
            "errors.deployment_list_does_not_match_its_saved_input",
          ),
        ),
      );
    }
  }
  if (rollbackOf) {
    const original = await inspectRun(rollbackOf);
    if (original.state === "running") {
      throw new Error(
        await resolveMessage(
          messageSymbol("errors.a_running_deployment_cannot_be_rolled_back"),
        ),
      );
    }
    const expected = rollbackList(original.input, original.packages);
    if (
      JSON.stringify(expected.packages) !== JSON.stringify(input.packages) ||
      expected.sourceSystemId !== input.sourceSystemId ||
      expected.targetSystemId !== input.targetSystemId
    ) {
      throw new Error(
        await resolveMessage(
          messageSymbol(
            "errors.rollback_input_does_not_match_the_recorded_run",
          ),
        ),
      );
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
    ...(forceColumns.length ? { forceColumns: [...forceColumns] } : {}),
    ...(approvedPlan ? { approvedPlan } : {}),
  }));
  // A unique nullable key is shared by every node; interrupted runs keep it.
  const admitted = await Runs.insert({
    id,
    name: input.name,
    listId,
    rollbackOf,
    input,
    packages: items,
    state: "running",
    error: "",
    lockKey: "apply",
    nextStep: 0,
    activationId,
    username: context.username,
    nodeId: context.nodeId,
    sandboxId: context.sandboxId,
    workerId: context.workerId,
    executionId: context.jobRunId ?? context.id,
    createdAt: new Date(),
    finishedAt: null,
  }).onConflict((conflict) => conflict.column("lockKey").doNothing())
    .returning("id").executeTakeFirst();
  if (!admitted) {
    const existing = await Runs.select([Runs.id]).where(
      Runs.lockKey,
      "=",
      "apply",
    )
      .executeTakeFirst();
    throw new Error(
      existing
        ? await resolveMessage(
          messageSymbol(
            "errors.deployment_already_holds_the_apply_lock_open_runs_inspect_that",
            { value1: String(existing.id) },
          ),
        )
        : await resolveMessage(
          messageSymbol(
            "errors.another_deployment_was_admitted_concurrently_open_runs_and_inspect_its",
          ),
        ),
    );
  }
  await dispatchStep(id, 0);
  return id;
}

async function dispatchStep(id: string, step: number) {
  try {
    const receipt = await kernel.events.emit("deployments.continue", {
      id,
      step,
    });
    if (!receipt.listeners) {
      throw new Error(
        await resolveMessage(
          messageSymbol(
            "errors.deployment_continuation_listener_is_unavailable",
          ),
        ),
      );
    }
  } catch (error) {
    // The minute listener or Check execution can dispatch this unclaimed step.
    await Runs.update({ error: message(error) }).where(Runs.id, "=", id)
      .where(Runs.nextStep, "=", step).where(Runs.state, "=", "running")
      .execute();
  }
}

const stepInput = z.object({
  id: z.uuid(),
  step: z.number().int().min(0).max(999),
}).strict();

export async function continueRun(value: unknown) {
  const event = z.object({
    name: z.enum(["minute", "deployments.continue"]),
    data: z.unknown(),
  }).parse(value);
  const pending = event.name === "minute"
    ? await Runs.select([Runs.id, Runs.nextStep]).where(
      Runs.lockKey,
      "=",
      "apply",
    )
      .where(Runs.nextStep, "is not", null).executeTakeFirst()
    : null;
  if (event.name === "minute" && !pending) return;
  const { id, step } = stepInput.parse(
    pending ? { id: pending.id, step: pending.nextStep } : event.data,
  );
  activeRuns.set(id, (activeRuns.get(id) ?? 0) + 1);
  try {
    // Claim only this queued step. Duplicate events and other nodes cannot replay it.
    const run = await Runs.update({
      nextStep: null,
      error: "",
      nodeId: context.nodeId,
      sandboxId: context.sandboxId,
      workerId: context.workerId,
      executionId: context.jobRunId ?? context.id,
    }).where(Runs.id, "=", id).where(Runs.state, "=", "running")
      .where(Runs.nextStep, "=", step).returningAll().executeTakeFirst();
    if (!run) return;
    if (run.activationId) {
      await continueSet(run);
      return;
    }
    const input = parseList(run.input),
      items = run.packages,
      item = items[step];
    if (!item || item.processed) {
      throw new Error("Deployment step is not unstarted.");
    }
    let failure = "", unknownOutcome = false;
    let history: Awaited<ReturnType<typeof remoteVersions>>["versions"] = [];
    try {
      await requireSettledActivation();
      // The first step checks the whole reviewed baseline; later steps recheck their package.
      const before = (await localSnapshot(
        step === 0 ? items.map((row) => row.packageId) : [item.packageId],
      )).packages;
      for (const row of step === 0 ? items : [item]) {
        row.before = before.find((actual) =>
          actual.packageId === row.packageId
        )?.commit ?? null;
        row.after = row.before;
      }
      await Runs.update({ packages: items }).where(Runs.id, "=", id).execute();
      checkBaseline(
        step === 0 ? input : { ...input, packages: [input.packages[step]!] },
        before,
      );
      if (
        (item.requested !== null || item.requestedTag !== null) &&
        !before.some((row) => row.packageId === item.packageId) &&
        (await observedVersion(item.packageId)).state !== "absent"
      ) {
        throw new Error(
          await resolveMessage(
            messageSymbol(
              "errors.has_an_unindexed_source_inspect_it_before_deploying_this_package",
              { value1: String(item.packageId) },
            ),
          ),
        );
      }
      const source = await developmentSource(input.sourceSystemId);
      if (item.requested !== null || item.requestedTag !== null) {
        const configured = await Packages.select([
          Packages.source,
          Packages.local,
          Packages.secretName,
        ]).where(Packages.packageId, "=", item.packageId).executeTakeFirst();
        if (
          configured && (configured.local || configured.secretName ||
            configured.source &&
              configured.source !== gitURL(source.url, item.packageId))
        ) {
          throw new Error(
            await resolveMessage(
              messageSymbol(
                "errors.has_a_local_or_custom_source_configuration_review_it_before",
                { value1: String(item.packageId) },
              ),
            ),
          );
        }
      }
      if (item.before && (item.requested || item.requestedTag)) {
        history =
          (await remoteVersions(input.sourceSystemId, item.packageId)).versions;
      }
      item.processed = true;
      await Runs.update({ packages: items }).where(Runs.id, "=", id).execute();
      if (item.requested === null && item.requestedTag === null) {
        if (before.some((row) => row.packageId === item.packageId)) {
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
          {
            force_columns: item.forceColumns ?? [],
            approved_plan: item.approvedPlan,
          },
        );
        if (results[0]?.commit) {
          const resolved = commit.parse(results[0].commit);
          if (item.requested && item.requested !== resolved) {
            throw new Error(
              await resolveMessage(
                messageSymbol("errors.activation_resolved_a_different_commit"),
              ),
            );
          }
          item.requested = resolved;
        }
        if (results.length !== 1 || !results[0]!.success) {
          throw new Error(
            results[0]?.error ||
              await resolveMessage(
                messageSymbol("errors.package_activation_failed"),
              ),
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
          await resolveMessage(
            messageSymbol(
              "errors.activated_package_does_not_match_the_requested_version",
            ),
          ),
        );
      }
      item.state = "succeeded";
    } catch (error) {
      failure = item.error = message(error);
      item.state = "failed";
    }
    try {
      item.after = (await observedVersion(item.packageId)).commit;
      item.change = changeKind(item.before, item.after, history);
      await requireSettledActivation();
    } catch (error) {
      unknownOutcome = true;
      failure = message(error);
    }
    const nextStep = !failure && step + 1 < items.length ? step + 1 : null;
    await Runs.update({
      packages: items,
      error: failure,
      nextStep,
      state: unknownOutcome || nextStep !== null
        ? "running"
        : failure
        ? "failed"
        : "succeeded",
      lockKey: unknownOutcome || nextStep !== null ? "apply" : null,
      finishedAt: unknownOutcome || nextStep !== null ? null : new Date(),
    }).where(Runs.id, "=", id).execute();
    if (nextStep !== null) await dispatchStep(id, nextStep);
  } finally {
    const active = activeRuns.get(id)! - 1;
    if (active) activeRuns.set(id, active);
    else activeRuns.delete(id);
  }
}

const setCommand = "kernel.packages.synchronize.set";

async function requireSetProtocol() {
  try {
    const capability = await kernel.admin.execute(setCommand);
    if (capability.protocol !== 1 || capability.maximum !== 256) {
      throw new Error("Unsupported staged-set protocol.");
    }
  } catch (error) {
    throw new Error(
      await resolveMessage(
        messageSymbol(
          "errors.deployment_requires_native_staged_set_support_and_the_updated_packages",
          { value1: String(message(error)) },
        ),
      ),
    );
  }
}

function setInput(id: string, input: DeploymentList, url: string) {
  const encoded = JSON.stringify({
    activation_id: id,
    packages: input.packages.map((item) => ({
      package_id: item.packageId,
      source: gitURL(url, item.packageId),
      commit: item.target?.commit ?? "",
      tag: item.target?.tag ?? "",
      before: item.before ?? "",
    })),
  });
  if (new TextEncoder().encode(encoded).byteLength > 256 * 1024) {
    throw new Error(
      formatMessage(
        messageSymbol("errors.native_staged_set_input_exceeds_256_kib"),
      ),
    );
  }
  return encoded;
}

async function continueSet(run: Awaited<ReturnType<typeof inspectRun>>) {
  const input = parseList(run.input), items = run.packages;
  const histories = new Map<
    string,
    Awaited<ReturnType<typeof remoteVersions>>["versions"]
  >();
  let failure = "", uncertain = false;
  try {
    if (!run.activationId || items.some((item) => item.processed)) {
      throw new Error(
        await resolveMessage(
          messageSymbol("errors.deployment_set_has_already_been_claimed"),
        ),
      );
    }
    await requireSetProtocol();
    await requireSettledActivation();
    const before = (await localSnapshot(items.map((item) => item.packageId)))
      .packages;
    for (const item of items) {
      item.before = before.find((row) => row.packageId === item.packageId)
        ?.commit ?? null;
      item.after = item.before;
    }
    await Runs.update({ packages: items }).where(Runs.id, "=", run.id)
      .execute();
    checkBaseline(input, before);
    const source = await developmentSource(input.sourceSystemId);
    for (const item of items) {
      if (item.before) {
        histories.set(
          item.packageId,
          (await remoteVersions(input.sourceSystemId, item.packageId)).versions,
        );
      }
    }
    const payload = setInput(run.activationId, input, source.url);
    const access = await credentials(source);
    for (const item of items) item.processed = true;
    await Runs.update({ packages: items }).where(Runs.id, "=", run.id)
      .execute();
    const response = await kernel.admin.execute(setCommand, {
      input: payload,
      git_token: access.password,
      git_username: access.username,
      force_columns: items[0]?.forceColumns?.join(",") ?? "",
      approved_plan: items[0]?.approvedPlan ?? "",
    });
    const results = z.array(z.object({
      package_id: z.string(),
      commit,
      success: z.literal(true),
    })).length(items.length).parse(response.packages);
    if (
      new Set(results.map((result) => result.package_id)).size !== items.length
    ) {
      throw new Error(
        await resolveMessage(
          messageSymbol("errors.native_activation_returned_duplicate_packages"),
        ),
      );
    }
    for (const item of items) {
      const result = results.find((row) => row.package_id === item.packageId);
      if (!result || item.requested && result.commit !== item.requested) {
        throw new Error(
          await resolveMessage(
            messageSymbol(
              "errors.native_activation_did_not_match_the_selected_set",
            ),
          ),
        );
      }
      item.requested = result.commit;
      const actual = await observedVersion(item.packageId);
      item.after = actual.commit;
      if (actual.commit !== result.commit || actual.state !== "ready") {
        throw new Error(
          await resolveMessage(
            messageSymbol("errors.does_not_match_its_activated_version", {
              value1: String(item.packageId),
            }),
          ),
        );
      }
    }
    for (const item of items) item.state = "succeeded";
  } catch (error) {
    failure = message(error);
    for (const item of items) {
      item.state = "failed";
      item.error = failure;
    }
  }
  try {
    for (const item of items) {
      item.after = (await observedVersion(item.packageId)).commit;
      item.change = changeKind(
        item.before,
        item.after,
        histories.get(item.packageId),
      );
    }
    await requireSettledActivation();
  } catch (error) {
    uncertain = true;
    failure = await resolveMessage(
      messageSymbol(
        "errors.activation_inspect_it_with_kernel_packages_activation_inspect_after_the",
        { value1: String(run.activationId), value2: String(message(error)) },
      ),
    );
  }
  await Runs.update({
    packages: items,
    error: failure,
    state: uncertain ? "running" : failure ? "failed" : "succeeded",
    lockKey: uncertain ? "apply" : null,
    finishedAt: uncertain ? null : new Date(),
  }).where(Runs.id, "=", run.id).execute();
}

/** Only explicit inspection of the original Worker can release an abandoned run. */
export async function reconcileRun(id: string) {
  await requirePermission("the8020.deployments.apply", "");
  const run = await inspectRun(id);
  if (run.state !== "running") return run;
  if (run.nextStep !== null) {
    await dispatchStep(id, run.nextStep);
    return await inspectRun(id);
  }
  try {
    const active = await kernel.worker.invoke<boolean>({
      nodeId: run.nodeId,
      sandboxId: run.sandboxId,
      workerId: run.workerId,
      function: "deployments.run.active",
      input: id,
    });
    if (active !== false) {
      throw new Error(
        await resolveMessage(
          messageSymbol("errors.this_deployment_is_still_running"),
        ),
      );
    }
  } catch (error) {
    if (
      !(error instanceof WorkerInvokeError) || error.code !== "target_not_found"
    ) throw error;
  }
  await requireSettledActivation();
  const packages = [];
  for (const item of run.packages) {
    const actual = await observedVersion(item.packageId);
    const after = actual.commit;
    packages.push({
      ...item,
      after,
      change: after === item.after
        ? item.change
        : changeKind(item.before, after),
      state: (item.state === "pending" && item.processed) ||
          (item.state === "succeeded" &&
            (after !== item.after ||
              (after !== null && actual.state !== "ready")))
        ? "failed" as const
        : item.state,
    });
  }
  await requireSettledActivation();
  await Runs.update({
    packages,
    state: "interrupted",
    lockKey: null,
    finishedAt: new Date(),
    error: run.error ||
      await resolveMessage(
        messageSymbol(
          "errors.the_original_execution_ended_without_recording_a_complete_result_current",
        ),
      ),
  }).where(Runs.id, "=", id).where(Runs.state, "=", "running")
    .where(Runs.nextStep, "is", null).where(
      Runs.executionId,
      "=",
      run.executionId,
    ).execute();
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
  return await executeRun(
    request.input,
    null,
    null,
    request.forceColumns,
    request.approvedPlan,
  );
}

export async function applyList(
  input: DeploymentList,
  listId: string | null = null,
  rollbackOf: string | null = null,
) {
  await requirePermission("the8020.deployments.apply", "");
  input = parseList(input);
  if (listId) {
    const saved = await Lists.selectAll().where(Lists.id, "=", listId)
      .executeTakeFirstOrThrow();
    if (JSON.stringify(parseList(saved.payload)) !== JSON.stringify(input)) {
      throw new Error(
        await resolveMessage(
          messageSymbol(
            "errors.deployment_list_does_not_match_its_saved_input",
          ),
        ),
      );
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
        await resolveMessage(
          messageSymbol(
            "errors.deployment_execution_failed_inspect_runs_before_retrying",
          ),
        ),
    );
  }
  if (typeof result.result !== "string") {
    throw new Error(
      await resolveMessage(
        messageSymbol("errors.deployment_returned_no_run_id"),
      ),
    );
  }
  return await inspectRun(result.result);
}

export async function rollbackRun(id: string) {
  const run = await inspectRun(id);
  if (run.state === "running") {
    throw new Error(
      await resolveMessage(
        messageSymbol("errors.a_running_deployment_cannot_be_rolled_back"),
      ),
    );
  }
  return await applyList(rollbackList(run.input, run.packages), null, id);
}

function message(error: unknown) {
  return (error instanceof Error ? error.message : String(error)).slice(
    0,
    8000,
  );
}
