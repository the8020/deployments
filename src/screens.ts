import { text as localizedText } from "/p/the8020/i18n/mod.ts";
import { msg } from "/p/the8020/deployments/i18n/messages.ts";
import { requirePermission } from "/p/the8020/auth/mod.ts";
import { choiceHelp } from "/p/the8020/db/fields.ts";
import { sourceInfo } from "/p/the8020/packages/types/source.ts";
import {
  getSystemProfile,
  setSystemProfile,
  systemProfile,
} from "/p/the8020/system/profile.ts";
import {
  BACK_EVENT,
  callScreen,
  confirmAction,
  currentBrowser,
  field,
  invokeProgram,
  Model,
  presentModal,
  presentPage,
  sendMessage,
  z,
} from "/p/the8020/uui/mod.ts";
import type { LayoutDocument } from "/p/the8020/uui/mod.ts";
import {
  connection,
  type DeploymentList,
  deploymentPackageId,
  name,
  parseList,
  remotePassword,
  remoteUsername,
  runState,
} from "../types.ts";
import Connections from "../tables/connections.ts";
import Lists from "../tables/lists.ts";
import Runs from "../tables/runs.ts";
import { compareSystems, comparisonChange } from "./comparison.ts";
import {
  deleteList,
  getConnection,
  remoteSnapshot,
  removeConnection,
  saveConnection,
  saveList,
  sendList,
} from "./peers.ts";
import { applyList, inspectRun, reconcileRun, rollbackRun } from "./runs.ts";
import { remoteVersions } from "./versions.ts";

const read = <T extends z.ZodType>(schema: T) =>
  field(schema, { readOnly: true });
const versionText = field(sourceInfo.shape.commit, {
  label: msg("screens.version"),
});
const change = field(z.string(), {
  label: msg("screens.change"),
  description: msg("screens.how_the_installed_and_requested_package_versions"),
});
function listLayout(
  bind: string,
  key: string,
  display: string[],
  toolbar: LayoutDocument["root"]["toolbar"] = [],
): LayoutDocument {
  return {
    schema: 1,
    id: bind,
    root: { id: bind, type: "list", bind, key, display, toolbar },
  };
}
function error(error: unknown) {
  sendMessage(error instanceof Error ? error.message : String(error), "error");
}

export async function deployments(packageId = "") {
  await requirePermission("the8020.deployments.view", "");
  if (packageId) return await newDeployment(packageId);
  const Row = z.object({
    id: z.string(),
    name,
    target: field(systemProfile.shape.name, { label: msg("screens.target") }),
    received: field(z.boolean(), { label: msg("screens.received") }),
  });
  const model = new Model({ rows: [] as z.infer<typeof Row>[] });
  while (true) {
    const local = await getSystemProfile();
    const peers = await Connections.selectAll().limit(1000).execute();
    const rows = await Lists.selectAll().orderBy(Lists.createdAt, "desc").limit(
      1000,
    ).execute();
    model.data.rows = rows.map((row) => ({
      id: row.id,
      name: row.name,
      received: row.received,
      target: row.targetSystemId === local.id
        ? local.name
        : peers.find((peer) => peer.id === row.targetSystemId)?.name ??
          row.targetSystemId,
    }));
    const event = await callScreen({
      id: "deployments",
      title: msg("screens.deployments_value1", { value1: local.name }),
      schema: z.object({ rows: z.array(Row) }),
      model,
      layout: listLayout("rows", "id", ["name", "target", "received"], [
        { id: "new", label: msg("screens.compare_systems"), kind: "primary" },
        { id: "import", label: msg("screens.import_json") },
        { id: "refresh", label: msg("screens.refresh") },
      ]),
      header: {
        actions: [{ id: "runs", label: msg("screens.run_history") }, {
          id: "systems",
          label: msg("screens.systems"),
        }],
      },
    });
    if (event.action === BACK_EVENT) return;
    try {
      if (event.action === "new") await presentPage(() => newDeployment());
      if (event.action === "import") await presentModal(() => jsonEditor());
      if (event.action === "runs") await presentPage(() => runHistory());
      if (event.action === "systems") await presentPage(() => systems());
      if (event.action === "select") {
        const row = rows.find((row) => row.id === event.value);
        if (row) {
          await presentPage(() => reviewList(parseList(row.payload), row.id));
        }
      }
    } catch (cause) {
      error(cause);
    }
  }
}

