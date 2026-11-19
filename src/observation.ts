import { localizedText as resolveMessage } from "/p/the8020/i18n/mod.ts";
import { msg as messageSymbol } from "/p/the8020/deployments/i18n/messages.ts";
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
      await resolveMessage(
        messageSymbol(
          "errors.repository_inspect_and_repair_its_source_before_retrying",
          { packageId: String(packageId), value2: String(repository.status) },
        ),
      ),
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
      await resolveMessage(
        messageSymbol(
          "errors.an_unfinished_native_activation_phase_blocks_this_check_its_ownership",
          {
            value1: String(pending.activationId),
            value2: String(pending.stage),
            value3: String(pending.activationId),
          },
        ),
      ),
    );
  }
  const database = await kernel.database.check();
  if (
    database.pending_deployment !== false || database.status !== "READY" ||
    database.initialized !== true
  ) {
    throw new Error(
      await resolveMessage(
        messageSymbol(
          "errors.native_schema_activation_is_pending_or_unknown_inspect_native_database",
        ),
      ),
    );
  }
}
