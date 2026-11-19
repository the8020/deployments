import { assertEquals, assertRejects } from "@std/assert";
import { DatabaseFixture } from "./test_support.ts";
import Nodes from "/p/the8020/system/tables/nodes.ts";
import Packages from "/p/the8020/packages/tables/packages.ts";
import NodePackages from "/p/the8020/packages/tables/node_packages.ts";
import { packageDifferences } from "/p/the8020/packages/src/node-sync.ts";
import { syncPackageOnNode } from "./package-change.ts";
import Runs from "../tables/runs.ts";

Deno.test("sync compares enabled nodes and applies only the reviewed checkout", async () => {
  const fixture = new DatabaseFixture(),
    old = "a".repeat(40),
    wanted = "b".repeat(40);
  try {
    for (const node of ["node-b", "offline"]) {
      await Nodes.insert({
        id: node,
        url: "http://test",
        recipientAddress: "test",
        recipientPort: 1,
        enabled: node !== "offline",
      }).execute();
    }
    for (const name of ["one", "retired"]) {
      await Packages.insert({
        packageId: "acme/" + name,
        author: "acme",
        repository: name,
        source: "http://upstream/acme/" + name,
        requestedCommit: wanted,
        activeCommit: wanted,
        state: name === "one" ? "ready" : "retired",
      }).execute();
    }
    await NodePackages.insert({
      nodeId: "node-a",
      packageId: "acme/one",
      activeCommit: old,
      ready: true,
    }).execute();
    await NodePackages.insert({
      nodeId: "node-b",
      packageId: "acme/retired",
      activeCommit: old,
      ready: true,
    }).execute();
    const rows = await packageDifferences();
    assertEquals(rows, [
      { node: "node-a", packageId: "acme/one", before: old, desired: wanted },
      { node: "node-b", packageId: "acme/one", before: "", desired: wanted },
      { node: "node-b", packageId: "acme/retired", before: old, desired: "" },
    ]);
    const calls: string[] = [];
    fixture.operation = async (name, input) => {
      if (name !== "package.node.sync") throw new Error(name);
      if (input.check_only) {
        if (input.node === "offline") throw new Error("node offline");
        return;
      }
      calls.push(String(input.node));
      await NodePackages.insert({
        nodeId: String(input.node),
        packageId: "acme/one",
        activeCommit: wanted,
        ready: true,
      }).execute();
    };
    await assertRejects(
      () => syncPackageOnNode({ ...rows[1]!, node: "offline" }),
      Error,
      "node offline",
    );
    assertEquals(await Runs.selectAll().execute(), []);
    await syncPackageOnNode(rows[1]!);
    assertEquals(calls, ["node-b"]);
    const run = await Runs.selectAll().executeTakeFirstOrThrow();
    assertEquals([
      run.syncNodeId,
      run.state,
      run.packages[0]?.before,
      run.packages[0]?.after,
    ], ["node-b", "succeeded", null, wanted]);
    await NodePackages.update({ ready: false }).where(
      NodePackages.nodeId,
      "=",
      "node-b",
    ).where(NodePackages.packageId, "=", "acme/one").execute();
    assertEquals((await packageDifferences())[1], {
      node: "node-b",
      packageId: "acme/one",
      before: wanted,
      desired: wanted,
    });
  } finally {
    fixture.close();
  }
});

Deno.test("syncing a reviewed legacy tag on two nodes pins it once", async () => {
  const fixture = new DatabaseFixture(),
    wanted = "c".repeat(40),
    packageId = "acme/tagged";
  try {
    await Packages.insert({
      packageId,
      author: "acme",
      repository: "tagged",
      source: "http://upstream/acme/tagged.git",
      requestedTag: "stable",
    }).execute();
    await Nodes.insert({
      id: "node-b",
      url: "http://test",
      recipientAddress: "test",
      recipientPort: 1,
      enabled: true,
    }).execute();
    const rows = await packageDifferences();
    assertEquals(rows.map((row) => row.desired), ["tag:stable", "tag:stable"]);
    fixture.operation = async (name, input) => {
      if (name === "package.transport.resolve") {
        assertEquals(input.commit, "tag:stable");
        return wanted;
      }
      if (name !== "package.node.sync") throw new Error(name);
      if (input.check_only) return;
      await NodePackages.insert({
        nodeId: String(input.node),
        packageId,
        activeCommit: wanted,
      }).execute();
    };
    for (const row of rows) await syncPackageOnNode(row);
    const entry = await Packages.selectAll().executeTakeFirstOrThrow();
    assertEquals([entry.requestedCommit, entry.requestedTag, entry.revision], [
      wanted,
      null,
      1,
    ]);
    assertEquals(await packageDifferences(), []);
    await assertRejects(
      () => syncPackageOnNode({ ...rows[0]!, desired: "e".repeat(40) }),
      Error,
      "changed since review",
    );
  } finally {
    fixture.close();
  }
});
