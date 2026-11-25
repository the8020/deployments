import { context } from "@the8020/context";
import { check } from "/p/the8020/auth/mod.ts";
import { localizedText as resolveMessage } from "/p/the8020/i18n/mod.ts";
import { msg as messageSymbol } from "/p/the8020/deployments/i18n/messages.ts";
import { defineService, HTTPError, z } from "/p/the8020/services/http.ts";
import {
  getSystemProfile,
  requireDevelopment,
} from "/p/the8020/system/profile.ts";
import { localSnapshot, readJSON, receiveList } from "../../src/peers.ts";
import { gitRoot, serveGit } from "../../src/git.ts";
import { localVersions } from "../../src/versions.ts";

const service = defineService();
service.use(async ({ meta }, next) => {
  if (!meta.auth.authenticated) return new Response(null, { status: 401 });
  if (
    context.username === "system" ||
    !await check("the8020.deployments.peer.access", "")
  ) return new Response(null, { status: 403 });
  return await next();
});
const packageParams = {
  params: z.object({ author: z.string(), repository: z.string() }),
};
service.get(
  "/identity",
  {},
  async () => Response.json(await getSystemProfile()),
);
service.get(
  "/snapshot",
  {},
  async ({ request }) =>
    Response.json(
      await localSnapshot(
        undefined,
        new URL(request.url).searchParams.get("subjects") === "1",
      ),
    ),
);
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
      error instanceof Error
        ? error.message
        : await resolveMessage(messageSymbol("errors.invalid_list")),
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
      return new Response(
        await resolveMessage(
          messageSymbol("errors.git_is_available_only_on_development_systems"),
        ),
        {
          status: 403,
        },
      );
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
