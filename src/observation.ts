import { kernel } from "@the8020/kernel";
import Packages from "/p/the8020/packages/tables/packages.ts";
import Activations from "/p/the8020/packages/tables/activations.ts";
import { commit } from "../types.ts";

export async function observedVersion(packageId: string) {
  const repository = await kernel.packages.repository.inspect(packageId);
  if (repository.status === "absent" || repository.status === "empty") {
    return { commit: null, state: "absent" };
  }
  if (!repository.head) {
    throw new Error(
      `${packageId}: repository ${repository.status}. Inspect and repair its source before retrying.`,
    );
  }
  const head = commit.parse(repository.head);
  const row = await Packages.select([Packages.state, Packages.activeCommit])
    .where(Packages.packageId, "=", packageId).executeTakeFirst();
  return {
    commit: head,
    state: repository.status === "ready" && row?.state === "ready" &&
        row.activeCommit === head
      ? "ready"
      : "incomplete",
  };
}

export async function requireSettledActivation() {
  const pending = await Activations.select([
    Activations.activationId,
    Activations.stage,
  ])
    .where(Activations.stage, "not in", ["complete", "failed"])
    .limit(1).executeTakeFirst();
  if (pending) {
    throw new Error(
      `An unfinished native activation ${pending.activationId} (phase: ${pending.stage}) blocks this check. Its ownership is not established here; a system operator must inspect its recovery before retrying. If available, kernel.packages.activation.inspect ${pending.activationId} shows its recorded candidates and hooks.`,
    );
  }
  const database = await kernel.database.check();
  if (
    database.pending_deployment !== false || database.status !== "READY" ||
    database.initialized !== true
  ) {
    throw new Error(
      "Native schema activation is pending or unknown. Inspect native database/activation recovery before checking this deployment again.",
    );
  }
}
