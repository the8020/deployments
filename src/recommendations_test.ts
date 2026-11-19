import { assertEquals, assertRejects } from "@std/assert";
import { DatabaseFixture } from "./test_support.ts";
import { newId } from "@the8020/kernel";
import { setSystemProfile } from "/p/the8020/system/profile.ts";
import { setSecret } from "/p/the8020/secrets/mod.ts";
import Packages from "/p/the8020/packages/tables/packages.ts";
import { packages } from "/p/the8020/packages/src/admin.ts";
import Connections from "../tables/connections.ts";
import { passwordName } from "./peers.ts";
import { gitURL } from "./versions.ts";
import { recommendedSources } from "./recommendations.ts";

const item = {
  id: "acme/app",
  source: "https://github.com/acme/app.git",
  version: "0.10.1",
};

Deno.test("recommendations and package lookups use the connected development Git on non-development systems", async () => {
  const fixture = new DatabaseFixture(), originalFetch = globalThis.fetch;
  const peer = {
    id: newId("sys"),
    name: "Development",
    role: "development" as const,
    url: "http://dev.invalid",
    username: "deployer",
  };
  let remoteRole = "development", fail = false, fetched = 0;
  try {
    globalThis.fetch = (url, init) => {
      assertEquals(new URL(String(url)).origin, peer.url);
      assertEquals(
        new Headers(init?.headers).get("Authorization"),
        `Basic ${
          new TextEncoder().encode("deployer:private-password").toBase64()
        }`,
      );
      fetched++;
      return Promise.resolve(
        fail ? new Response(null, { status: 503 }) : Response.json(
          String(url).includes("/versions/")
            ? { package_id: item.id, versions: [] }
            : {
              id: peer.id,
              name: peer.name,
              role: remoteRole,
            },
        ),
      );
    };
    assertEquals(await recommendedSources([item]), [{
      package_id: item.id,
      source: item.source,
    }]);
    assertEquals(fetched, 0);
    await setSystemProfile({ name: "Test", role: "test" });
    await assertRejects(
      () => recommendedSources([item]),
      Error,
      "development source",
    );
    await Connections.insert(peer).execute();
    await setSecret({ name: passwordName(peer.id), value: "private-password" });
    const expected = [{
      package_id: item.id,
      source: gitURL(peer.url, item.id),
      secret: passwordName(peer.id),
      username: peer.username,
    }];
    fixture.operation = (name, input) => {
      assertEquals(name, "package.transport.inspect");
      assertEquals(input.source, gitURL(peer.url, item.id));
      assertEquals(input.transport_secret, passwordName(peer.id));
      return Promise.resolve({
        source: { package_id: item.id, source: input.source, references: [] },
      });
    };
    for (const role of ["test", "production"] as const) {
      await setSystemProfile({ name: role, role });
      assertEquals(await recommendedSources([item]), expected);
      assertEquals(
        (await packages.source.inspect(item.id)).source,
        expected[0]!.source,
      );
      assertEquals(
        (await packages.source.inspect(item.source)).source,
        item.source,
      );
    }
    await Connections.insert({
      ...peer,
      id: newId("sys"),
      url: "http://another.invalid",
    }).execute();
    await assertRejects(
      () => recommendedSources([item]),
      Error,
      "one development connection",
    );
    await Packages.insert({
      packageId: item.id,
      author: "acme",
      repository: "app",
      source: gitURL(peer.url, item.id),
      local: false,
    }).execute();
    assertEquals(await recommendedSources([item]), expected);
    assertEquals(JSON.stringify(expected).includes("private-password"), false);
    remoteRole = "test";
    await assertRejects(() => recommendedSources([item]), Error, "development");
    remoteRole = "development";
    fail = true;
    await assertRejects(() => recommendedSources([item]), Error, "503");
    fail = false;
    await Connections.delete().where(Connections.id, "=", peer.id).execute();
    await assertRejects(() => recommendedSources([item]), Error, "Reconnect");
  } finally {
    globalThis.fetch = originalFetch;
    fixture.close();
  }
});

Deno.test("recommendation routing preserves local and custom packages without fetching", async () => {
  const fixture = new DatabaseFixture(), originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = () => {
      throw new Error("Unexpected fetch");
    };
    await setSystemProfile({ name: "Production", role: "production" });
    await Packages.insert({
      packageId: item.id,
      author: "acme",
      repository: "app",
      source: item.source,
      local: true,
    }).execute();
    assertEquals(await recommendedSources([item]), [{
      package_id: item.id,
      skip: "local package",
    }]);
    await Packages.update({
      local: false,
      source: "https://custom.invalid/acme/app.git",
    }).execute();
    assertEquals(await recommendedSources([item]), [{
      package_id: item.id,
      skip: "custom source",
    }]);
    assertEquals(await recommendedSources([]), []);
  } finally {
    globalThis.fetch = originalFetch;
    fixture.close();
  }
});
