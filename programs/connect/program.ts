import { kernel } from "@the8020/kernel";
import { requiredCommandArgument } from "/p/the8020/packages/commands.ts";
import { saveConnection } from "../../src/peers.ts";

export default async (...args: string[]) => ({
  connection: await saveConnection(
    requiredCommandArgument(args, 0, "system URL"),
    requiredCommandArgument(args, 1, "remote username"),
    kernel.execution.secret("password"),
  ),
});