export async function systems() {
  const profile = await getSystemProfile();
  const model = new Model({
    name: profile.name,
    role: profile.role,
    url: currentBrowser()?.origin ?? "",
    username: "",
    password: "",
    rows: await Connections.selectAll().limit(1000).execute(),
  });
  const schema = z.object({
    name: systemProfile.shape.name,
    role: systemProfile.shape.role,
    url: field(z.string(), {
      label: msg("screens.system_url"),
      description: msg("screens.enter_a_system_address_to_connect_register"),
    }),
    username: remoteUsername,
    password: field(remotePassword, { control: "password" }),
    rows: z.array(connection),
  });
  while (true) {
    const event = await callScreen({
      id: "deployment-systems",
      title: msg("screens.systems"),
      schema,
      model,
      layout: {
        schema: 1,
        id: "systems",
        root: {
          type: "stack",
          children: [
            {
              type: "detail",
              title: msg("screens.this_system"),
              controls: ["name", "role"],
            },
            {
              type: "detail",
              title: msg("screens.connect_or_update_a_system"),
              controls: ["url", "username", "password"],
            },
            {
              toolbar: [{ id: "disconnect", label: msg("screens.disconnect") }],
              type: "list",
              title: msg("screens.connected_systems"),
              bind: "rows",
              key: "id",
              display: ["name", "role", "url", "username"],
            },
          ],
        },
      },
      header: {
        actions: [{ id: "save", label: msg("screens.save_system_settings") }, {
          id: "connect",
          label: msg("screens.save_connection"),
          kind: "primary",
        }],
      },
    });
    if (event.action === BACK_EVENT) {
      model.data.password = "";
      return;
    }
    try {
      if (event.action === "save") {
        await setSystemProfile({
          name: model.data.name,
          role: model.data.role,
        });
        sendMessage(
          localizedText(msg("screens.system_settings_saved")),
          "success",
        );
      }
      if (event.action === "connect") {
        try {
          await saveConnection(
            model.data.url,
            model.data.username,
            model.data.password,
          );
        } finally {
          model.data.password = "";
        }
        sendMessage(localizedText(msg("screens.system_connected")), "success");
      }
      if (event.action === "select") {
        const peer = model.data.rows.find((row) => row.id === event.value);
        if (peer) {
          model.data.url = peer.url;
          model.data.username = peer.username;
          model.data.password = "";
        }
      }
      if (event.action === "disconnect") {
        const peer = model.data.rows.find((row) => row.url === model.data.url);
        if (
          peer &&
          await confirm(
            localizedText(
              msg("screens.disconnect_value1", { value1: peer.name }),
            ),
            localizedText(msg("ui.disconnect")),
            "danger",
          )
        ) {
          await removeConnection(peer.id);
        }
      }
      model.data.rows = await Connections.selectAll().limit(1000).execute();
    } catch (cause) {
      error(cause);
    }
  }
}

