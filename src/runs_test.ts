import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import { DatabaseFixture } from "./test_support.ts";
import { kernel, type KernelInvoke, kernelInvokeSymbol } from "@the8020/kernel";
import {
  getSystemProfile,
  requireDevelopment,
  setSystemProfile,
} from "/p/the8020/system/profile.ts";
import { type DeploymentList, parseList } from "../types.ts";
import {
  changeKind,
  checkBaseline,
  compareSystems,
  rollbackList,
} from "./comparison.ts";
const { applyList, executeRun, inspectRun, reconcileRun } = await import(
  "./runs.ts"
);
const { default: Runs } = await import("../tables/runs.ts");
const { default: Connections } = await import("../tables/connections.ts");
const { default: Packages } = await import(
  "/p/the8020/packages/tables/packages.ts"
);
const {
  saveList,
  receiveList,
  localSnapshot,
  saveConnection,
  removeConnection,
} = await import("./peers.ts");
const { default: Lists } = await import("../tables/lists.ts");

const first = "a".repeat(40), second = "b".repeat(40);
Deno.test("profiles, immutable queued inputs, apply, partial failure and rollback use shared database contracts", async () => {
  const fixture = new DatabaseFixture();
  const originalFetch = globalThis.fetch;
  try {
    const profile = await getSystemProfile();
    assertEquals(await getSystemProfile(), profile);
    await setSystemProfile({ name: "Acceptance", role: "test" });
    assertEquals((await getSystemProfile()).id, profile.id);
    await assertRejects(requireDevelopment, Error, "development");
    const source = { ...profile, id: crypto.randomUUID(), name: "Development" };
    await Connections.insert({
      ...source,
      url: "https://dev.example.invalid",
      username: "deployer",
    })
      .execute();
    await kernel.secrets.set({
      name: `deployments.peer.${source.id}`,
      value: "páss:word",
    });
    globalThis.fetch = (url, init) => {
      assertEquals(
        new Headers(init?.headers).get("Authorization"),
        `Basic ${new TextEncoder().encode("deployer:páss:word").toBase64()}`,
      );
      return Promise.resolve(Response.json(
        String(url).includes("/versions/")
          ? {
            package_id: "acme/app",
            versions: [first, second].map((id) => ({
              commit: id,
              parents: id === first ? [] : [first],
              short_commit: id.slice(0, 12),
              authored_at: "",
              author: "Test",
              subject: "Release",
              tags: [],
              current: false,
              selected: false,
            })),
          }
          : String(url).endsWith("/identity")
          ? source
          : { system: source, packages: [] },
      ));
    };
    const connected = await saveConnection(
      "https://dev.example.invalid",
      "deployer",
      "páss:word",
    );
    assertEquals("password" in connected, false);
    assertEquals(
      "password" in (await Connections.selectAll().execute())[0]!,
      false,
    );
    const list: DeploymentList = {
      schema: 1,
      id: crypto.randomUUID(),
      name: "First release",
      sourceSystemId: source.id,
      targetSystemId: profile.id,
      packages: [{
        packageId: "acme/app",
        before: null,
        target: { commit: first, tag: null },
      }],
    };
    assertThrows(() =>
      parseList({ ...list, packages: [...list.packages, ...list.packages] })
    );
    assertThrows(() =>
      parseList({
        ...list,
        packages: [{ ...list.packages[0], packageId: "../app" }],
      })
    );
    await receiveList(list);
    await assertRejects(
      () => saveList({ ...list, name: "Impersonated" }),
      Error,
      "already has this ID",
    );
    assertEquals((await Lists.selectAll().execute()).length, 1);
    const calls: string[] = [];
    const heads = new Map<string, string | null>();
    let failAfterPublish = false;
    fixture.operation = async (name, input) => {
      if (name === "package.repository.inspect") {
        return { repository: { head: heads.get(String(input.package_id)) } };
      }
      calls.push(name);
      if (name === "package.index.set") {
        const packageId = `${input.author}/${input.repository}`;
        await Packages.insert({
          packageId,
          author: String(input.author),
          repository: String(input.repository),
          source: String(input.source),
          requestedCommit: String(input.commit),
          requestedTag: null,
          secretName: null,
          local: false,
          activeCommit: null,
          state: "desired",
          error: null,
          revision: 0,
          createdAt: new Date(),
          updatedAt: new Date(),
        }).onConflict((conflict) =>
          conflict.column("packageId").doUpdateSet({
            requestedCommit: String(input.commit),
          })
        ).execute();
        return { package: input };
      }
      if (name === "package.synchronize") {
        assertEquals(input.git_username, "deployer");
        assertEquals(input.git_token, "páss:word");
        const packageId = String(input.packages);
        const row = await Packages.selectAll().where(
          Packages.packageId,
          "=",
          packageId,
        ).executeTakeFirstOrThrow();
        heads.set(packageId, row.requestedCommit);
        if (failAfterPublish) throw new Error("Hook failed after publication");
        await Packages.update({
          activeCommit: row.requestedCommit,
          state: "ready",
        }).where(Packages.packageId, "=", packageId).execute();
        return {
          packages: [{
            package_id: packageId,
            commit: row.requestedCommit,
            success: true,
          }],
        };
      }
      if (name === "package.delete") {
        await Packages.update({ state: "retired" }).where(
          Packages.packageId,
          "=",
          String(input.package_id),
        ).execute();
        return {};
      }
      throw new Error(`Unexpected ${name}`);
    };
    const id = await executeRun(list, list.id);
    const run = await inspectRun(id);
    assertEquals(run.state, "succeeded");
    assertEquals(run.packages.map(({ before, after }) => [before, after]), [[
      null,
      first,
    ]]);
    await Lists.delete().where(Lists.id, "=", list.id).execute();
    assertEquals((await inspectRun(id)).input, list);
    const stale = await executeRun(list);
    assertEquals((await inspectRun(stale)).state, "failed");
    assertEquals(calls, ["package.index.set", "package.synchronize"]);
    const update = {
      ...list,
      id: crypto.randomUUID(),
      packages: [{
        packageId: "acme/app",
        before: first,
        target: { commit: second, tag: null },
      }],
    };
    failAfterPublish = true;
    const failed = await inspectRun(await executeRun(update));
    assertEquals(failed.state, "failed");
    assertEquals(failed.packages[0]?.after, second);
    assertEquals(failed.packages[0]?.change, "upgraded");
    // The physical source changed even though the catalog hook did not finish.
    assertEquals((await localSnapshot()).packages[0]?.commit, first);
    await Packages.update({ activeCommit: second }).where(
      Packages.packageId,
      "=",
      "acme/app",
    ).execute();
    failAfterPublish = false;
    const rollback = rollbackList(failed.input, failed.packages);
    const restored = await inspectRun(
      await executeRun(rollback, null, failed.id),
    );
    assertEquals(restored.rollbackOf, failed.id);
    assertEquals(restored.packages[0]?.after, first);
    assertEquals(restored.packages[0]?.change, "downgraded");
    const remove = rollbackList(run.input, run.packages);
    const removed = await inspectRun(await executeRun(remove, null, run.id));
    assertEquals(removed.packages[0]?.after, null);
    const local = await localSnapshot();
    const available = {
      ...local,
      packages: [{ packageId: "acme/app", commit: first, state: "ready" }],
    };
    assertEquals(compareSystems(available, local)[0]?.change, "added");
    assertEquals(compareSystems(available, available), []);
    assertEquals(compareSystems(available, available, true).length, 1);
    assertEquals(
      changeKind(first, second, [{ commit: second, parents: null }]),
      "changed",
    );
    assertEquals(
      changeKind(first, second, [{ commit: first, parents: [] }, {
        commit: second,
        parents: [],
      }]),
      "changed",
    );
    assertThrows(
      () => checkBaseline(list, available.packages),
      Error,
      "changed since review",
    );
    const originalOperation = fixture.operation;
    const entered = Promise.withResolvers<void>(),
      finish = Promise.withResolvers<void>();
    fixture.operation = async (operation, input) => {
      if (operation === "package.synchronize") {
        entered.resolve();
        await finish.promise;
      }
      return await originalOperation(operation, input);
    };
    const pending = executeRun(list);
    await entered.promise;
    try {
      await assertRejects(() => executeRun(list), Error, "UNIQUE");
      await removeConnection(source.id);
      assertEquals((await Connections.selectAll().execute()).length, 0);
      await assertRejects(() =>
        kernel.secrets.get(`deployments.peer.${source.id}`)
      );
    } finally {
      finish.resolve();
    }
    const completed = await inspectRun(await pending);
    assertEquals(completed.state, "succeeded");
    const nativeCalls = calls.length;
    await Runs.update({ state: "running", lockKey: "apply" }).where(
      Runs.id,
      "=",
      completed.id,
    ).execute();
    let observed: "active" | "unavailable" | "missing" = "active";
    (globalThis as unknown as Record<symbol, unknown>)[kernelInvokeSymbol] =
      ((operation, input) => {
        if (operation === "worker.invoke") {
          return Promise.resolve(
            observed === "active" ? { ok: true, output: true } : {
              ok: false,
              error: {
                code: observed === "missing"
                  ? "target_not_found"
                  : "unavailable",
                message: observed,
              },
            },
          );
        }
        return fixture.invoke(operation, input);
      }) satisfies KernelInvoke;
    await assertRejects(
      () => reconcileRun(completed.id),
      Error,
      "still running",
    );
    observed = "unavailable";
    await assertRejects(() => reconcileRun(completed.id), Error, "unavailable");
    assertEquals((await inspectRun(completed.id)).lockKey, "apply");
    observed = "missing";
    assertEquals((await reconcileRun(completed.id)).state, "interrupted");
    assertEquals(calls.length, nativeCalls);
    const large = parseList({
      ...list,
      id: crypto.randomUUID(),
      packages: Array.from(
        { length: 1000 },
        (_, index) => ({
          ...list.packages[0],
          packageId: `acme/${"p".repeat(150)}${index}`,
        }),
      ),
    });
    assertEquals(JSON.stringify(large).length > 128 * 1024, true);
    await saveList(large);
    let launched: Record<string, unknown> | undefined;
    fixture.operation = (name, input) => {
      assertEquals(name, "program.run");
      launched = input;
      return Promise.reject(new Error("Stopped at launch boundary"));
    };
    await assertRejects(
      () => applyList(large, large.id),
      Error,
      "Stopped at launch boundary",
    );
    assertEquals(launched?.arguments, [{ listId: large.id }]);
    assertEquals(launched?.timeoutMs, 600000);
  } finally {
    globalThis.fetch = originalFetch;
    fixture.close();
  }
});
