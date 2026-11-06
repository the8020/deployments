import { assertEquals } from "@std/assert";
import { DatabaseFixture } from "./test_support.ts";
import { newId } from "@the8020/kernel";
import { getSystemProfile } from "/p/the8020/system/profile.ts";
import Connections from "../tables/connections.ts";
import secretUsages from "../programs/secret-usages/program.ts";

Deno.test("secret usages report connected systems by their password secret", async () => {
  const fixture = new DatabaseFixture();
  try {
    const local = await getSystemProfile();
    const peer = { ...local, id: newId("sys"), name: "SIKO (test)" };
    await Connections.insert({
      ...peer,
      url: "https://siko.invalid",
      username: "admin",
    }).execute();
    const name = `deployments.peer.${peer.id}`;
    assertEquals(
      await secretUsages([name, `deployments.peer.${newId("sys")}`, "github"]),
      [{
        secret: name,
        title: "Connected system SIKO (test)",
        detail: "https://siko.invalid",
        open: { program: "the8020/deployments/deployments", arguments: [] },
      }],
    );
    assertEquals(await secretUsages(["github"]), []);
  } finally {
    fixture.close();
  }
});