async function newDeployment(packageId = "") {
  const local = await getSystemProfile();
  const peers = await Connections.selectAll().limit(1000).execute();
  const choices = [local, ...peers.filter((peer) => peer.id !== local.id)].map((
    peer,
  ) => ({
    value: peer.id,
    label: msg("screens.value1_value2", {
      value1: peer.name,
      value2: peer.role,
    }),
  }));
  const system = field(z.string(), {
    label: msg("screens.system"),
    valueHelp: choiceHelp(z.string(), choices),
  });
  const model = new Model({
    source: peers.find((peer) => peer.role === "development")?.id ?? local.id,
    from: peers.find((peer) => peer.role === "development")?.id ?? local.id,
    target: !packageId && local.role === "development"
      ? peers.find((peer) => peer.role !== "development")?.id ?? local.id
      : local.id,
    name: packageId
      ? `Update ${packageId}`
      : localizedText(msg("screens.deployment")),
  });
  while (true) {
    const event = await callScreen({
      id: "deployment-new",
      title: packageId
        ? localizedText(msg("ui.deploy_package", { package: packageId }))
        : localizedText(msg("screens.compare_systems")),
      schema: z.object({
        name,
        source: field(system, { label: msg("screens.development_source") }),
        from: field(system, { label: msg("screens.compare_versions_from") }),
        target: field(system, {
          label: msg("screens.target_system"),
          readOnly: Boolean(packageId),
        }),
      }),
      model,
      header: {
        actions: [{
          id: "compare",
          label: msg("screens.compare"),
          kind: "primary",
        }],
      },
    });
    if (event.action === BACK_EVENT) return;
    if (event.action === "compare") {
      try {
        const source = await remoteSnapshot(model.data.source),
          target = await remoteSnapshot(model.data.target);
        if (source.system.role !== "development") {
          throw new Error("Choose a development source.");
        }
        await getConnection(source.system.id);
        await presentPage(() =>
          selectPackages(
            {
              schema: 1,
              id: crypto.randomUUID(),
              name: model.data.name,
              sourceSystemId: source.system.id,
              targetSystemId: target.system.id,
              packages: [],
            },
            packageId,
            model.data.from,
          )
        );
      } catch (cause) {
        error(cause);
      }
    }
  }
}

async function selectPackages(
  draft: DeploymentList,
  single = "",
  from = draft.sourceSystemId,
) {
  const source = await remoteSnapshot(from),
    target = await remoteSnapshot(draft.targetSystemId);
  const Row = z.object({
    packageId: read(deploymentPackageId),
    before: field(versionText, {
      label: msg("screens.installed"),
      readOnly: true,
    }),
    after: field(versionText, { label: msg("screens.target"), readOnly: true }),
    change: read(change),
    selected: z.boolean(),
  });
  let rows = compareSystems(source, target, true).filter((row) =>
    !single || row.packageId === single
  )
    .map((row) => ({
      ...row,
      before: row.before ?? "",
      after: row.after ?? "",
      selected: Boolean(single),
    }));
  if (single && !rows.length) {
    rows = [{
      packageId: single,
      before: "",
      after: "",
      change: "added",
      selected: true,
      available: true,
    }];
  }
  let all = Boolean(single);
  const model = new Model({
    rows: rows.filter((row) => all || row.change !== "unchanged"),
  });
  while (true) {
    const event = await callScreen({
      id: "deployment-compare",
      title: msg("screens.value1_value2_2", {
        value1: source.system.name,
        value2: target.system.name,
      }),
      schema: z.object({ rows: z.array(Row) }),
      model,
      layout: {
        schema: 1,
        id: "comparison",
        root: {
          type: "list",
          bind: "rows",
          key: "packageId",
          selection: "selected",
          display: ["packageId", "before", "after", "change"],
          toolbar: [
            {
              id: "review",
              label: single
                ? localizedText(msg("screens.review_update"))
                : localizedText(msg("screens.create_deployment_list")),
              kind: "primary",
            },
            { type: "separator" },
            {
              id: "toggle",
              label: all
                ? localizedText(msg("screens.show_differences"))
                : localizedText(msg("screens.show_all_packages")),
            },
          ],
        },
      },
    });
    for (const changed of model.data.rows) {
      Object.assign(
        rows.find((row) => row.packageId === changed.packageId)!,
        changed,
      );
    }
    if (event.action === BACK_EVENT) return;
    try {
      if (event.action === "toggle") all = !all;
      if (event.action === "select") {
        const row = rows.find((row) => row.packageId === event.value);
        if (row) {
          const selected = await presentPage(() =>
            editPackage(draft.sourceSystemId, row.packageId, row.after)
          );
          if (selected !== undefined) {
            row.after = selected;
            row.selected = true;
            row.change = comparisonChange(
              target.packages.find((item) => item.packageId === row.packageId),
              selected || null,
            );
          }
        }
      }
      if (event.action === "review") {
        const input = parseList({
          ...draft,
          packages: rows.filter((row) => row.selected).map((row) => ({
            packageId: row.packageId,
            before: row.before || null,
            target: row.after ? { commit: row.after, tag: null } : null,
          })),
        });
        if (single) await presentPage(() => reviewList(input, null));
        else {
          await saveList(input);
          await presentPage(() => reviewList(input, input.id));
        }
      }
    } catch (cause) {
      error(cause);
    }
    model.data.rows = rows.filter((row) => all || row.change !== "unchanged");
  }
}

