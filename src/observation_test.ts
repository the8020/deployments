import { assertEquals, assertRejects } from "@std/assert";
import { DatabaseFixture } from "./test_support.ts";
import Packages from "/p/the8020/packages/tables/packages.ts";
import { localSnapshot } from "./peers.ts";
import { compareSystems, comparisonChange } from "./comparison.ts";

Deno.test("comparison observes absent and empty source instead of catalog version labels", async () => {
  const fixture = new DatabaseFixture();
  const commit = "a".repeat(40);
  try {
    await Packages.insert({
      packageId: "acme/app",
      author: "acme",
      repository: "app",
      source: null,
      requestedCommit: commit,
      requestedTag: null,
      secretName: null,
      local: false,
      activeCommit: commit,
      state: "ready",
      error: null,
      revision: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    }).execute();
    let repository: Record<string, unknown> = { status: "ready", head: commit };
    fixture.operation = (operation) => {
      assertEquals(operation, "package.repository.inspect");
      return Promise.resolve({ repository });
    };
    const healthy = await localSnapshot();
    assertEquals(compareSystems(healthy, healthy), []);
    for (const state of ["desired", "failed"] as const) {
      await Packages.update({ state }).where(
        Packages.packageId,
        "=",
        "acme/app",
      ).execute();
      const incomplete = await localSnapshot();
      assertEquals(incomplete.packages[0]?.commit, commit);
      assertEquals(compareSystems(healthy, incomplete)[0]?.change, "changed");
      assertEquals(comparisonChange(incomplete.packages[0], commit), "changed");
    }
    await Packages.update({ state: "ready" }).where(
      Packages.packageId,
      "=",
      "acme/app",
    ).execute();
    for (const status of ["absent", "empty"]) {
      repository = { status };
      const incomplete = await localSnapshot();
      assertEquals(incomplete.packages[0]?.commit, null);
      assertEquals(compareSystems(healthy, incomplete)[0]?.change, "added");
    }
    for (
      const status of [
        "not-initialized",
        "invalid-git-metadata",
        "missing-initial-commit",
      ]
    ) {
      repository = { status };
      await assertRejects(localSnapshot, Error, status);
    }
    fixture.operation = () => Promise.reject(new Error("permission denied"));
    await assertRejects(localSnapshot, Error, "permission denied");
  } finally {
    fixture.close();
  }
});
