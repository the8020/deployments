import { defineService, HTTPError, z } from "/p/the8020/services/http.ts";
import {
  getSystemProfile,
  requireDevelopment,
} from "/p/the8020/system/profile.ts";
import { localSnapshot, readJSON, receiveList } from "../../src/peers.ts";
import { gitRoot, serveGit } from "../../src/git.ts";
import { localVersions } from "../../src/versions.ts";

const service = defineService();
const packageParams = {
  params: z.object({ author: z.string(), repository: z.string() }),
};
service.get(
  "/identity",
  {},
  async () => Response.json(await getSystemProfile()),
);
service.get("/snapshot", {}, async () => Response.json(await localSnapshot()));
service.get(
  "/versions/:author/:repository",
  packageParams,
  async ({ params }) => {
    return Response.json(
      await localVersions(`${params.author}/${params.repository}`),
    );
  },
);
service.post("/lists", {}, async ({ request }) => {
  try {
    const value = await readJSON(new Response(request.body), 512 * 1024);
    return Response.json(await receiveList(value), { status: 202 });
  } catch (error) {
    throw new HTTPError(
      400,
      error instanceof Error ? error.message : "Invalid list",
    );
  }
});
service.get(
  "/git/:author/:repository/*",
  packageParams,
  async ({ request, params }) => {
    try {
      await requireDevelopment();
    } catch {
      return new Response("Git is available only on development systems.", {
        status: 403,
      });
    }
    const repository = String(params.repository);
    if (!repository.endsWith(".git")) {
      return new Response(null, {
        status: 404,
      });
    }
    const packageId = `${params.author}/${repository.slice(0, -4)}`;
    const path = new URL(request.url).pathname.split(`/${repository}/`).slice(1)
      .join(`/${repository}/`);
    try {
      return await serveGit(await gitRoot(packageId), path);
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
      return new Response(null, { status: 404 });
    }
  },
);
export default service;