async function editPackage(
  source: string,
  packageId: string,
  selected: string,
) {
  const versions = await remoteVersions(source, packageId);
  const schema = z.object({
    packageId: read(deploymentPackageId),
    selection: field(sourceInfo.shape.commit, {
      label: msg("screens.target_version"),
      description: msg("screens.choose_an_exact_development_commit_from_the"),
      valueHelp: choiceHelp(
        sourceInfo.shape.commit,
        versions.versions.map((row) => ({
          value: row.commit,
          label: `${row.tags.join(", ")} ${row.short_commit} — ${row.subject}`
            .trim(),
        })),
      ),
    }),
    versions: z.array(
      z.object({
        commit: sourceInfo.shape.commit,
        tags: sourceInfo.shape.tags,
        subject: sourceInfo.shape.subject,
      }),
    ),
  });
  const model = new Model({
    packageId,
    selection: selected,
    versions: versions.versions.map((row) => ({
      commit: row.commit,
      tags: row.tags.join(", "),
      subject: row.subject,
    })),
  });
  while (true) {
    const event = await callScreen({
      id: "deployment-package",
      title: packageId,
      schema,
      model,
      header: {
        actions: [{
          id: "remove",
          label: msg("screens.remove_package"),
          kind: "danger",
        }, { id: "package", label: msg("screens.package_details") }],
      },
      layout: {
        schema: 1,
        id: "package",
        root: {
          type: "stack",
          children: [
            { type: "detail", controls: ["packageId", "selection"] },
            {
              toolbar: [{
                id: "choose",
                label: msg("screens.use_version"),
                kind: "primary",
              }],
              type: "list",
              bind: "versions",
              key: "commit",
              display: ["commit", "tags", "subject"],
            },
          ],
        },
      },
    });
    if (event.action === BACK_EVENT) return undefined;
    if (event.action === "remove") return "";
    if (event.action === "select") {
      model.data.selection = String(event.value);
    }
    if (event.action === "package") {
      await invokeProgram("the8020/admin-core/packages", [packageId]);
    }
    if (event.action === "choose") {
      const selection = model.data.selection;
      const version = versions.versions.find((row) => row.commit === selection);
      if (!version) {
        error(new Error("Select an available version."));
        continue;
      }
      return version.commit;
    }
  }
}

