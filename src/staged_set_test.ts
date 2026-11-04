import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { DatabaseFixture } from "./test_support.ts";
import { type KernelInvoke, kernelInvokeSymbol, newId } from "@the8020/kernel";
import { getSystemProfile } from "/p/the8020/system/profile.ts";
import { setSecret } from "/p/the8020/secrets/mod.ts";
import Packages from "/p/the8020/packages/tables/packages.ts";
import Activations from "/p/the8020/packages/tables/activations.ts";
import Connections from "../tables/connections.ts";
import Runs from "../tables/runs.ts";
import { continueRun, executeRun, inspectRun, reconcileRun } from "./runs.ts";
import type { DeploymentList } from "../types.ts";

Deno.test("one durable staged set retains exact input, exclusion and uncertain recovery", async () => {
  const fixture = new DatabaseFixture(), fetchBefore = globalThis.fetch;
  const heads = new Map<string, string>();
  const events: unknown[] = [], native: Record<string, unknown>[] = [];
  const commit = "a".repeat(40);
  let fail = false, live = false, protocol = 1;
  try {
    const local = await getSystemProfile();
    const source = { ...local, id: newId("sys"), role: "development" as const };
    await Connections.insert({
      ...source,
      url: "http://source.invalid",
      username: "deployer",
    }).execute();
    await setSecret({
      name: `deployments.peer.${source.id}`,
      value: "private-password",
    });
    globalThis.fetch = () =>
      Promise.resolve(Response.json({ system: source, packages: [] }));
    fixture.operation = async (name, input) => {
      if (name === "event.emit") {
        events.push({ name: input.name, data: input.data });
        return { listeners: 1 };
      }
      if (name === "database.check") {
        return {
          status: "READY",
          initialized: true,
          pending_deployment: false,
        };
      }
      if (name === "package.repository.inspect") {
        const head = heads.get(String(input.package_id));
        return {
          repository: head ? { status: "ready", head } : { status: "absent" },
        };
      }
      if (name === "admin.execute") {
        assertEquals(input.command_id, "kernel.packages.synchronize.set");
        const args = input.arguments as Record<string, unknown>;
        if (!args.input) return { protocol, maximum: 256 };
        native.push(args);
        assertEquals(args.git_token, "private-password");
        assertEquals(args.git_username, "deployer");
        const request = JSON.parse(String(args.input)) as {
          activation_id: string;
          packages: Array<
            {
              package_id: string;
              source: string;
              commit: string;
              tag: string;
              before: string;
            }
          >;
        };
        await Activations.insert({
          activationId: request.activation_id,
          stage: fail ? "code_switched" : "complete",
          error: null,
          previousPackageSetHash: "previous",
          candidatePackageSetHash: "candidate",
          startedAt: new Date(),
          updatedAt: new Date(),
          completedAt: null,
        }).execute();
        for (const item of request.packages) {
          assertEquals(item.before, "");
          assertEquals(
            item.source,
            `http://source.invalid/the8020/deployments/peer/git/${item.package_id}.git`,
          );
          const [author, repository] = item.package_id.split("/") as [
            string,
            string,
          ];
          heads.set(item.package_id, commit);
          await Packages.insert({
            packageId: item.package_id,
            author,
            repository,
            source: item.source,
            requestedCommit: item.commit || null,
            requestedTag: item.tag || null,
            secretName: null,
            local: false,
            activeCommit: fail ? null : commit,
            state: fail ? "activating" : "ready",
            error: null,
            revision: 0,
            createdAt: new Date(),
            updatedAt: new Date(),
          }).execute();
        }
        if (fail) throw new Error("post hook failed after switching the set");
        return {
          packages: request.packages.map((item) => ({
            package_id: item.package_id,
            commit,
            success: true,
          })),
        };
      }
      throw new Error(`Unexpected operation ${name}`);
    };
    (globalThis as unknown as Record<symbol, unknown>)[kernelInvokeSymbol] =
      ((operation, input) =>
        operation === "worker.invoke"
          ? Promise.resolve({ ok: true, output: live })
          : fixture.invoke(operation, input)) satisfies KernelInvoke;
    const input: DeploymentList = {
      schema: 1,
      id: crypto.randomUUID(),
      name: "Cycle",
      sourceSystemId: source.id,
      targetSystemId: local.id,
      packages: ["acme/alpha", "acme/beta"].map((packageId) => ({
        packageId,
        before: null,
        target: { commit, tag: null },
      })),
    };
    protocol = 0;
    await assertRejects(() => executeRun(input), Error, "staged-set support");
    assertEquals(await Runs.selectAll().execute(), []);
    protocol = 1;
    const id = await executeRun(input);
    const accepted = await inspectRun(id);
    assertStringIncludes(accepted.activationId!, "act-");
    input.name = "Edited after admission";
    await assertRejects(() => executeRun(input), Error, "apply lock");
    const event = events.shift();
    await Promise.all([continueRun(event), continueRun(event)]);
    const done = await inspectRun(id);
    assertEquals(native.length, 1);
    assertEquals(done.input.name, "Cycle");
    assertEquals(done.state, "succeeded");
    assertEquals(done.nextStep, null);
    assertEquals(done.lockKey, null);
    assertEquals(
      done.packages.map((item) => [item.processed, item.state, item.after]),
      [[true, "succeeded", commit], [true, "succeeded", commit]],
    );
    assertEquals(
      JSON.parse(String(native[0]!.input)).activation_id,
      done.activationId,
    );
    assertEquals(JSON.stringify(done).includes("private-password"), false);

    // Both selected sources switched, but the failed native activation is still pending.
    fail = true;
    input.packages = ["acme/gamma", "acme/delta"].map((packageId) => ({
      packageId,
      before: null,
      target: { commit, tag: null },
    }));
    const failedId = await executeRun(input);
    await continueRun(events.shift());
    const pending = await inspectRun(failedId);
    assertEquals(pending.state, "running");
    assertEquals(pending.lockKey, "apply");
    assertStringIncludes(pending.error, pending.activationId!);
    assertStringIncludes(pending.error, "kernel.packages.activation.resume");
    await continueRun({ name: "minute", data: null });
    assertEquals(native.length, 2);
    await assertRejects(
      () => reconcileRun(failedId),
      Error,
      "unfinished native activation",
    );
    await Activations.update({ stage: "complete" }).where(
      Activations.activationId,
      "=",
      pending.activationId!,
    ).execute();
    await Packages.update({ state: "ready", activeCommit: commit }).execute();
    live = true;
    await assertRejects(() => reconcileRun(failedId), Error, "still running");
    assertEquals((await inspectRun(failedId)).lockKey, "apply");
    live = false;
    const settled = await reconcileRun(failedId);
    assertEquals(settled.state, "interrupted");
    assertEquals(settled.lockKey, null);
    assertEquals(settled.packages.map((item) => item.after), [commit, commit]);
    assertEquals(native.length, 2);
  } finally {
    globalThis.fetch = fetchBefore;
    fixture.close();
  }
});
