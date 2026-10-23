import { assertEquals } from "@std/assert";
import { readProgramManifest } from "/p/the8020/packages/programs.ts";

// One invalid manifest stops every catalog that lists this package's programs.
Deno.test("every program manifest passes the platform manifest contract", async () => {
  const root = new URL("../programs/", import.meta.url);
  const names: string[] = [];
  for await (const entry of Deno.readDir(root)) {
    if (!entry.isDirectory) continue;
    await readProgramManifest(new URL(`${entry.name}/program.toml`, root));
    names.push(entry.name);
  }
  assertEquals(names.sort(), ["apply", "connect", "continue", "deployments"]);
});