export async function reviewList(input: DeploymentList, listId: string | null) {
  const Row = z.object({
    packageId: deploymentPackageId,
    reviewed: field(versionText, { label: msg("screens.reviewed_version") }),
    current: field(versionText, { label: msg("screens.installed_now") }),
    target: field(versionText, { label: msg("screens.target_version") }),
    change,
  });
  const model = new Model({ rows: [] as z.infer<typeof Row>[] });
  while (true) {
    const target = await remoteSnapshot(input.targetSystemId),
      local = await getSystemProfile();
    model.data.rows = input.packages.map((item) => {
      const current = target.packages.find((row) =>
        row.packageId === item.packageId
      );
      return {
        packageId: item.packageId,
        reviewed: item.before ?? "",
        current: current?.commit ?? "",
        target: item.target?.commit ?? item.target?.tag ??
          localizedText(msg("screens.remove")),
        change: comparisonChange(current, item.target?.commit ?? null),
      };
    });
    const event = await callScreen({
      id: "deployment-review",
      title: input.name,
      description: msg("screens.target_value1", { value1: target.system.name }),
      schema: z.object({ rows: z.array(Row) }),
      model,
      layout: listLayout("rows", "packageId", [
        "packageId",
        "reviewed",
        "current",
        "target",
        "change",
      ], [
        ...(local.id === input.targetSystemId
          ? [{
            id: "apply",
            label: msg("screens.apply_deployment"),
            kind: "primary" as const,
          }]
          : [{
            id: "send",
            label: msg("screens.send_to_target"),
            kind: "primary" as const,
          }]),
        { id: "refresh", label: msg("screens.refresh_comparison") },
        { id: "json", label: msg("screens.export_json") },
        { id: "rebase", label: msg("screens.review_current_versions") },
      ]),
      header: {
        actions: [
          ...(listId
            ? [{
              id: "delete",
              label: msg("screens.delete_list"),
              kind: "danger" as const,
            }]
            : []),
        ],
      },
    });
    if (event.action === BACK_EVENT) return;
    try {
      if (event.action === "json") await presentModal(() => jsonEditor(input));
      if (event.action === "send") {
        await sendList(input);
        sendMessage(
          localizedText(msg("screens.deployment_queued_on_target")),
          "success",
        );
      }
      if (
        event.action === "apply" &&
        await confirm(
          localizedText(
            msg("screens.apply_value1_to_value2", {
              value1: input.name,
              value2: target.system.name,
            }),
          ),
          localizedText(msg("ui.apply")),
        )
      ) {
        const run = await applyList(input, listId);
        await presentPage(() => runDetail(run.id));
      }
      if (event.action === "select") {
        const item = input.packages.find((item) =>
          item.packageId === event.value
        );
        if (item) {
          await presentPage(async () => {
            const selected = await editPackage(
              input.sourceSystemId,
              item.packageId,
              item.target?.commit ?? "",
            );
            if (selected === undefined) return;
            const copy = structuredClone(input);
            copy.id = crypto.randomUUID();
            copy.packages.find((row) => row.packageId === item.packageId)!
              .target = selected ? { commit: selected, tag: null } : null;
            if (listId) await saveList(copy);
            await reviewList(copy, listId ? copy.id : null);
          });
        }
      }
      if (event.action === "rebase") {
        const copy = {
          ...input,
          id: crypto.randomUUID(),
          packages: input.packages.map((item) => ({
            ...item,
            before: target.packages.find((row) =>
              row.packageId === item.packageId
            )?.commit ?? null,
          })),
        };
        if (listId) await saveList(copy);
        await presentPage(() => reviewList(copy, listId ? copy.id : null));
      }
      if (
        event.action === "delete" && listId &&
        await confirm(
          localizedText(msg("screens.delete_this_deployment_list")),
          "Delete",
          "danger",
        )
      ) {
        await deleteList(listId);
        return;
      }
    } catch (cause) {
      error(cause);
    }
  }
}

async function jsonEditor(input?: DeploymentList) {
  const model = new Model({
    json: input ? JSON.stringify(input, null, 2) : "",
  });
  while (true) {
    const event = await callScreen({
      id: "deployment-json",
      title: input
        ? localizedText(msg("ui.deployment_json"))
        : localizedText(msg("screens.import_deployment_json")),
      schema: z.object({
        json: field(z.string(), {
          label: msg("screens.json"),
          control: "textarea",
          rowSpan: 8,
          readOnly: Boolean(input),
        }),
      }),
      model,
      header: {
        actions: input
          ? []
          : [{ id: "import", label: msg("screens.import"), kind: "primary" }],
      },
    });
    if (event.action === BACK_EVENT) return;
    if (event.action === "import") {
      try {
        const saved = await saveList(JSON.parse(model.data.json));
        await presentPage(() => reviewList(saved, saved.id));
        return;
      } catch (cause) {
        error(cause);
      }
    }
  }
}

