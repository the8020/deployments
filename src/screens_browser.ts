import { kernel } from "@the8020/kernel";
import { assert, assertEquals } from "@std/assert";
import { DatabaseFixture } from "./test_support.ts";
import {
  getSystemProfile,
  setSystemProfile,
} from "/p/the8020/system/profile.ts";
const { default: Connections } = await import("../tables/connections.ts");
const { default: Packages } = await import(
  "/p/the8020/packages/tables/packages.ts"
);
const { default: Runs } = await import("../tables/runs.ts");
const { deployments } = await import("./screens.ts");
const { executeRequest } = await import("./runs.ts");

interface Browser {
  evaluate<T>(expression: string): Promise<T>;
  command(method: string, params?: Record<string, unknown>): Promise<unknown>;
}

export default async function fixture() {
  const database = new DatabaseFixture();
  const originalFetch = globalThis.fetch;
  const local = await getSystemProfile();
  await setSystemProfile({ name: "Acceptance", role: "test" });
  const source = {
    id: crypto.randomUUID(),
    name: "Development",
    role: "development" as const,
  };
  const first = "a".repeat(40), second = "b".repeat(40);
  await Connections.insert({
    ...source,
    url: "https://development.example.invalid",
    username: "deployer",
  }).execute();
  await kernel.secrets.set({
    name: `deployments.peer.${source.id}`,
    value: "browser-test-password",
  });
  for (const packageId of ["acme/app", "acme/unchanged"]) {
    await Packages.insert({
      packageId,
      author: "acme",
      repository: packageId.split("/")[1]!,
      source: null,
      requestedCommit: null,
      requestedTag: null,
      secretName: null,
      local: false,
      activeCommit: first,
      state: "ready",
      error: null,
      revision: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    }).execute();
  }
  globalThis.fetch = (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.hostname !== "development.example.invalid") {
      return originalFetch(input, init);
    }
    if (url.pathname.endsWith("/snapshot")) {
      return Promise.resolve(Response.json({
        system: source,
        packages: [
          { packageId: "acme/app", commit: second, state: "ready" },
          { packageId: "acme/unchanged", commit: first, state: "ready" },
        ],
      }));
    }
    if (url.pathname.includes("/versions/")) {
      return Promise.resolve(Response.json({
        package_id: "acme/app",
        current_commit: second,
        versions: [second, first].map((commit, i) => ({
          commit,
          short_commit: commit.slice(0, 8),
          authored_at: "2026-09-13T00:00:00Z",
          author: "Test",
          subject: i ? "First release" : "Second release",
          parents: i ? [] : [first],
          tags: [i ? "v1" : "v2"],
          current: !i,
          selected: false,
        })),
      }));
    }
    return Promise.resolve(Response.json(source));
  };
  database.operation = async (operation, input) => {
    if (operation === "package.repository.inspect") {
      const row = await Packages.selectAll().where(
        Packages.packageId,
        "=",
        String(input.package_id),
      ).executeTakeFirstOrThrow();
      return { repository: { head: row.activeCommit } };
    }
    if (operation === "program.run") {
      return {
        state: "succeeded",
        result: await executeRequest((input.arguments as unknown[])[0]),
      };
    }
    if (operation === "package.index.set") {
      await Packages.update({ requestedCommit: String(input.commit) }).where(
        Packages.packageId,
        "=",
        `${input.author}/${input.repository}`,
      ).execute();
      return { package: input };
    }
    if (operation === "package.synchronize") {
      const packageId = String(input.packages);
      const row = await Packages.selectAll().where(
        Packages.packageId,
        "=",
        packageId,
      ).executeTakeFirstOrThrow();
      await Packages.update({ activeCommit: row.requestedCommit }).where(
        Packages.packageId,
        "=",
        packageId,
      ).execute();
      return {
        packages: [{
          package_id: packageId,
          commit: row.requestedCommit,
          success: true,
        }],
      };
    }
    throw new Error(`Unexpected ${operation}`);
  };
  return {
    run: async () => {
      await deployments();
      await deployments("acme/app");
    },
    serve: () => Promise.resolve(undefined),
    close() {
      globalThis.fetch = originalFetch;
      database.close();
      return Promise.resolve();
    },
    async verify(page: Browser) {
      const visible =
        `(e) => !!e && e.getBoundingClientRect().width > 0 && e.getBoundingClientRect().height > 0`;
      async function wait(expression: string, label: string) {
        const until = Date.now() + 10000;
        while (!await page.evaluate<boolean>(expression)) {
          if (Date.now() > until) throw new Error(`Timed out: ${label}`);
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
      }
      async function click(action: string) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        const selector = `[data-element-id="${action}"]`;
        await wait(
          `Array.from(document.querySelectorAll(${
            JSON.stringify(selector)
          })).some(e=>(${visible})(e)&&!e.disabled)`,
          action,
        );
        await page.evaluate(
          `{ const e=Array.from(document.querySelectorAll(${
            JSON.stringify(selector)
          })).find(e=>(${visible})(e)&&!e.disabled); (e.matches('button')?e:e.querySelector('button')??e).click(); }`,
        );
      }
      async function screen(id: string) {
        const selector = id === "deployment-json"
          ? 'textarea[data-bind="json"]'
          : `[data-element-id="${
            ({
              deployments: "new",
              "deployment-systems": "connect",
              "deployment-new": "compare",
              "deployment-compare": "review",
              "deployment-review": "apply",
              "deployment-confirm": "confirm",
              "deployment-run": "rollback",
              "deployment-package": "choose",
            } as Record<string, string>)[id]
          }"]`;
        await wait(
          `Array.from(document.querySelectorAll(${
            JSON.stringify(selector)
          })).some(${visible}) && !document.querySelector('#screen-back')?.disabled`,
          id,
        );
      }
      await screen("deployments");
      await click("systems");
      await screen("deployment-systems");
      assertEquals(
        await page.evaluate<string>(
          `Array.from(document.querySelectorAll('input[data-bind="password"]')).find(${visible}).type`,
        ),
        "password",
      );
      await page.evaluate(
        `Array.from(document.querySelectorAll('tbody tr[data-row-index]')).find(${visible}).click()`,
      );
      await wait(
        `Array.from(document.querySelectorAll('input[data-bind="username"]')).some(e=>(${visible})(e)&&e.value==="deployer")`,
        "selected connection",
      );
      assertEquals(
        await page.evaluate<string>(
          `Array.from(document.querySelectorAll('input[data-bind="password"]')).find(${visible}).value`,
        ),
        "",
      );
      await page.evaluate(
        `{const e=Array.from(document.querySelectorAll('input[data-bind="password"]')).find(${visible});e.value="browser-test-password";e.dispatchEvent(new Event('input',{bubbles:true}));}`,
      );
      await click("connect");
      await wait(
        `Array.from(document.querySelectorAll('input[data-bind="password"]')).some(e=>(${visible})(e)&&e.value==="")`,
        "password cleared after save",
      );
      await page.evaluate(`document.querySelector('#screen-back').click()`);
      await screen("deployments");
      await click("new");
      await screen("deployment-new");
      await page.evaluate(
        `{const e=Array.from(document.querySelectorAll('[data-bind="from"]')).find(${visible}); e.value=${
          JSON.stringify(source.id)
        };e.dispatchEvent(new Event('input',{bubbles:true}));}`,
      );
      await click("compare");
      await screen("deployment-compare");
      const rowCount = () =>
        page.evaluate<number>(
          `Array.from(document.querySelectorAll('tbody tr[data-row-index]')).filter(${visible}).length`,
        );
      assertEquals(await rowCount(), 1);
      await page.evaluate(
        `Array.from(document.querySelectorAll('tbody .data-list-selection input')).find(${visible}).click()`,
      );
      await click("toggle");
      await screen("deployment-compare");
      assertEquals(await rowCount(), 2);
      await wait(
        `Array.from(document.querySelectorAll('.data-list-page-summary')).some(e=>(${visible})(e)&&e.textContent.includes('1 of 2 selected'))`,
        "retained selection",
      );
      await click("review");
      await screen("deployment-review");
      await click("json");
      await screen("deployment-json");
      const json = await page.evaluate<string>(
        `Array.from(document.querySelectorAll('textarea')).find(${visible}).value`,
      );
      assertEquals(JSON.parse(json).targetSystemId, local.id);
      await page.evaluate(`document.querySelector('#screen-back').click()`);
      await screen("deployment-review");
      await click("apply");
      await screen("deployment-confirm");
      await click("confirm");
      await screen("deployment-run");
      const applied = await Runs.selectAll().executeTakeFirstOrThrow();
      assertEquals(applied.state, "succeeded");
      assertEquals(applied.packages[0]?.after, second);
      assert(applied.listId);
      await click("rollback");
      await screen("deployment-confirm");
      await click("confirm");
      await screen("deployment-run");
      const rolledBack = await Runs.selectAll().where(
        Runs.rollbackOf,
        "=",
        applied.id,
      ).executeTakeFirstOrThrow();
      assertEquals(rolledBack.packages[0]?.after, first);
      for (
        const parent of [
          "deployment-run",
          "deployment-review",
          "deployment-compare",
          "deployment-new",
          "deployments",
          "deployment-new",
        ]
      ) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        await page.evaluate(`document.querySelector('#screen-back').click()`);
        await screen(parent);
      }
      await click("compare");
      await screen("deployment-compare");
      await page.evaluate(
        `Array.from(document.querySelectorAll('tbody tr[data-row-index]')).find(${visible}).click()`,
      );
      await screen("deployment-package");
      assertEquals(await rowCount(), 2);
      await page.evaluate(
        `Array.from(document.querySelectorAll('tbody tr[data-row-index]')).find(${visible}).click()`,
      );
      await click("choose");
      await screen("deployment-compare");
      await click("review");
      await screen("deployment-review");
      await click("apply");
      await screen("deployment-confirm");
      await click("confirm");
      await screen("deployment-run");
      const adhoc = await Runs.selectAll().where(Runs.listId, "is", null).where(
        Runs.rollbackOf,
        "is",
        null,
      ).executeTakeFirstOrThrow();
      assertEquals(adhoc.state, "succeeded");
      assertEquals(adhoc.packages[0]?.after, second);
      await page.command("Emulation.setDeviceMetricsOverride", {
        width: 390,
        height: 844,
        deviceScaleFactor: 1,
        mobile: true,
      });
      assert(
        await page.evaluate<boolean>(
          `document.documentElement.scrollWidth<=window.innerWidth+1`,
        ),
      );
    },
  };
}
