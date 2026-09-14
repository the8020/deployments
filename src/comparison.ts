import type {
  DeploymentList,
  PackageState,
  RunItem,
  Snapshot,
} from "../types.ts";

export function compareSystems(
  source: Snapshot,
  target: Snapshot,
  all = false,
) {
  const available = new Map(
    source.packages.map((item) => [item.packageId, item]),
  );
  const installed = new Map(
    target.packages.map((item) => [item.packageId, item]),
  );
  return [...new Set([...available.keys(), ...installed.keys()])].sort()
    .flatMap((packageId) => {
      const from = available.get(packageId), to = installed.get(packageId);
      const before = to?.commit ?? null, after = from?.commit ?? null;
      if (!all && before === after) return [];
      return [{
        packageId,
        before,
        after,
        selected: false,
        change: changeKind(before, after),
        available: !from || from.state === "ready",
      }];
    });
}

export function changeKind(
  before: string | null,
  after: string | null,
  versions: Array<{ commit: string; parents: string[] | null }> = [],
) {
  const basic = before === after
    ? "unchanged"
    : before === null
    ? "added"
    : after === null
    ? "removed"
    : "changed";
  if (basic !== "changed") return basic;
  const parents = new Map(versions.map((row) => [row.commit, row.parents]));
  const ancestor = (from: string, target: string) => {
    const pending = [from], seen = new Set<string>();
    while (pending.length) {
      const id = pending.pop()!;
      if (id === target) return true;
      if (seen.has(id)) continue;
      seen.add(id);
      pending.push(...(parents.get(id) ?? []));
    }
    return false;
  };
  // ponytail: bounded inspected history; unknown or divergent ancestry stays
  // "changed" instead of guessing from dates, tag spelling, or list order.
  return ancestor(after!, before!)
    ? "upgraded"
    : ancestor(before!, after!)
    ? "downgraded"
    : "changed";
}

export function checkBaseline(list: DeploymentList, current: PackageState[]) {
  const installed = new Map(current.map((item) => [item.packageId, item]));
  for (const item of list.packages) {
    const actual = installed.get(item.packageId);
    if (
      (actual?.commit ?? null) !== item.before ||
      actual && actual.state !== "ready"
    ) {
      throw new Error(
        `${item.packageId} changed since review. Compare and create a new deployment list.`,
      );
    }
  }
}

export function rollbackList(
  input: DeploymentList,
  items: RunItem[],
): DeploymentList {
  const changed = items.filter((item) =>
    item.processed && item.before !== item.after
  );
  if (!changed.length) throw new Error("This run changed no packages.");
  return {
    ...input,
    id: crypto.randomUUID(),
    name: `Rollback: ${input.name}`.slice(0, 160),
    packages: changed.map((item) => ({
      packageId: item.packageId,
      before: item.after,
      target: item.before ? { commit: item.before, tag: null } : null,
    })),
  };
}