async function runHistory() {
  const Row = z.object({
    id: z.string(),
    name,
    state: runState,
    createdAt: z.date(),
    rollbackOf: z.string().nullable(),
  });
  const model = new Model({ rows: [] as z.infer<typeof Row>[] });
  let offset = 0;
  while (true) {
    model.data.rows = await Runs.select([
      Runs.id,
      Runs.name,
      Runs.state,
      Runs.createdAt,
      Runs.rollbackOf,
    ]).orderBy(Runs.createdAt, "desc").limit(100).offset(offset).execute();
    const event = await callScreen({
      id: "deployment-runs",
      title: msg("screens.deployment_runs"),
      schema: z.object({ rows: z.array(Row) }),
      model,
      layout: listLayout("rows", "id", [
        "name",
        "state",
        "createdAt",
        "rollbackOf",
      ], [
        { id: "refresh", label: msg("screens.refresh") },
        ...(offset ? [{ id: "previous", label: msg("screens.previous") }] : []),
        ...(model.data.rows.length === 100
          ? [{ id: "next", label: msg("screens.next") }]
          : []),
      ]),
    });
    if (event.action === BACK_EVENT) return;
    if (event.action === "next") offset += 100;
    if (event.action === "previous") offset = Math.max(0, offset - 100);
    if (event.action === "select" && typeof event.value === "string") {
      await presentPage(() => runDetail(event.value as string));
    }
  }
}

export async function runDetail(id: string) {
  const schema = z.object({
    state: read(runState),
    error: read(z.string()),
    rows: z.array(
      z.object({
        packageId: deploymentPackageId,
        before: field(versionText, { label: msg("screens.before") }),
        after: field(versionText, { label: msg("screens.after") }),
        change,
        state: runState.or(z.literal("pending")),
        error: z.string(),
      }),
    ),
  });
  const model = new Model<z.infer<typeof schema>>({
    state: "running",
    error: "",
    rows: [],
  });
  while (true) {
    const run = await inspectRun(id);
    model.data = {
      state: run.state,
      error: run.error,
      rows: run.packages.map((item) => ({
        ...item,
        before: item.before ?? "",
        after: item.after ?? "",
        change: item.change,
      })),
    };
    const event = await callScreen({
      id: "deployment-run",
      title: run.name,
      schema,
      model,
      header: {
        actions: [
          { id: "refresh", label: msg("screens.refresh") },
          ...(run.state !== "running"
            ? [{
              id: "rollback",
              label: msg("screens.roll_back"),
              kind: "danger" as const,
            }]
            : [{ id: "reconcile", label: msg("screens.check_execution") }]),
        ],
      },
    });
    if (event.action === BACK_EVENT) return;
    if (event.action === "reconcile") {
      try {
        await reconcileRun(id);
      } catch (cause) {
        error(cause);
      }
    }
    if (event.action === "rollback") {
      try {
        if (
          await confirm(
            localizedText(
              msg("screens.roll_back_value1", { value1: run.name }),
            ),
            localizedText(msg("ui.roll_back")),
          )
        ) {
          const reverted = await rollbackRun(id);
          await presentPage(() => runDetail(reverted.id));
        }
      } catch (cause) {
        error(cause);
      }
    }
  }
}

function confirm(
  title: string,
  label: string,
  kind: "danger" | "primary" = "primary",
) {
  return confirmAction({
    id: "deployment-confirm",
    title,
    confirm: label,
    kind,
    cancel: msg("screens.cancel"),
  });
}
