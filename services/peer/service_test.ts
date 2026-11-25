import { assertEquals } from "@std/assert";
import { newId } from "@the8020/kernel";
import { DatabaseFixture } from "../../src/test_support.ts";

const { assignRole } = await import("/p/the8020/auth/src/admin.ts");
const { indexRoles } = await import("/p/the8020/auth/src/role_declarations.ts");
const { default: Roles } = await import("/p/the8020/auth/tables/roles.ts");
const { getSystemProfile, setSystemProfile } = await import(
  "/p/the8020/system/profile.ts"
);
const { default: Users } = await import("/p/the8020/users/tables/users.ts");
const { default: Connections } = await import("../../tables/connections.ts");
const { default: Lists } = await import("../../tables/lists.ts");
const { default: Runs } = await import("../../tables/runs.ts");
const { default: service } = await import("./service.ts");

Deno.test("peer routes require an explicit grant after indexing an existing instance", async () => {
  const root = await Deno.makeTempDir({ prefix: "deployments-peer-" });
  const fixture = new DatabaseFixture();
  const packageId = "the8020/deployments";
  const baseRole = "the8020.users.user";
  const peerRole = "the8020.deployments.peer";
  const base = `/${packageId}/peer`;
  const git = "/git/acme/fixture.git";
  const send = (
    path: string,
    method = "GET",
    body?: string,
    authenticated = true,
  ) => {
    const user = {
      userId: `user:${fixture.username}`,
      username: fixture.username,
    };
    return service.fetch(
      new Request(`http://localhost${path}`, { method, body }),
      {
        signal: new AbortController().signal,
        meta: {
          contextId: "ctx-0123456789",
          serviceId: `${packageId}/peer`,
          canonicalBasePath: base,
          originalUrl: `http://localhost${base}${path}`,
          serviceGeneration: 1,
          user,
          auth: authenticated ? { authenticated, ...user } : { authenticated },
          client: { ipAddress: "127.0.0.1", networkScope: "loopback" },
          execution: {
            nodeId: "node-a",
            sandboxId: "sbx-0123456789",
            workerId: "wrk-0123456789",
          },
        },
      },
    );
  };
  try {
    await setSystemProfile({ name: "Peer fixture", role: "development" });
    const profile = await getSystemProfile();
    const sourceSystemId = newId("sys");
    await Connections.insert({
      id: sourceSystemId,
      name: "Fixture source",
      role: "development",
      url: "http://source.invalid",
      username: "peer",
    }).execute();
    const proposal = {
      schema: 1,
      id: crypto.randomUUID(),
      name: "Fixture proposal",
      targetSystemId: profile.id,
      sourceSystemId,
      packages: [{
        packageId: "acme/fixture",
        before: null,
        target: { commit: "a".repeat(40), tag: null },
      }],
    };
    await Roles.insert({ name: baseRole }).execute();
    for (
      const [username, technical] of [["ordinary", false], [
        "integration",
        true,
      ], ["peer", true]] as const
    ) {
      await Users.insert({ username, technical, language: null }).execute();
      await assignRole(username, baseRole, true);
    }
    const declarations = `${root}/${packageId}/declarations`;
    await Deno.mkdir(declarations, { recursive: true });
    for (const name of ["auth.toml", "auth-roles.toml"]) {
      await Deno.copyFile(
        new URL(`../../declarations/${name}`, import.meta.url),
        `${declarations}/${name}`,
      );
    }
    const packageCommit = "b".repeat(40);
    const state = { packages: {} };
    await indexRoles(state, {
      packages: [{
        package_id: packageId,
        package_commit: packageCommit,
        active: true,
      }],
    }, new URL(`file://${root}/`));
    assertEquals(state.packages, {});
    const role = await Roles.selectAll().where(Roles.name, "=", peerRole)
      .executeTakeFirstOrThrow();
    assertEquals([role.managed, role.managedCommit], [
      packageId,
      packageCommit,
    ]);
    await assignRole("peer", peerRole, true);
    for (
      const [username, authenticated, status] of [
        ["system", false, 401],
        ["system", true, 403],
        ["ordinary", true, 403],
        ["integration", true, 403],
      ] as const
    ) {
      fixture.username = username;
      for (
        const [path, method, body] of [
          ["/identity", "GET"],
          ["/snapshot?subjects=1", "GET"],
          ["/versions/acme/fixture", "GET"],
          [`${git}/info/refs?service=git-upload-pack`, "GET"],
          [`${git}/HEAD`, "HEAD"],
          [`${git}/objects/aa/${"a".repeat(38)}`, "GET"],
          ["/lists", "POST", JSON.stringify(proposal)],
        ] as const
      ) {
        const response = await send(path, method, body, authenticated);
        assertEquals(
          [response.status, await response.text()],
          [status, ""],
          path,
        );
      }
      const rpc = await send(
        `${git}/git-upload-pack`,
        "POST",
        "",
        authenticated,
      );
      assertEquals(rpc.status, 404);
      await rpc.body?.cancel();
    }
    assertEquals(await Lists.selectAll().execute(), []);
    assertEquals(await Runs.selectAll().execute(), []);
    fixture.username = "peer";
    assertEquals(await (await send("/identity")).json(), profile);
    assertEquals((await (await send("/snapshot")).json()).system, profile);
    const versions = { package_id: "acme/fixture", versions: [] };
    fixture.operation = (name, input) => {
      assertEquals([name, input.package_id], [
        "package.version.cached",
        "acme/fixture",
      ]);
      return Promise.resolve({ package: versions });
    };
    assertEquals(await (await send("/versions/acme/fixture")).json(), versions);
    const received = await send("/lists", "POST", JSON.stringify(proposal));
    assertEquals([received.status, await received.json()], [202, {
      id: proposal.id,
    }]);
    assertEquals(
      (await Lists.selectAll().execute()).map((row) => row.received),
      [true],
    );
    assertEquals(await Runs.selectAll().execute(), []);
  } finally {
    fixture.close();
    await Deno.remove(root, { recursive: true });
  }
});
