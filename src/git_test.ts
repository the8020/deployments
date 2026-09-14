import { assertEquals, assertRejects } from "@std/assert";
import { references, serveGit } from "./git.ts";

async function git(cwd: string, ...args: string[]) {
  const result = await new Deno.Command("git", {
    cwd,
    args,
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (!result.success) throw new Error(new TextDecoder().decode(result.stderr));
  return new TextDecoder().decode(result.stdout).trim();
}

Deno.test("development HTTP Git clones loose/packed history and detached HEAD without exposing metadata", async () => {
  const root = await Deno.makeTempDir();
  const server = Deno.serve(
    { hostname: "127.0.0.1", port: 0, onListen() {} },
    (request) =>
      serveGit(root + "/.git", new URL(request.url).pathname.slice(1)),
  );
  try {
    await git(root, "init", "-b", "main");
    await git(root, "config", "user.name", "Deployment Test");
    await git(root, "config", "user.email", "deploy@example.invalid");
    await Deno.writeTextFile(
      root + "/package.toml",
      "schema = 1\ndescription = 'Test'\n",
    );
    await git(root, "add", ".");
    await git(root, "commit", "-m", "Initial");
    const before = await git(root, "rev-parse", "HEAD");
    await git(root, "tag", "-a", "v1", "-m", "First version");
    await Deno.writeTextFile(root + "/message.txt", "new version");
    await git(root, "add", ".");
    await git(root, "commit", "-m", "Second");
    const after = await git(root, "rev-parse", "HEAD");
    await git(root, "checkout", "-b", "upstream-feature");
    await Deno.writeTextFile(root + "/feature.txt", "Fetched upstream branch");
    await git(root, "add", ".");
    await git(root, "commit", "-m", "Upstream branch");
    const upstream = await git(root, "rev-parse", "HEAD");
    await git(root, "update-ref", "refs/remotes/origin/feature", upstream);
    await git(root, "checkout", "main");
    await git(root, "branch", "-D", "upstream-feature");
    const url = `http://127.0.0.1:${server.addr.port}`;
    await git(root, "clone", url, "loose-clone");
    assertEquals(await git(root + "/loose-clone", "rev-parse", "HEAD"), after);
    assertEquals(
      await git(root + "/loose-clone", "show", `${upstream}:feature.txt`),
      "Fetched upstream branch",
    );
    await git(root, "pack-refs", "--all");
    await git(root, "repack", "-ad");
    await git(root, "checkout", "--detach", before);
    await git(root, "clone", url, "packed-clone");
    assertEquals(
      await git(root + "/packed-clone", "rev-parse", "HEAD"),
      before,
    );
    assertEquals(
      await git(root + "/packed-clone", "rev-parse", "v1^{commit}"),
      before,
    );
    for (
      const path of [
        "config",
        "logs/HEAD",
        "../package.toml",
        "objects/info/alternates",
      ]
    ) {
      assertEquals((await serveGit(root + "/.git", path)).status, 404);
    }
    await Deno.symlink(
      root + "/package.toml",
      root + "/.git/refs/heads/escape",
    );
    await assertRejects(() => references(root + "/.git"), Error, "links");
    await Deno.remove(root + "/.git", { recursive: true });
    const missing = await fetch(`${url}/info/refs`);
    await missing.body?.cancel();
    assertEquals(missing.status, 404);
  } finally {
    await server.shutdown();
    await Deno.remove(root, { recursive: true });
  }
});
