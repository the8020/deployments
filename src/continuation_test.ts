import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { DatabaseFixture } from "./test_support.ts";
import { type KernelInvoke, kernelInvokeSymbol, newId } from "@the8020/kernel";
import { getSystemProfile } from "/p/the8020/system/profile.ts";
import { setSecret } from "/p/the8020/secrets/mod.ts";
import Packages from "/p/the8020/packages/tables/packages.ts";
import Activations from "/p/the8020/packages/tables/activations.ts";
import Connections from "../tables/connections.ts";
import Runs from "../tables/runs.ts";
import {
  continueRun,
  executeRun,
  inspectRun,
  reconcileRun,
  workerFunctions,
} from "./runs.ts";
import type { DeploymentList } from "../types.ts";

Deno.test("bounded package steps survive lost dispatch, exclude concurrent admission and never replay claimed work", async () => {
  const fixture = new DatabaseFixture(), originalFetch = globalThis.fetch;
  const events: unknown[] = [], calls: string[] = [];
  const head = "a".repeat(40), heads = new Map<string, string>();
  let repositoryStatus = "absent", pendingNative: boolean | undefined = false;
  let failObservation = "",
    worker: boolean | "missing" | "unavailable" = "missing";
  try {
    const local = await getSystemProfile();
    const source = { ...local, id: newId("sys"), role: "development" as const };
    await Connections.insert({
      ...source,
      url: "http://source.invalid",
      username: "admin",
    }).execute();
    await setSecret({ name: `deployments.peer.${source.id}`, value: "test" });
    globalThis.fetch = () =>
      Promise.resolve(Response.json({ system: source, packages: [] }));
    fixture.operation = async (name, input) => {
      if (name === "event.emit") {
        events.push({ name: input.name, data: input.data });
        return { listeners: 1 };
      }
      if (name === "database.check") {
        return {
          pending_deployment: pendingNative,
          status: "READY",
          initialized: true,
        };
      }
      if (name === "package.repository.inspect") {
        if (failObservation) throw new Error(failObservation);
        const commit = heads.get(String(input.package_id));
        return {
          repository: commit
            ? { status: "ready", head: commit }
            : { status: repositoryStatus },
        };
      }
      if (name === "package.index.set") {
        const id = `${input.author}/${input.repository}`;
        await Packages.insert({
          packageId: id,
          author: String(input.author),
          repository: String(input.repository),
          source: String(input.source),
          requestedCommit: head,
          requestedTag: null,
          secretName: null,
          local: false,
          activeCommit: null,
          state: "desired",
          error: null,
          revision: 0,
          createdAt: new Date(),
          updatedAt: new Date(),
        }).onConflict((c) => c.column("packageId").doNothing()).execute();
        return { package: input };
      }
      if (name === "package.synchronize") {
        const id = String(input.packages);
        calls.push(id);
        heads.set(id, head);
        await Packages.update({ state: "ready", activeCommit: head }).where(
          Packages.packageId,
          "=",
          id,
        ).execute();
        return { packages: [{ success: true, commit: head }] };
      }
      throw new Error(`Unexpected ${name}`);
    };
    (globalThis as unknown as Record<symbol, unknown>)[kernelInvokeSymbol] =
      ((operation, input) => {
        if (operation === "worker.invoke") {
          return Promise.resolve(
            typeof worker === "boolean" ? { ok: true, output: worker } : {
              ok: false,
              error: {
                code: worker === "missing" ? "target_not_found" : "unavailable",
                message: worker,
              },
            },
          );
        }
        return fixture.invoke(operation, input);
      }) satisfies KernelInvoke;
    const input: DeploymentList = {
      schema: 1,
      id: crypto.randomUUID(),
      name: "Two bounded windows",
      sourceSystemId: source.id,
      targetSystemId: local.id,
      packages: ["acme/one", "acme/two"].map((packageId) => ({
        packageId,
        before: null,
        target: { commit: head, tag: null },
      })),
    };
    const attempts = await Promise.allSettled([
      executeRun(input),
      executeRun(input),
    ]);
    const admitted = attempts.find((result) => result.status === "fulfilled")!;
    if (admitted.status !== "fulfilled") throw new Error("No run admitted");
    const id = admitted.value;
    const rejected = attempts.find((result) => result.status === "rejected")!;
    if (rejected.status !== "rejected") {
      throw new Error("Concurrent admission succeeded");
    }
    assertStringIncludes(String(rejected.reason), id);
    assertStringIncludes(String(rejected.reason), "Check execution");
    input.name = "Later edit";
    assertEquals((await inspectRun(id)).input.name, "Two bounded windows");
    const first = events.shift();
    await Promise.all([continueRun(first), continueRun(first)]);
    assertEquals(workerFunctions["deployments.run.active"](id), false);
    assertEquals(calls, ["acme/one"]);
    assertEquals((await inspectRun(id)).nextStep, 1);
    assertEquals((await inspectRun(id)).lockKey, "apply");
    // Losing event delivery or restarting between executions cannot lose the saved checkpoint.
    events.length = 0;
    await continueRun({ name: "minute", data: null });
    await continueRun(first);
    const complete = await inspectRun(id);
    assertEquals(calls, ["acme/one", "acme/two"]);
    assertEquals(complete.state, "succeeded");
    assertEquals(complete.lockKey, null);
    assertEquals(complete.packages.map((p) => p.state), [
      "succeeded",
      "succeeded",
    ]);

    // Saved in-flight state models a killed Worker; automatic continuation must never claim it.
    for (const status of ["absent", "empty"]) {
      const stopped = await executeRun({
        ...input,
        packages: [{
          packageId: "acme/stopped",
          before: null,
          target: { commit: head, tag: null },
        }],
      });
      const run = await inspectRun(stopped);
      run.packages[0]!.processed = true;
      await Runs.update({ nextStep: null, packages: run.packages }).where(
        Runs.id,
        "=",
        stopped,
      ).execute();
      repositoryStatus = status;
      await continueRun({ name: "minute", data: null });
      await continueRun(events.pop());
      assertEquals(calls.length, 2);
      worker = true;
      await assertRejects(() => reconcileRun(stopped), Error, "still running");
      worker = "unavailable";
      await assertRejects(() => reconcileRun(stopped), Error, "unavailable");
      worker = "missing";
      for (const pending of [true, undefined]) {
        pendingNative = pending;
        await assertRejects(
          () => reconcileRun(stopped),
          Error,
          "pending or unknown",
        );
        assertEquals((await inspectRun(stopped)).lockKey, "apply");
      }
      pendingNative = false;
      await Activations.insert({
        activationId: "act-0123456789",
        stage: "pre_activated",
        error: null,
        previousPackageSetHash: "",
        candidatePackageSetHash: "",
        startedAt: new Date(),
        updatedAt: new Date(),
        completedAt: null,
      }).execute();
      await assertRejects(() => reconcileRun(stopped), Error, "act-0123456789");
      await Activations.delete().execute();
      for (const error of ["permission denied", "transport failed"]) {
        failObservation = error;
        await assertRejects(() => reconcileRun(stopped), Error, error);
        assertEquals((await inspectRun(stopped)).lockKey, "apply");
      }
      failObservation = "";
      const reconciled = await reconcileRun(stopped);
      assertEquals(reconciled.state, "interrupted");
      assertEquals(reconciled.packages[0]?.after, null);
      assertEquals(reconciled.packages[0]?.state, "failed");
      assertEquals(reconciled.lockKey, null);
      assertEquals(calls.length, 2);
    }
    const originalInvoke = fixture.invoke;
    (globalThis as unknown as Record<symbol, unknown>)[kernelInvokeSymbol] =
      ((operation, args) => {
        if (
          operation === "database.execute" &&
          String(args.statement).startsWith(
            'insert into "the8020__deployments__runs"',
          )
        ) {
          return Promise.reject(new Error("database is read only"));
        }
        return originalInvoke(operation, args);
      }) satisfies KernelInvoke;
    await assertRejects(
      () => executeRun(input),
      Error,
      "database is read only",
    );
  } finally {
    globalThis.fetch = originalFetch;
    fixture.close();
  }
});
