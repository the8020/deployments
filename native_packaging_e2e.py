"""Installed dev/test package workflows. Run with --runtime-root and optional unittest case names."""
import argparse
from concurrent.futures import ThreadPoolExecutor
from contextlib import ExitStack
import http.server
import json
import os
from pathlib import Path
import re
import shlex
import signal
import sqlite3
import subprocess
import sys
import threading
import time
import unittest
import uuid

import native_e2e as h


def database(root):
    return sqlite3.connect(root / "database/system.db", timeout=10)


def single(root, sql, *args):
    with database(root) as conn:
        row = conn.execute(sql, args).fetchone()
        return row[0] if row else None


def write_version(directory, value):
    (directory / "programs/version").mkdir(parents=True, exist_ok=True)
    (directory / "package.toml").write_text('schema = 1\ndescription = "Packaging E2E"\n')
    (directory / "programs/version/program.toml").write_text('entrypoint = "program.ts"\n')
    (directory / "programs/version/program.ts").write_text(f"export default () => {value};\n")


def commit(directory, value):
    write_version(directory, value)
    h.git(directory, "add", ".")
    h.git(directory, "commit", "-qm", f"Release {value}")
    return h.git(directory, "rev-parse", "HEAD")


def seed_race(root, name):
    directory = root / "packages/qa" / name
    directory.mkdir(parents=True)
    h.git(directory, "init", "-qb", "main")
    # Only this fixture's table controls when its activation hook may finish.
    tables = directory / "tables"
    tables.mkdir()
    table = f"qa__{name}__gate"
    (tables / "gate.ts").write_text(
        'import {table,t} from "/p/the8020/db/mod.ts";\n'
        f'export default table("{table}", {{id:t.text().primaryKey()}});\n')
    first = commit(directory, 1)
    hook = directory / "programs/hold"
    hook.mkdir()
    (hook / "program.toml").write_text('entrypoint = "program.ts"\n')
    (hook / "program.ts").write_text(
        'import Gate from "../../tables/gate.ts";\n'
        'export default async () => {\n'
        '  await Gate.insert({id:"entered"}).execute();\n'
        '  for(let end=Date.now()+120000;Date.now()<end;){\n'
        '    if(await Gate.selectAll().where(Gate.id,"=","open").executeTakeFirst()) return;\n'
        '    await new Promise(resolve=>setTimeout(resolve,200));\n'
        '  }\n'
        '  throw new Error("Fixture release gate timed out");\n'
        '};\n')
    (directory / "hooks").mkdir()
    (directory / "hooks/hold.toml").write_text(
        f'hook = "post-activate"\ndescription = "Hold release for a competing request"\nprogram = "qa/{name}/hold"\n')
    second, third = commit(directory, 2), commit(directory, 3)
    # Bootstrap dev on an ordinary head. Both candidate commits still execute the hook on test.
    (directory / "hooks/hold.toml").unlink()
    commit(directory, 4)
    return first, second, third


def seed_invalid_release(root):
    directory = root / "packages/qa/invalid"
    directory.mkdir(parents=True)
    h.git(directory, "init", "-qb", "main")
    first = commit(directory, 1)
    hooks = directory / "hooks"
    hooks.mkdir()
    manifest = hooks / "invalid.toml"
    manifest.write_text('hook = "post-activate"\nprogram = "qa/invalid/version"\n')
    invalid = commit(directory, 2)
    manifest.unlink()
    return first, invalid, commit(directory, 3)


