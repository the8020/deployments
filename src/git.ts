import { deploymentPackageId } from "../types.ts";

const hash = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const pack = /^pack-(?:[0-9a-f]{40}|[0-9a-f]{64})\.(?:pack|idx)$/;

/** Resolve every path beneath the package's actual .git directory. */
async function confined(root: string, path: string) {
  const actual = await Deno.realPath(`${root}/${path}`);
  if (!actual.startsWith(root + "/")) {
    throw new Error("Git path escapes its repository.");
  }
  return actual;
}

async function textFile(root: string, path: string) {
  const actual = await confined(root, path);
  using file = await Deno.open(actual);
  if ((await file.stat()).size > 2 * 1024 * 1024) {
    throw new Error("Git reference file is too large.");
  }
  return await new Response(file.readable).text();
}

export async function gitRoot(packageId: string) {
  deploymentPackageId.parse(packageId);
  const manifest = new URL(import.meta.resolve(`/p/${packageId}/package.toml`));
  const root = await Deno.realPath(new URL("./", manifest));
  const git = await Deno.realPath(`${root}/.git`);
  if (git !== root + "/.git" || !(await Deno.stat(git)).isDirectory) {
    throw new Error("Package Git metadata must be a contained directory.");
  }
  return git;
}

/** Git's standard dumb HTTP protocol needs only refs and object files. */
export async function references(root: string): Promise<Map<string, string>> {
  const refs = new Map<string, string>();
  try {
    let previous = "";
    for (const line of (await textFile(root, "packed-refs")).split("\n")) {
      const [id, name] = line.split(" ");
      if (id?.startsWith("^") && hash.test(id.slice(1)) && previous) {
        refs.set(previous + "^{}", id.slice(1));
      } else if (
        id && name && hash.test(id) &&
        /^refs\/(heads|tags|remotes)\//.test(name)
      ) {
        refs.set(name, id);
        previous = name;
      } else previous = "";
    }
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
  let visited = 0;
  async function walk(path: string, depth = 0): Promise<void> {
    if (depth > 20) throw new Error("Git references are nested too deeply.");
    let entries: AsyncIterable<Deno.DirEntry>;
    try {
      entries = Deno.readDir(await confined(root, path));
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) return;
      throw error;
    }
    for await (const entry of entries) {
      if (++visited > 20000) throw new Error("Too many Git references.");
      if (entry.isSymlink) {
        throw new Error("Git reference links are not supported.");
      }
      const name = `${path}/${entry.name}`;
      if (entry.isDirectory) await walk(name, depth + 1);
      else if (entry.isFile && !entry.name.endsWith(".lock")) {
        const id = (await textFile(root, name)).trim();
        if (name.startsWith("refs/remotes/") && id.startsWith("ref: ")) {
          continue;
        }
        if (!hash.test(id)) throw new Error("Invalid Git reference.");
        refs.set(name, id);
        refs.delete(name + "^{}");
      }
    }
  }
  await walk("refs/heads");
  await walk("refs/tags");
  await walk("refs/remotes");
  for (const [name, id] of refs) {
    if (!name.startsWith("refs/remotes/")) continue;
    refs.delete(name);
    refs.set(`refs/heads/deployment-${id}`, id);
  }
  const head = (await textFile(root, "HEAD")).trim();
  const current = head.startsWith("ref: ") ? refs.get(head.slice(5)) : head;
  if (!current || !hash.test(current)) {
    throw new Error("Package has no committed HEAD.");
  }
  // Detached activated commits must remain discoverable by ordinary clone.
  refs.set("refs/heads/deployment", current);
  return refs;
}

export async function serveGit(root: string, path: string): Promise<Response> {
  const headers = {
    "Cache-Control": "no-cache",
    "Content-Type": "text/plain; charset=utf-8",
  };
  try {
    if (path === "HEAD") {
      return new Response("ref: refs/heads/deployment\n", { headers });
    }
    if (path === "info/refs") {
      const refs = await references(root);
      return new Response(
        [...refs].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
          .map(([name, id]) => `${id}\t${name}\n`).join(""),
        { headers },
      );
    }
    if (path === "objects/info/packs") {
      const names: string[] = [];
      for await (
        const entry of Deno.readDir(await confined(root, "objects/pack"))
      ) {
        if (
          entry.isFile && pack.test(entry.name) && entry.name.endsWith(".pack")
        ) names.push(entry.name);
        if (names.length > 10000) throw new Error("Too many Git packs.");
      }
      return new Response(
        names.sort().map((name) => `P ${name}\n`).join("") + "\n",
        { headers },
      );
    }
    if (
      !/^objects\/[0-9a-f]{2}\/(?:[0-9a-f]{38}|[0-9a-f]{62})$/.test(path) &&
      !(path.startsWith("objects/pack/") && pack.test(path.slice(13)))
    ) {
      return new Response("Not found", { status: 404 });
    }
    const file = await Deno.open(await confined(root, path));
    if (!(await file.stat()).isFile) {
      file.close();
      return new Response(null, { status: 404 });
    }
    return new Response(file.readable, {
      headers: { "Content-Type": "application/octet-stream" },
    });
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      return new Response("Not found", { status: 404 });
    }
    throw error;
  }
}
