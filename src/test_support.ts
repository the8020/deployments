import { DatabaseSync } from "node:sqlite";
import {
  kernelDatabaseBackendSymbol,
  type KernelInvoke,
  kernelInvokeSymbol,
} from "@the8020/kernel";
import { installContextProvider } from "../../kernel/defaults/config/runtime/deno/context/runtime.ts";
import { createIndexSQL, createTableSQL } from "/p/the8020/db/internal/ddl.ts";
const globals = globalThis as unknown as Record<symbol, unknown>;
globals[kernelDatabaseBackendSymbol] = "sqlite";
const { descriptorOf } = await import("/p/the8020/db/mod.ts");
const tableModules = await Promise.all([
  import("../tables/connections.ts"),
  import("/p/the8020/secrets/tables/secrets.ts"),
  import("../tables/lists.ts"),
  import("../tables/runs.ts"),
  import("/p/the8020/system/tables/settings.ts"),
  import("/p/the8020/packages/tables/packages.ts"),
]);

export class DatabaseFixture {
  readonly database = new DatabaseSync(":memory:");
  readonly restore: () => void;
  operation: (
    name: string,
    input: Record<string, unknown>,
  ) => Promise<unknown> = (name) => {
    throw new Error(`Unexpected operation ${name}`);
  };
  constructor() {
    for (const module of tableModules) {
      const table = descriptorOf(module.default);
      this.database.exec(createTableSQL("sqlite", table));
      for (const index of table.indexes) {
        this.database.exec(createIndexSQL(table.table_id, index));
      }
    }
    this.restore = installContextProvider(() => ({
      type: "program",
      id: "the8020/deployments/apply",
      username: "system",
      userId: "user:system",
      authenticated: true,
      nodeId: "node-a",
      sandboxId: "sbx-0123456789",
      workerId: "wrk-0123456789",
      contextId: "ctx-0123456789",
      jobRunId: "job-0123456789",
    }));
    globals[kernelInvokeSymbol] = this.invoke;
  }
  close() {
    this.database.close();
    this.restore();
    delete globals[kernelInvokeSymbol];
  }
  readonly invoke: KernelInvoke = async (operation, args) => {
    if (operation.startsWith("database.transaction.")) {
      this.database.exec(
        operation.endsWith("begin")
          ? "BEGIN"
          : operation.endsWith("commit")
          ? "COMMIT"
          : "ROLLBACK",
      );
      return { transaction: "test" };
    }
    if (operation === "database.execute") {
      const statement = this.database.prepare(String(args.statement));
      const parameters = (args.parameters as unknown[]).map((value) => {
        if (typeof value === "boolean") return Number(value);
        if (value !== null && typeof value === "object") {
          const tag = value as { type: string; value: unknown };
          if (tag.type === "json") return JSON.stringify(tag.value);
          if (tag.type === "datetime") return String(tag.value);
          if (tag.type === "bigint") return BigInt(String(tag.value));
        }
        return value as string | number | null;
      });
      if (args.return_rows) {
        const rows = statement.all(...parameters),
          columns = statement.columns().map((column) => column.name);
        return {
          columns,
          rows: rows.map((row) => columns.map((column) => row[column])),
        };
      }
      const result = statement.run(...parameters);
      return {
        columns: [],
        rows: [],
        affected_rows: { type: "bigint", value: String(result.changes) },
      };
    }
    if (operation !== "runtime.operation") {
      throw new Error(`Unexpected bridge ${operation}`);
    }
    if (
      args.operation === "crypto.encrypt" || args.operation === "crypto.decrypt"
    ) {
      const input = args.input as {
        data: string;
        encrypted: string;
        associated_data: string;
      };
      const key = await crypto.subtle.importKey(
        "raw",
        new Uint8Array(32),
        "AES-GCM",
        false,
        ["encrypt", "decrypt"],
      );
      const additionalData = Uint8Array.fromBase64(input.associated_data);
      if (args.operation === "crypto.encrypt") {
        const iv = crypto.getRandomValues(new Uint8Array(12));
        const encrypted = new Uint8Array(
          await crypto.subtle.encrypt(
            { name: "AES-GCM", iv, additionalData },
            key,
            Uint8Array.fromBase64(input.data),
          ),
        );
        return {
          success: true,
          result: {
            encrypted: "v1:" + new Uint8Array([...iv, ...encrypted]).toBase64(),
          },
        };
      }
      const bytes = Uint8Array.fromBase64(input.encrypted.slice(3));
      const data = new Uint8Array(
        await crypto.subtle.decrypt(
          { name: "AES-GCM", iv: bytes.slice(0, 12), additionalData },
          key,
          bytes.slice(12),
        ),
      );
      return { success: true, result: { data: data.toBase64() } };
    }
    return {
      success: true,
      result: await this.operation(
        String(args.operation),
        args.input as Record<string, unknown>,
      ),
    };
  };
}