class GitOrigin(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        self.serve_git()

    def do_POST(self):
        self.serve_git()

    def serve_git(self):
        path, _, query = self.path.partition("?")
        with self.server.guard:
            self.server.requests.append((self.command, path))
            online = self.server.online
        if not online:
            self.send_error(503)
            return
        length = int(self.headers.get("Content-Length", 0))
        env = {**os.environ, "GIT_PROJECT_ROOT": str(self.server.root), "GIT_HTTP_EXPORT_ALL": "1",
               "PATH_INFO": path, "QUERY_STRING": query, "REQUEST_METHOD": self.command,
               "CONTENT_TYPE": self.headers.get("Content-Type", ""), "CONTENT_LENGTH": str(length)}
        result = subprocess.run(["git", "http-backend"], env=env, input=self.rfile.read(length),
                                stdout=subprocess.PIPE, check=True, timeout=30)
        head, payload = result.stdout.split(b"\r\n\r\n", 1)
        headers = dict(line.split(": ", 1) for line in head.decode().split("\r\n"))
        status = int(headers.pop("Status", "200 OK").split()[0])
        self.send_response(status)
        for key, value in headers.items():
            self.send_header(key, value)
        self.end_headers()
        self.wfile.write(payload)

    def log_message(self, *args):
        pass


class Packaging(unittest.TestCase):
    maxDiff = None

    def installed(self, root, package, sha, value):
        self.assertEqual(h.git(root / "packages" / package, "rev-parse", "HEAD"), sha)
        self.assertEqual(single(root, 'select requestedCommit from the8020__packages__packages where packageId=?', package), sha)
        node = re.search(r"nod-[a-z0-9]{10}", (root / "kernel.toml").read_text()).group()
        self.assertEqual(single(root, 'select activeCommit from the8020__packages__node_packages where packageId=? and nodeId=? and ready=1',
                                package, node), sha)
        result = h.evaluate(root, 'const {kernel}=await import("@the8020/kernel"); return await kernel.programs.run({programId:'
                            + json.dumps(package + "/version") + '});')
        self.assertEqual((result["state"], result["result"]), ("succeeded", value))

    def queued(self, name, package, before, after):
        payload = dict(schema=1, id=str(uuid.uuid4()), name=name, sourceSystemId=profiles[0]["id"],
                       targetSystemId=profiles[1]["id"], packages=[
                           dict(packageId=package, before=before, target=dict(commit=after, tag=None))])
        h.evaluate(dev, 'const {sendList}=await import("/p/the8020/deployments/src/peers.ts");'
                   + 'await sendList(' + json.dumps(payload) + ');return true;')
        self.assertEqual(single(test, "select received from the8020__deployments__lists where id=?", payload["id"]), 1)
        return payload

    def apply(self, payload):
        return h.evaluate(test, 'const {applyList}=await import("/p/the8020/deployments/src/runs.ts");'
                          + 'const list=' + json.dumps(payload) + ';return (await applyList(list,list.id)).id;')

    def finished(self, run_id, state="succeeded"):
        def poll():
            with database(test) as db:
                row = db.execute("select state,error,lockKey,packages from the8020__deployments__runs where id=?", (run_id,)).fetchone()
            assert row and row[0] != "running", row
            return row
        actual, error, lock, items = h.bounded_wait(poll, seconds=180)
        self.assertEqual((actual, lock), (state, None), error)
        return json.loads(items)[0], error

    def deployed(self, payload):
        item, _ = self.finished(self.apply(payload))
        self.assertEqual((item["before"], item["after"]), (payload["packages"][0]["before"], payload["packages"][0]["target"]["commit"]))

    def origin_repo(self, name):
        source = dev / "fixtures" / name
        source.mkdir(parents=True)
        h.git(source, "init", "-qb", "main")
        first = commit(source, 1)
        remote = origin.root / "qa" / (name + ".git")
        remote.parent.mkdir(parents=True, exist_ok=True)
        h.git(source, "clone", "--bare", str(source), str(remote))
        h.git(source, "remote", "add", "origin", str(remote))
        return source, first, f"http://127.0.0.1:{origin.server_port}/qa/{name}.git"

    def install(self, root, package, sha, url=None):
        h.admin(root, "packages.index.set", package, "--commit", sha, *(["--source", url] if url else []))
        result = h.admin(root, "packages.synchronize", "--packages", package)
        self.assertNotIn("failed", [row.get("outcome") for row in result["packages"]], result)

    def test_01_local_sandbox_activation_and_deployment(self):
        package = "qa/localwork"
        h.admin(dev, "dev-core.sandbox.create", "deployer")
        h.admin(dev, "dev-core.sandbox.start", "deployer")
        with ExitStack() as sandbox:
            sandbox.callback(h.admin, dev, "dev-core.sandbox.stop", "deployer")
            files = {"package.toml": 'schema = 1\ndescription = "Local E2E"\n',
                     "programs/version/program.toml": 'entrypoint = "program.ts"\n',
                     "programs/version/program.ts": "export default () => 1;\n"}
            path = "/workspace/packages/" + package
            shell = " && ".join([f"mkdir -p {path}/programs/version"] + [
                f"printf %s {shlex.quote(contents)} > {path}/{name}" for name, contents in files.items()])
            h.admin(dev, "dev-core.sandbox.shell", "deployer", "--command", shell)
            self.assertFalse((dev / "packages" / package).exists())
            h.admin(dev, "dev-core.activate.run", "deployer", "--packages", package, "--message", "First local release")
            sha = h.git(dev / "packages" / package, "rev-parse", "HEAD")
            self.assertEqual(h.git(dev / "packages" / package, "remote"), "")
            self.installed(dev, package, sha, 1)
            payload = self.queued("Locally developed package", package, None, sha)
            self.assertFalse((test / "packages" / package).exists())
            h.admin(dev, "dev-core.sandbox.shell", "deployer", "--command",
                    f"printf '%s\n' 'export default () => 2;' > {path}/programs/version/program.ts")
            h.admin(dev, "dev-core.activate.run", "deployer", "--packages", package, "--message", "Untagged local update")
        after = h.git(dev / "packages" / package, "rev-parse", "HEAD")
        self.assertNotEqual(after, sha)
        self.installed(dev, package, after, 2)
        self.deployed(payload)
        self.installed(test, package, sha, 1)
        row = h.evaluate(test, 'const {localSnapshot,remoteSnapshot}=await import("/p/the8020/deployments/src/peers.ts");'
                         'const {compareSystems}=await import("/p/the8020/deployments/src/comparison.ts");'
                         'return compareSystems(await remoteSnapshot(' + json.dumps(profiles[0]["id"]) +
                         ',true),await localSnapshot(undefined,true)).find(row=>row.packageId==="qa/localwork");')
        self.assertEqual((row["before"], row["after"], row["available"]), (sha, after, True))
        self.assertIn("First local release", row["installedLabel"])
        self.assertIn("Untagged local update", row["targetLabel"])
        self.assertEqual(h.admin(test, "packages.versions.list", package, "--limit", "1")["package"]["update_commit"], after)
        h.admin(test, "packages.repository.pull", package)
        self.installed(test, package, after, 2)

    def test_02_non_github_install_and_dev_hotfix(self):
        package = "qa/external"
        source, first, url = self.origin_repo("external")
        self.assertEqual(h.admin(dev, "packages.source.inspect", url)["source"]["default_commit"], first)
        self.install(dev, package, first, url)
        self.installed(dev, package, first, 1)
        self.assertTrue(any(path == "/qa/external.git/git-upload-pack" for _, path in origin.requests))
        count = len(origin.requests)
        self.assertEqual(h.admin(test, "packages.source.inspect", package)["source"]["default_commit"], first)
        self.install(test, package, first)
        self.installed(test, package, first, 1)
        self.assertEqual(len(origin.requests), count)
        second = commit(source, 2)
        h.git(source, "push", "origin", "main")
        self.assertFalse(h.admin(test, "packages.versions.list", package)["package"].get("update_commit"))
        self.assertEqual(len(origin.requests), count)
        h.admin(dev, "packages.repository.fetch", package)
        h.admin(dev, "packages.repository.checkout", package, "--commit", second)
        self.installed(dev, package, second, 2)
        origin.online = False
        self.addCleanup(setattr, origin, "online", True)
        count = len(origin.requests)
        h.admin(test, "packages.repository.fetch", package)
        self.assertEqual(h.admin(test, "packages.versions.list", package)["package"]["update_commit"], second)
        self.installed(test, package, first, 1)
        h.admin(test, "packages.repository.pull", package)
        self.installed(test, package, second, 2)
        row = self.last_change(package)
        self.assertEqual((row[0], row[1], row[2]["before"], row[2]["after"]), (None, None, first, second))
        h.admin(test, "packages.index.set", package, "--commit", first)
        self.assertEqual(h.git(test / "packages" / package, "rev-parse", "HEAD"), second)
        h.admin(test, "packages.synchronize", "--packages", package)
        self.installed(test, package, first, 1)
        self.assertEqual(len(origin.requests), count)

    def last_change(self, package):
        with database(test) as db:
            row = db.execute("""select listId,repairSource,packages from the8020__deployments__runs
                          where json_extract(packages,'$[0].packageId')=? and state='succeeded'
                          order by createdAt desc limit 1""", (package,)).fetchone()
        self.assertIsNotNone(row)
        return row[0], row[1], json.loads(row[2])[0]

    def overlap(self, name, other):
        for repo in dict.fromkeys((name, other)):
            self.deployed(self.queued(repo + " baseline", "qa/" + repo, None, races[repo][0]))
        names = [name, other]
        lists = [self.queued(f"{repo} release {i+2}", "qa/" + repo, races[repo][0], races[repo][i+1])
                 for i, repo in enumerate(names)]
        start = threading.Barrier(2, timeout=20)

        def submit(payload):
            start.wait()
            try:
                return self.apply(payload), None
            except RuntimeError as error:
                return None, str(error)

        with ThreadPoolExecutor(max_workers=2) as clients:
            results = list(clients.map(submit, lists))
        winners = [i for i, (run, _) in enumerate(results) if run]
        self.assertEqual(len(winners), 1, results)
        winner = winners[0]
        loser = 1 - winner
        run_id = results[winner][0]
        loser_error = results[loser][1]
        try:
            self.assertIn(run_id, loser_error)
            self.assertIn("lock", loser_error.lower())
            self.assertEqual(single(test, "select count(*) from the8020__deployments__runs where listId=?", lists[loser]["id"]), 0)
            def entered():
                assert single(test, f"select count(*) from qa__{names[winner]}__gate where id='entered'") == 1
            h.bounded_wait(entered, 100)
            self.assertEqual(single(test, "select lockKey from the8020__deployments__runs where id=?", run_id), "apply")
            if name != other:
                self.assertEqual(h.git(test / "packages/qa" / names[loser], "rev-parse", "HEAD"), races[names[loser]][0])
        finally:
            with database(test) as db:
                for repo in set(names):
                    db.execute(f"insert into qa__{repo}__gate(id) values ('open')")
        self.finished(run_id)
        winner_sha = races[names[winner]][winner+1]
        self.installed(test, "qa/" + names[winner], winner_sha, winner+2)
        print(f"  {lists[winner]['name']} admitted as {run_id}; concurrent {lists[loser]['name']} refused", flush=True)
        if name == other:
            item, message = self.finished(self.apply(lists[loser]), "failed")
            self.assertIn("changed since review", message.lower())
            self.assertEqual(item["after"], winner_sha)
            self.installed(test, "qa/" + name, winner_sha, winner+2)
        else:
            self.deployed(lists[loser])
            self.installed(test, "qa/" + names[loser], races[names[loser]][loser+1], loser+2)

    def test_03_simultaneous_different_packages(self):
        self.overlap("raceleft", "raceright")

    def test_04_simultaneous_same_package_stale_retry(self):
        self.overlap("racesame", "racesame")

    def test_05_rolling_replacement(self):
        self.deployed(self.queued("Rolling baseline", "acme/release", None, rolling_versions[0]))
        h.rolling_sync(test, replacement, rolling_versions)
        for node_root, sha in ((test, rolling_versions[0]), (replacement, rolling_versions[1])):
            node = re.search(r"nod-[a-z0-9]{10}", (node_root / "kernel.toml").read_text()).group()
            self.assertEqual(single(test, "select activeCommit from the8020__packages__node_packages where nodeId=? and packageId='acme/release' and ready=1", node), sha)

    def test_06_invalid_release_and_recovery(self):
        package = "qa/invalid"
        first, invalid, third = invalid_versions
        self.deployed(self.queued("Good baseline", package, None, first))
        broken = self.queued("Invalid hook", package, first, invalid)
        item, error = self.finished(self.apply(broken), "failed")
        self.assertIn("handler description is required", error)
        self.assertEqual(item["after"], first)
        self.installed(test, package, first, 1)
        self.deployed(self.queued("Corrected hook", package, first, third))
        self.installed(test, package, third, 3)

    def test_07_offline_hotfix_test_and_production(self):
        package = "qa/repairable"
        source, first, url = self.origin_repo("repairable")
        self.install(dev, package, first, url)
        self.install(test, package, first, url)
        before = first
        # No developer peer is reachable; the original upstream remains online and advances independently.
        h.admin(dev, "kernel.shutdown")
        h.processes[0][1].wait(timeout=30)
        for i, role in enumerate(("test", "production"), 2):
            with self.subTest(role=role):
                if role == "production":
                    h.evaluate(test, 'const {setSystemProfile}=await import("/p/the8020/system/profile.ts"); return await setSystemProfile({name:"Hotfix",role:"production"});')
                after = commit(source, i)
                h.git(source, "push", "origin", "main")
                count = len(origin.requests)
                with self.assertRaises(RuntimeError):
                    h.admin(test, "packages.repository.fetch", package)
                with self.assertRaisesRegex(RuntimeError, "confirm"):
                    h.admin(test, "packages.repair", package, "--source", url, "--commit", after)
                self.assertEqual(len(origin.requests), count)
                self.assertEqual(h.git(test / "packages" / package, "rev-parse", "HEAD"), before)
                preview = h.admin(test, "packages.repair", package, "--source", url, "--confirm")
                self.assertEqual((preview["current_commit"], preview["update_commit"]), (before, after))
                self.assertGreater(len(origin.requests), count)
                self.assertEqual(h.git(test / "packages" / package, "rev-parse", "HEAD"), before)
                h.admin(test, "packages.repair", package, "--source", url, "--commit", after, "--confirm")
                self.installed(test, package, after, i)
                list_id, repair_source, item = self.last_change(package)
                self.assertEqual((list_id, repair_source, item["before"], item["after"]), (None, url, before, after))
                before = after
        fourth = commit(source, 4)
        h.git(source, "push", "origin", "main")
        dev_url = single(test, "select url from the8020__deployments__connections where role='development'")
        h.start_node(dev, dev / "database/system.db", int(dev_url.rsplit(":", 1)[1]))
        count = len(origin.requests)
        versions = h.admin(test, "packages.versions.list", package)["package"]
        self.assertEqual((versions["current_commit"], versions["default_commit"]), (before, first))
        self.assertFalse(versions.get("update_commit"))
        self.assertEqual(len(origin.requests), count)
        h.admin(dev, "packages.repository.fetch", package)
        h.admin(dev, "packages.repository.checkout", package, "--commit", fourth)
        origin.online = False
        self.addCleanup(setattr, origin, "online", True)
        count = len(origin.requests)
        h.admin(test, "packages.repository.pull", package)
        self.installed(test, package, fourth, 4)
        list_id, repair_source, item = self.last_change(package)
        self.assertEqual((list_id, repair_source, item["before"], item["after"]), (None, None, before, fourth))
        self.assertEqual(len(origin.requests), count)


    def test_08_concurrent_developer_activations(self):
        # Test is idle for the final dev-only scenario; give its resources to the two sandboxes.
        h.admin(test, "kernel.shutdown")
        h.processes[1][1].wait(timeout=25)
        users = ("authorone", "authortwo")

        def edit(user, package, value):
            path = "/workspace/packages/" + package + "/programs/version/program.ts"
            h.admin(dev, "dev-core.sandbox.shell", user, "--command",
                    f"printf '%s\n' 'export default () => {value};' > {path}")

        def activate_together(packages):
            barrier = threading.Barrier(2, timeout=20)
            def activate(index):
                barrier.wait()
                return h.admin(dev, "dev-core.activate.run", users[index], "--packages", packages[index],
                               "--message", "Concurrent activation by " + users[index])["activation"]
            with ThreadPoolExecutor(max_workers=2) as clients:
                return list(clients.map(activate, (0, 1)))

        with ExitStack() as sandboxes:
            for user in users:
                h.admin(dev, "users.add", user, "--password-stdin", input="fixture-password\n")
                h.admin(dev, "dev-core.sandbox.create", user)
                h.admin(dev, "dev-core.sandbox.start", user)
                sandboxes.callback(h.admin, dev, "dev-core.sandbox.stop", user)
            separate = ("qa/raceleft", "qa/raceright")
            with self.subTest(packages="different"):
                for i, package in enumerate(separate):
                    edit(users[i], package, 11+i)
                results = activate_together(separate)
                for i, (package, result) in enumerate(zip(separate, results)):
                    self.assertEqual((result["success"], result["status"]), (True, "committed"), result)
                    self.installed(dev, package, h.git(dev / "packages" / package, "rev-parse", "HEAD"), 11+i)
            with self.subTest(packages="same"):
                package = "qa/racesame"
                for i, user in enumerate(users):
                    edit(user, package, 21+i)
                user = users[1]
                edit(user, separate[0], 24)
                # Hold the first publisher so the second encounters a real lock even on a fast machine.
                hook = h.git(dev / "packages" / package, "show", races["racesame"][1] + ":hooks/hold.toml")
                h.admin(dev, "dev-core.sandbox.shell", users[0], "--command",
                        f"cd /workspace/packages/{package} && mkdir -p hooks && printf %s {shlex.quote(hook)} > hooks/hold.toml")
                def entered():
                    self.assertEqual(single(dev, "select count(*) from qa__racesame__gate where id='entered'"), 1)
                with ThreadPoolExecutor(max_workers=1) as client:
                    first = client.submit(h.admin, dev, "dev-core.activate.run", users[0], "--packages", package,
                                          "--message", "First concurrent edit")
                    try:
                        h.bounded_wait(entered, 100)
                        busy = h.admin(dev, "dev-core.activate.run", user, "--packages", separate[0] + "," + package,
                                       "--message", "Two changed packages")["activation"]
                        self.assertFalse(busy["success"], busy)
                        self.assertIn(f"activation conflict: package {package} publication is busy", busy["error"])
                        self.assertFalse(busy.get("attempt_id"), busy)
                        status = h.admin(dev, "dev-core.activate.run", user, "--action", "status")["activation"]
                        self.assertEqual(status["status"], "idle", status)
                    finally:
                        with database(dev) as db:
                            db.execute("insert into qa__racesame__gate(id) values ('open')")
                    published = first.result()["activation"]
                    self.assertEqual(published["status"], "committed", published)
                self.installed(dev, package, h.git(dev / "packages" / package, "rev-parse", "HEAD"), 21)
                # Reset the hook's entry marker for the resolved version.
                with database(dev) as db:
                    db.execute("delete from qa__racesame__gate where id='entered'")
                pending = h.admin(dev, "dev-core.activate.run", user, "--packages", package,
                                  "--message", "Retry concurrent edit")["activation"]
                self.assertEqual(pending["status"], "conflicted", pending)
                conflict = pending["packages"][0]
                self.assertIn("programs/version/program.ts", conflict["conflicts"])
                worktree = shlex.quote(conflict["conflict_worktree"])
                for stage, value in ((2, 22), (3, 21)):
                    contents = h.admin(dev, "dev-core.sandbox.shell", user, "--command",
                                       f"git -C {worktree} show :{stage}:programs/version/program.ts")
                    self.assertEqual(contents["shell"]["output"].strip(), f"export default () => {value};")
                resolution = ("set -e; cd " + worktree +
                              "; test -n \"$(git ls-files -u)\"; printf '%s\n' 'export default () => 23;' > programs/version/program.ts; "
                              "git add programs/version/program.ts; git -c user.name=Fixture -c user.email=fixture@example.invalid commit -qm Resolve")
                h.admin(dev, "dev-core.sandbox.shell", user, "--command", resolution)
                result = h.admin(dev, "dev-core.activate.run", user, "--action", "continue",
                                 "--message", "Resolve concurrent edits")["activation"]
                self.assertEqual((result["success"], result["status"]), (True, "committed"), result)
                self.installed(dev, package, h.git(dev / "packages" / package, "rev-parse", "HEAD"), 23)
                independent = h.admin(dev, "dev-core.activate.run", user, "--packages", separate[0],
                                      "--message", "Publish the other edit")["activation"]
                self.assertEqual(independent["status"], "committed", independent)
                self.installed(dev, separate[0], h.git(dev / "packages" / separate[0], "rev-parse", "HEAD"), 24)


def main():
    global dev, test, profiles, origin, races, rolling_versions, invalid_versions, replacement
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--runtime-root", required=True, type=Path)
    parser.add_argument("--max-seconds", type=int, default=1800)
    parser.add_argument("--max-memory-mib", type=int, default=3584)
    parser.add_argument("cases", nargs="*", help="Individual test method names")
    args = parser.parse_args()
    os.sched_setaffinity(0, sorted(os.sched_getaffinity(0))[:2])
    signal.signal(signal.SIGTERM, lambda *_: signal.raise_signal(signal.SIGINT))
    threading.Thread(target=h.monitor, args=(time.monotonic(), args.max_memory_mib, args.max_seconds), daemon=True).start()
    base = Path("/root/8020")
    n = 1 + max((int(p.name[4:]) for p in base.glob("test[0-9]*") if p.name[4:].isdigit()), default=0)
    dev, test, replacement = (base / f"test{i}" for i in range(n, n + 3))
    print("Fresh roots", dev, test, flush=True)
    origin = http.server.ThreadingHTTPServer(("127.0.0.1", 0), GitOrigin)
    origin.root, origin.guard, origin.requests, origin.online = dev / "origin", threading.Lock(), [], True
    threading.Thread(target=origin.serve_forever, daemon=True).start()
    profiles, races, urls = [], {}, []
    try:
        for root, role in ((dev, "development"), (test, "test")):
            root.mkdir(mode=0o700)
            h.prepare(root, args.runtime_root)
            if root == dev:
                rolling_versions = h.seed_release(dev)
                invalid_versions = seed_invalid_release(dev)
                for name in ("raceleft", "raceright", "racesame"):
                    races[name] = seed_race(dev, name)
            port = h.port()
            urls.append(f"http://127.0.0.1:{port}")
            h.start_node(root, root / "database/system.db", port)
            profiles.append(h.evaluate(root, 'const {setSystemProfile}=await import("/p/the8020/system/profile.ts"); return await setSystemProfile('
                                       + json.dumps(dict(name="Packaging " + role, role=role)) + ');'))
            # Only the peer service is used. Avoid idle browser Workers in this bounded fixture.
            h.evaluate(root, 'const {updateDesired}=await import("/p/the8020/services/src/admin.ts");'
                       'for(const id of ["the8020/uui/login","the8020/uui/shell"]) await updateDesired(id,{enabled:false});'
                       'const {kernel}=await import("@the8020/kernel");await kernel.admin.execute("kernel.reindex",{packages:"the8020/uui"});return true;')
            h.admin(root, "users.add", "deployer", "--password-stdin", input="fixture-password\n")
        for root, peer in ((test, urls[0]), (dev, urls[1])):
            h.admin(root, "deployments.connect", peer, "deployer", "--password-stdin", input="fixture-password\n")
        suite = (unittest.TestSuite(Packaging(case) for case in sorted(args.cases)) if args.cases else
                 unittest.defaultTestLoader.loadTestsFromTestCase(Packaging))
        return unittest.TextTestRunner(verbosity=2).run(suite).wasSuccessful()
    finally:
        origin.shutdown()
        origin.server_close()
        for root, child, log in reversed(h.processes):
            if child.poll() is None:
                try:
                    h.admin(root, "kernel.shutdown")
                    child.wait(timeout=20)
                except Exception:
                    child.kill()
                    child.wait(timeout=10)
            log.close()


if __name__ == "__main__":
    sys.exit(0 if main() else 1)
