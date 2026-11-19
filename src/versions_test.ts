import { assertEquals, assertRejects } from "@std/assert";
import {
  defaultConfiguration,
  Localization,
  withLocalization,
} from "/p/the8020/i18n/mod.ts";
import {
  getSystemProfile,
  setSystemProfile,
} from "/p/the8020/system/profile.ts";
import czech from "../i18n/locales/cs.json" with { type: "json" };
import { DatabaseFixture } from "./test_support.ts";
import { developmentSource } from "./versions.ts";
import { request } from "./peers.ts";
import Connections from "../tables/connections.ts";

Deno.test("peer request timeout identifies the connected system", async () => {
  const timeout = AbortSignal.timeout, fetch = globalThis.fetch;
  try {
    AbortSignal.timeout = () => AbortSignal.abort();
    globalThis.fetch = (_url, init) => {
      init?.signal?.throwIfAborted();
      throw new Error("Expected an aborted request");
    };
    const peer = {
      url: "http://dev.example",
      username: "deployer",
      password: "pw",
    };
    await assertRejects(
      () => request(peer, "/identity"),
      Error,
      "Connection to http://dev.example timed out.",
    );
  } finally {
    AbortSignal.timeout = timeout;
    globalThis.fetch = fetch;
  }
});

Deno.test("development source refusal uses Czech before presenting a screen", async () => {
  const fixture = new DatabaseFixture();
  try {
    const profile = await getSystemProfile();
    await setSystemProfile({ name: "Test", role: "test" });
    await Connections.insert({
      ...profile,
      url: "http://test.example.invalid",
      username: "deployer",
    }).execute();
    const localization = new Localization(
      "cs",
      defaultConfiguration,
      (packageId, chain) => {
        assertEquals(packageId, "the8020/deployments");
        assertEquals(chain[0], "cs");
        return Promise.resolve({
          package: packageId,
          language: "cs",
          texts: czech.texts,
        });
      },
    );
    await withLocalization(localization, async () => {
      const error = await assertRejects(
        () => developmentSource(profile.id),
        Error,
      );
      assertEquals(error.message, "Zdrojem balíčků musí být vývojový systém.");
    });
  } finally {
    fixture.close();
  }
});
