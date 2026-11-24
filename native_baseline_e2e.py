"""Installed first-use baseline; run sequentially inside a bounded disposable container.

Reuse the maintained native setup and smart HTTP backend. Evidence is private and
must be written outside source. --self-check needs only Python and Git.
"""
import argparse
import base64
import fcntl
from concurrent.futures import ThreadPoolExecutor
import hashlib
import hmac
import http.cookiejar
import http.server
import json
import os
from pathlib import Path
import re
import secrets
import shlex
import signal
import shutil
import tempfile
import threading
import time
import traceback
import tomllib
import urllib.error
import urllib.parse
import urllib.request
import uuid

import native_e2e as h
from native_packaging_e2e import GitOrigin, commit


class PrivateGit(GitOrigin):
    def serve_git(self):
        if not hmac.compare_digest(self.headers.get("Authorization", ""), self.server.authorization):
            self.send_response(401)
            self.send_header("WWW-Authenticate", 'Basic realm="baseline"')
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        super().serve_git()


def private_origin(root, password):
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), PrivateGit)
    server.root, server.guard, server.requests, server.online = root, threading.Lock(), [], True
    server.authorization = "Basic " + base64.b64encode(("x-access-token:" + password).encode()).decode()
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server


def git_environment(server):
    return {**os.environ, "GIT_TERMINAL_PROMPT": "0", "GIT_CONFIG_COUNT": "1",
            "GIT_CONFIG_KEY_0": f"http.http://127.0.0.1:{server.server_port}/.extraHeader",
            "GIT_CONFIG_VALUE_0": "Authorization: " + server.authorization}


def check_origin(root, server):
    source, remote = root / "author", server.root / "qa/private.git"
    source.mkdir(parents=True)
    remote.parent.mkdir(parents=True)
    h.git(source, "init", "-qb", "main")
    first = commit(source, 1)
    h.git(source, "clone", "--bare", str(source), str(remote))
    h.git(remote, "config", "http.receivepack", "true")
    url = f"http://127.0.0.1:{server.server_port}/qa/private.git"
    for header in [None, "Basic aW52YWxpZDppbnZhbGlk"]:
        request = urllib.request.Request(url + "/info/refs?service=git-upload-pack",
                                        headers={} if header is None else {"Authorization": header})
        try:
            urllib.request.urlopen(request, timeout=30).close()
            raise AssertionError("Private origin admitted invalid authentication")
        except urllib.error.HTTPError as error:
            assert error.code == 401
            assert error.read() == b""
    assert not server.requests, "Unauthorized requests reached the Git backend"
    environment = git_environment(server)
    client = root / "client"
    h.command(["git", "clone", url, client], env=environment)
    assert h.git(client, "rev-parse", "HEAD") == first
    second = commit(client, 2)
    h.command(["git", "push", "origin", "main"], cwd=client, env=environment)
    h.command(["git", "fetch", url, "main"], cwd=source, env=environment)
    assert h.git(source, "rev-parse", "FETCH_HEAD") == second
    assert any(path.endswith("/git-receive-pack") for _, path in server.requests)
    assert any(path.endswith("/git-upload-pack") for _, path in server.requests)
    return url, first, second


def write_files(root, files):
    for name, text in files.items():
        path = root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text)


def seed_set(root, server, cross_event=False):
    versions = {name: [] for name in ["aconsumer", "zprovider"]}
    for version in [1, 2]:
        for name in versions:
            repo = root / name
            repo.mkdir(parents=True, exist_ok=True)
            if version == 1:
                h.git(repo, "init", "-qb", "main")
            files = {"package.toml": 'schema = 1\ndescription = "Baseline selected set"\n',
                     "mod.ts": f"export const value = {version};\n"}
            if name == "zprovider":
                files["declarations/auth-roles.toml"] = '["qa.zprovider.viewer"]\npermissions = { "qa.baseline.view" = "*" }\n'
            else:
                files.update({
                    "declarations/auth-roles.toml": '["qa.aconsumer.user"]\nincludes = ["qa.zprovider.viewer"]\n',
                    "transitive.ts": 'export {value} from "/p/qa/zprovider/mod.ts";\n',
                    "tables/effects.ts": 'import {table,t} from "/p/the8020/db/mod.ts";\n'
                        'export default table("qa__aconsumer__effects",{id:t.integer().primaryKey().generated(),version:t.integer()});\n',
                    "programs/hook/program.toml": 'entrypoint = "program.ts"\n',
                    "programs/hook/program.ts": 'import {value} from "../../transitive.ts";\n'
                        'import Effects from "../../tables/effects.ts";\n'
                        f'export default async()=>{{if(value!=={version})throw Error("wrong staged provider");'
                        f'await Effects.insert({{version:{version}}}).execute();}};\n',
                    "hooks/effect.toml": 'hook = "post-activate"\ndescription = "Record selected provider"\nprogram = "qa/aconsumer/hook"\n'})
            if cross_event and name == "zprovider":
                files["programs/listener/program.toml"] = 'entrypoint = "program.ts"\n'
                files["programs/listener/program.ts"] = 'export default () => true;\n'
            if cross_event and name == "aconsumer":
                files["events/listener.toml"] = 'event = "sample"\ndescription = "Selected provider"\nprogram = "qa/zprovider/listener"\n'
            write_files(repo, files)
            h.git(repo, "add", ".")
            h.git(repo, "commit", "-qm", f"Selected set {version}")
            h.git(repo, "tag", f"v{version}")
            versions[name].append(h.git(repo, "rev-parse", "HEAD"))
    for name in versions:
        remote = server.root / f"qa/{name}.git"
        h.git(root, "clone", "--bare", str(root / name), str(remote))
    return versions


def resources():
    cgroup = Path("/sys/fs/cgroup")
    processes = [p for p in Path("/proc").iterdir() if p.name.isdigit()]
    fds, unreadable = 0, 0
    for process in processes:
        try:
            fds += len(list((process / "fd").iterdir()))
        except FileNotFoundError:
            pass
        except PermissionError:
            unreadable += 1
    return dict(memory_bytes=int((cgroup / "memory.current").read_text()),
                cpu_stat=(cgroup / "cpu.stat").read_text(), processes=len(processes),
                fds_lower_bound=fds, unreadable_fd_processes=unreadable,
                disk_bytes=int(h.command(["du", "-s", "-B1", "/root/8020"]).split()[0]))


class Baseline:
    def __init__(self, output):
        self.output = output
        self.results = []
        self.passwords = [secrets.token_urlsafe(24), secrets.token_urlsafe(24)]

    def record(self, case, expected, operation):
        started = time.monotonic()
        row = dict(case=case, expected=expected, started_at=time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()))
        try:
            row.update(status="pass", observed=operation())
        except Exception:
            error = traceback.format_exc()
            for value in self.passwords:
                error = error.replace(value, "[redacted]")
            error = re.sub(r"postgres(?:ql)?://[^\s\"'<>]+", "postgresql://[redacted]", error)
            row.update(status="fail", observed=error)
        row["elapsed_seconds"] = time.monotonic() - started
        self.results.append(row)
        self.output.write_text(json.dumps(self.results, indent=2) + "\n")
        print(case, row["status"], round(row["elapsed_seconds"], 3), flush=True)
        return row["status"] == "pass"

    def blocked(self, case, expected, reason):
        self.results.append(dict(case=case, status="blocked", expected=expected, observed=reason,
                                 started_at=time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())))
        self.output.write_text(json.dumps(self.results, indent=2) + "\n")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--self-check", action="store_true")
    parser.add_argument("--runtime-root", type=Path)
    parser.add_argument("--backend", choices=["sqlite", "postgresql"], default="sqlite")
    parser.add_argument("--output", type=Path)
    parser.add_argument("--set-only", action="store_true", help="Focus on first use, selected-set deployment and rollback")
    parser.add_argument("--promotion-only", action="store_true", help="Focus on first use and production-profile promotion")
    parser.add_argument("--batch-only", action="store_true", help="Qualify ordinary development selected-set synchronization")
    parser.add_argument("--recovery-only", action="store_true", help="Qualify recoverable explicit database-state synchronization")
    parser.add_argument("--batch-samples", action="store_true", help="Measure ten compatible ordinary batch updates")
    args = parser.parse_args()
    os.environ.update(GIT_AUTHOR_NAME="Jan Tomášek", GIT_COMMITTER_NAME="Jan Tomášek",
                      GIT_AUTHOR_EMAIL="tomasekhonza@gmail.com", GIT_COMMITTER_EMAIL="tomasekhonza@gmail.com")
    if args.self_check:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            server = private_origin(root / "origin", secrets.token_urlsafe(24))
            try:
                check_origin(root, server)
            finally:
                server.shutdown()
                server.server_close()
        print("Authenticated smart HTTP clone/fetch/push and rejection checks passed")
        return
    if not args.runtime_root or not args.output:
        parser.error("--runtime-root and --output are required")
    os.sched_setaffinity(0, sorted(os.sched_getaffinity(0))[:2])
    signal.signal(signal.SIGTERM, lambda *_: signal.raise_signal(signal.SIGINT))
    threading.Thread(target=h.monitor, args=(time.monotonic(), 3584, 1800), daemon=True).start()
    args.output.parent.mkdir(parents=True, exist_ok=True)
    baseline = Baseline(args.output)
    h.KERNEL = args.runtime_root / "node/kernel/bin/kernel"
    h.ADMIN = args.runtime_root / "node/kernel/bin/admin"
    server = private_origin(args.output.parent / (args.output.stem + "-origin"), baseline.passwords[0])
    base = Path("/root/8020")
    base.mkdir(parents=True, exist_ok=True)
    n = 1 + max((int(p.name[4:]) for p in base.glob("test[0-9]*") if p.name[4:].isdigit()), default=0)
    dev, target = [base / f"test{i}" for i in [n, n + 1]]
    urls, profiles = [], []
    package, sha = "qa/first", None
    def prepare(root):
        h.prepare(root, args.runtime_root)
        # Keep release history/identity rather than the native suite's source snapshots.
        manifest = tomllib.loads((h.SOURCE / "kernel/defaults/bootstrap-packages.toml").read_text())
        for entry in manifest["packages"]:
            destination = root / "packages" / entry["id"]
            shutil.rmtree(destination)
            h.git(root, "clone", "--quiet", "--no-hardlinks", "--branch", entry["version"],
                  str(h.SOURCE / entry["id"].split("/")[1]), str(destination))
        image = root / "node/kernel/runtime/images/rootless"
        (image / "smoke.json").unlink(missing_ok=True)
        h.command(["bash", root / "node/kernel/runtime/definitions/smoke-portable.sh",
                   root / "node/kernel/bin/runsc", image / "rootfs", image / "image.json",
                   image / "smoke.json", root / "node/kernel/runtime/smoke"])
    try:
        origin = None
        def authenticate_upstream():
            nonlocal origin
            origin = check_origin(args.output.parent / (args.output.stem + "-git"), server)
            return origin
        if not baseline.record("INFRA-GIT", "Private smart HTTP clone/fetch/push; missing and invalid credentials denied", authenticate_upstream):
            return 1
        def fresh():
            os.environ["THE8020_DATABASE_BACKEND"] = args.backend
            os.environ["THE8020_DATABASE_USERNAME"] = "root" if args.backend == "postgresql" else ""
            for root, role in [(dev, "development"), (target, "test")]:
                root.mkdir(mode=0o700)
                prepare(root)
                database = root / "database/system.db"
                if args.backend == "postgresql":
                    name = f"baseline_{root.name}"
                    h.command(["createdb", name])
                    database = f"postgresql://127.0.0.1/{name}?host=/var/run/postgresql"
                port = h.port()
                urls.append(f"http://127.0.0.1:{port}")
                h.start_node(root, database, port)
                profiles.append(h.evaluate(root, 'const {setSystemProfile}=await import("/p/the8020/system/profile.ts");'
                    f'return await setSystemProfile({json.dumps(dict(name="Baseline " + role, role=role))});'))
                h.admin(root, "users.add", "baseline", "--password-stdin", input=baseline.passwords[1] + "\n")
                h.admin(root, "auth.users.assign", "baseline", "the8020.users.administrator")
                jar = http.cookiejar.CookieJar()
                client = urllib.request.build_opener(urllib.request.ProxyHandler({}), urllib.request.HTTPCookieProcessor(jar))
                request = urllib.request.Request(urls[-1] + "/the8020/uui/login/", data=urllib.parse.urlencode(
                    {"username": "baseline", "password": baseline.passwords[1]}).encode())
                with client.open(request, timeout=90) as response:
                    assert response.status == 200 and response.url.endswith("/the8020/uui/shell/")
                assert any(cookie.name == "the8020_auth_" + profiles[-1]["id"] for cookie in jar)
                assert h.evaluate(root, "return 42;") == 42
                h.evaluate(root, 'const {updateDesired}=await import("/p/the8020/services/src/admin.ts");'
                    'for(const id of ["the8020/uui/login","the8020/uui/shell"]) await updateDesired(id,{enabled:false});'
                    'const {kernel}=await import("@the8020/kernel");await kernel.admin.execute("kernel.reindex",{packages:"the8020/uui"});return true;')
            statuses = [h.admin(root, "kernel.status") for root in [dev, target]]
            assert all(state["database_backend"] == args.backend and state["database_initialized"] for state in statuses)
            return dict(roots=[str(dev), str(target)], profiles=profiles,
                        database=[{key: state[key] for key in ["database_backend", "database_initialized", "database_status", "build_id"]}
                                  for state in statuses])
        ready = baseline.record("BASE-01", "Fresh initialized installed kernels, first admin, real login and Worker on declared backend", fresh)
        if not ready:
            for i in range(2, 13):
                baseline.blocked(f"BASE-{i:02}", "Installed scenario from task matrix",
                                 "BASE-01 fresh readiness failed; no product repair or state surgery performed")
            return 1
        def peers():
            for root, url in [(target, urls[0]), (dev, urls[1])]:
                h.admin(root, "deployments.connect", url, "baseline", "--password-stdin", input=baseline.passwords[1] + "\n")
            for url in urls:
                for header in [None, "Basic aW52YWxpZDppbnZhbGlk"]:
                    request = urllib.request.Request(url + "/the8020/deployments/peer/git/qa/first.git/info/refs?service=git-upload-pack",
                                                    headers={} if header is None else {"Authorization": header})
                    try:
                        urllib.request.urlopen(request, timeout=90).close()
                        raise AssertionError("Peer admitted unauthorized request")
                    except urllib.error.HTTPError as error:
                        assert error.code == 401
                        error.close()
            return "Both peer Git boundaries denied invalid authentication; connections accepted real credentials"
        baseline.record("BASE-09", "Upstream and peer Git require authentication", peers)
        def first_package():
            nonlocal sha
            h.admin(dev, "dev-core.sandbox.create", "baseline")
            h.admin(dev, "dev-core.sandbox.start", "baseline")
            path = "/workspace/packages/" + package
            files = {"package.toml": 'schema = 1\ndescription = "First baseline package"\n',
                     "programs/version/program.toml": 'entrypoint = "program.ts"\n',
                     "programs/version/program.ts": "export default () => 1;\n",
                     "tables/jobs.ts": 'import {table,t} from "/p/the8020/db/mod.ts";export default table("qa__first__jobs",{id:t.text().primaryKey()});\n',
                     "programs/hold/program.toml": 'entrypoint = "program.ts"\n',
                     "programs/hold/program.ts": 'import Jobs from "../../tables/jobs.ts";import value from "../version/program.ts";'
                         'export default async()=>{await Jobs.insert({id:"started"}).execute();'
                         'for(let end=Date.now()+60000;Date.now()<end;){if(await Jobs.selectAll().where(Jobs.id,"=","release").executeTakeFirst())'
                         '{await Jobs.insert({id:"finished"}).execute();return value();}await new Promise(r=>setTimeout(r,100));}'
                         'throw Error("Job gate expired");};\n',
                     "services/api/service.toml": 'schema = 2\ndescription = "Baseline persistent API"\nentrypoint = "service.ts"\n'
                         '[access]\nmode = "authenticated"\n[lifecycle]\ndefault_enabled = true\nservice_type = "session"\nsession_keep_alive = "0s"\n'
                         '[scaling]\nminimum_workers = 0\nworker_keep_alive = "1s"\n',
                     "services/api/service.ts": 'import value from "../../programs/version/program.ts";export default {fetch(){return Response.json({version:value()});}};\n'}
            shell = " && ".join(f"mkdir -p {shlex.quote(str(Path(path) / name).rsplit('/', 1)[0])} && "
                f"printf %s {shlex.quote(value)} > {path}/{name}" for name, value in files.items())
            h.admin(dev, "dev-core.sandbox.shell", "baseline", "--command", shell)
            assert not (dev / "packages" / package).exists()
            h.admin(dev, "dev-core.activate.run", "baseline", "--packages", package, "--message", "First baseline revision")
            sha = h.git(dev / "packages" / package, "rev-parse", "HEAD")
            h.git(dev / "packages" / package, "tag", "v1")
            result = h.evaluate(dev, 'const {kernel}=await import("@the8020/kernel"); return await kernel.programs.run({programId:"qa/first/version"});')
            assert result["state"] == "succeeded" and result["result"] == 1
            assert result["packageCommit"] == sha
            return dict(commit=sha, execution=result)
        activated = baseline.record("BASE-02", "First package created in development sandbox and activated through public command", first_package)
        def inspect_run(root, run_id):
            return h.evaluate(root, 'const {inspectRun}=await import("/p/the8020/deployments/src/runs.ts");'
                              f'return await inspectRun({json.dumps(run_id)});')
        def finish(root, run):
            def poll():
                state = inspect_run(root, run["id"])
                assert state["state"] != "running", state
                return state
            state = h.bounded_wait(poll, seconds=180)
            assert state["state"] == "succeeded" and state["lockKey"] is None, state
            return state
        def apply(items, root=target, profile=None):
            payload = dict(schema=1, id=str(uuid.uuid4()), name="Baseline deployment", sourceSystemId=profiles[0]["id"],
                           targetSystemId=(profile or profiles[1])["id"], packages=items)
            h.evaluate(root, 'const {saveList}=await import("/p/the8020/deployments/src/peers.ts");'
                       f'await saveList({json.dumps(payload)});return true;')
            run = h.evaluate(root, 'const {applyList}=await import("/p/the8020/deployments/src/runs.ts");'
                             f'return await applyList({json.dumps(payload)},{json.dumps(payload["id"])});')
            return finish(root, run)
        def item(name, before, after):
            return dict(packageId=name, before=before, target=None if after is None else dict(commit=after, tag=None))
        first_run = None
        def deploy():
            nonlocal first_run
            assert activated, "First activation failed; first deployment has no accepted package commit"
            payload = dict(schema=1, id=str(uuid.uuid4()), name="First baseline deployment", sourceSystemId=profiles[0]["id"],
                           targetSystemId=profiles[1]["id"], packages=[dict(packageId=package, before=None, target=dict(commit=sha, tag=None))])
            h.evaluate(dev, 'const {sendList}=await import("/p/the8020/deployments/src/peers.ts");'
                       f'await sendList({json.dumps(payload)});return true;')
            run = h.evaluate(target, 'const {applyList}=await import("/p/the8020/deployments/src/runs.ts");'
                             f'return await applyList({json.dumps(payload)},{json.dumps(payload["id"])});')
            state = finish(target, run)
            assert state["packages"][0]["before"] is None and state["packages"][0]["after"] == sha
            assert h.git(target / "packages" / package, "rev-parse", "HEAD") == sha
            first_run = state
            return state
        deployed = baseline.record("BASE-03", "Ordinary queued list/apply fetches exact first commit through authenticated peer Git", deploy)
        current, measured = sha, deployed
        def production():
            assert measured, "No accepted test selection available"
            h.admin(target, "kernel.shutdown")
            h.processes[1][1].wait(timeout=25)
            prod = base / f"test{n + 2}"
            prod.mkdir(mode=0o700)
            prepare(prod)
            database = prod / "database/system.db"
            if args.backend == "postgresql":
                name = f"baseline_{prod.name}"
                h.command(["createdb", name])
                database = f"postgresql://127.0.0.1/{name}?host=/var/run/postgresql"
            h.start_node(prod, database, h.port())
            profile = h.evaluate(prod, 'const {setSystemProfile}=await import("/p/the8020/system/profile.ts");return await setSystemProfile({name:"Baseline production",role:"production"});')
            h.admin(prod, "deployments.connect", urls[0], "baseline", "--password-stdin", input=baseline.passwords[1] + "\n")
            count = len(server.requests)
            result = apply([item(package, None, current)], root=prod, profile=profile)
            assert len(server.requests) == count
            assert h.git(prod / "packages" / package, "rev-parse", "HEAD") == current
            assert "baseline.upstream" not in json.dumps(h.admin(prod, "secrets.list"))
            return dict(profile=profile, run=result, tested_commit=current, upstream_requests_unchanged=True)
        if args.promotion_only:
            baseline.record("BASE-04", "Promote tested exact selection to independent production configuration through development Git without upstream credentials", production)
            return 0 if all(row["status"] == "pass" for row in baseline.results) else 1
        def effects(root):
            return h.evaluate(root, 'const Effects=(await import("/p/qa/aconsumer/tables/effects.ts")).default;return await Effects.selectAll().orderBy(Effects.id,"asc").execute();')
        if args.batch_only or args.batch_samples or args.recovery_only:
            os.environ.update(GIT_AUTHOR_DATE="2026-11-20T12:00:00Z", GIT_COMMITTER_DATE="2026-11-20T12:00:00Z")
            fixture = args.output.parent / (args.output.stem + "-set")
            versions = seed_set(fixture, server, cross_event=args.batch_only)
            args.output.with_name(args.output.stem + "-inputs.json").write_text(json.dumps(dict(
                versions=versions, sources={name: f"http://127.0.0.1:{server.server_port}/qa/{name}.git" for name in versions},
                build=h.admin(dev, "kernel.status")["build_id"], backend=args.backend), indent=2) + "\n")
            h.admin(dev, "secrets.set", "baseline.upstream", "--value-stdin", input=baseline.passwords[0] + "\n")
            def select(commits):
                for name, value in commits.items():
                    h.admin(dev, "packages.index.set", "qa/" + name, "--source",
                            f"http://127.0.0.1:{server.server_port}/qa/{name}.git",
                            "--secret", "baseline.upstream", "--commit", value)
            def sync(names):
                result = h.admin(dev, "packages.synchronize", "--packages", ",".join("qa/" + name for name in names))
                assert len(result["packages"]) == len(names), result
                assert all(row.get("outcome") != "failed" and row.get("success", True) for row in result["packages"]), result
                return result
            def journals():
                rows = h.evaluate(dev, 'const A=(await import("/p/the8020/packages/tables/activations.ts")).default;'
                                  'return await A.selectAll().orderBy(A.startedAt,"asc").execute();')
                return [h.admin(dev, "kernel.packages.activation.inspect", row["activationId"])["activation"]
                        for row in rows if any(c["package_id"].startswith(("qa/", "acme/")) for c in
                            h.admin(dev, "kernel.packages.activation.inspect", row["activationId"])["activation"]["candidates"])]
            def assert_set(commits, expected, selected=None):
                for name, value in commits.items():
                    assert h.git(dev / "packages/qa" / name, "rev-parse", "HEAD") == value
                    row = h.admin(dev, "packages.index.inspect", "qa/" + name)["package"]
                    assert row["active_commit"] == value and row["commit"] == (selected or commits)[name] and row["state"] == "ready", row
                    assert row["source"] == f"http://127.0.0.1:{server.server_port}/qa/{name}.git" and row["secret"] == "baseline.upstream", row
                    receipts = h.evaluate(dev, 'const N=(await import("/p/the8020/packages/tables/node_packages.ts")).default;'
                                          f'return await N.selectAll().where(N.packageId,"=",{json.dumps("qa/" + name)}).execute();')
                    assert len(receipts) == 1 and receipts[0]["ready"] and receipts[0]["activeCommit"] == value, receipts
                assert [row["version"] for row in effects(dev)] == expected
            def recovery(initial):
                prior = {name: values[initial] for name, values in versions.items()}
                wanted = {name: values[1] for name, values in versions.items()}
                if initial == 0:
                    select(prior)
                    sync(list(prior))
                _, _, upstream = origin
                select({"private": upstream})
                sync(["private"])
                repos = dev / "packages/qa"
                unselected = repos / "private"
                h.git(unselected, "switch", "-c", "independent")
                (unselected / "independent").write_bytes(b"unselected work\x00")
                h.git(unselected, "add", "independent")
                h.git(unselected, "commit", "-qm", "unpublished unselected witness")
                h.git(unselected, "switch", "main")
                def fingerprint(root):
                    digest = hashlib.sha256()
                    for path in sorted(root.rglob("*")):
                        if path.is_file() and ".git" not in path.relative_to(root).parts:
                            digest.update(os.fsencode(path.relative_to(root)) + b"\x00" + hashlib.sha256(path.read_bytes()).digest())
                    return dict(tree=digest.hexdigest(), head=h.git(root, "rev-parse", "HEAD"),
                                branch=h.git(root, "branch", "--show-current"), refs=h.git(root, "show-ref", "--heads"),
                                status=h.git(root, "status", "--porcelain"), origin=h.git(root, "remote", "get-url", "origin"))
                def origins():
                    return {name: h.git(server.root / ("qa/" + name + ".git"), "show-ref") for name in [*versions, "private"]}
                untouched, refs = fingerprint(unselected), origins()
                for name in versions:
                    root = repos / name
                    (root / "draft").write_text("unpublished " + name)
                    h.git(root, "add", "draft")
                    h.git(root, "commit", "-qm", "unpublished " + name)
                dirty = repos / "zprovider"
                h.git(dirty, "checkout", "--detach", prior["zprovider"])
                (dirty / "mod.ts").write_text("export const value = 999;\n")
                (dirty / "notes").write_bytes(b"untracked\x00draft")
                before = {name: fingerprint(repos / name) for name in versions}
                if initial == 0:
                    entry = dict(package="qa/zprovider", source=before["zprovider"]["origin"], commit=wanted["zprovider"], secret="baseline.upstream")
                    imported = h.evaluate(dev, 'const {importPackageList}=await import("/p/the8020/packages/src/transfer.ts");'
                                          f'return await importPackageList({json.dumps(dict(schema=1, packages=[entry]))},{{overwrite:true,install:true}});')
                    assert len(imported) == 1 and imported[0]["code"] == "install" and "uncommitted" in imported[0]["detail"], imported
                    assert fingerprint(dirty) == before["zprovider"] and not (dev / "checkout-recovery").exists()
                select(wanted)
                journal = journals()
                copies = dev / "checkout-recovery"
                copies.touch(exist_ok=False)
                try:
                    sync(list(versions))
                    raise AssertionError("save failure was acknowledged")
                except RuntimeError as error:
                    refusal = json.loads(str(error))["error"]
                    assert "recovery" in refusal["message"] and all(not row["success"] for row in refusal["details"]["packages"]), refusal
                finally:
                    copies.unlink()
                assert journals() == journal and before == {name: fingerprint(repos / name) for name in versions}
                result = sync(list(versions))
                assert_set(wanted, [1, 2])
                marker = h.evaluate(dev, 'const {context}=await import("@the8020/context");'
                                    'return {worker:context.workerId,version:(await import("/p/qa/aconsumer/transitive.ts")).value};')
                assert marker["version"] == 2 and marker["worker"].startswith("wrk-")
                recovered = {}
                for row in result["packages"]:
                    name = row["package_id"].split("/")[1]
                    restored = fixture / ("restore-" + name)
                    shutil.copytree(row["recovery_copy"], restored, symlinks=True)
                    recovered[name] = fingerprint(restored)
                    assert recovered[name] == before[name]
                    assert h.git(restored, "show", "main:draft") == "unpublished " + name
                    assert not h.git(repos / name, "status", "--porcelain")
                    assert h.git(repos / name, "remote", "get-url", "origin") == before[name]["origin"]
                saved, settled = list(sorted(copies.iterdir())), journals()
                repeated = sync(list(versions))
                assert all(not row.get("recovery_copy") for row in repeated["packages"])
                assert list(sorted(copies.iterdir())) == saved and journals() == settled
                assert_set(wanted, [1, 2])
                for name in versions:
                    with (dev / "packages/.meta/activation-locks" / ("qa%2F" + name)).open("rb") as lock:
                        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                assert fingerprint(unselected) == untouched and origins() == refs
                manifest = dirty / "package.toml"
                expected = manifest.read_bytes()
                hidden = expected + b"\n# private hidden edit\n"
                h.git(dirty, "update-index", "--assume-unchanged", "package.toml")
                manifest.write_bytes(hidden)
                assert not h.git(dirty, "status", "--porcelain")
                repaired = sync(["zprovider"])["packages"][0]
                scratch = fixture / "restore-hidden"
                shutil.copytree(repaired["recovery_copy"], scratch, symlinks=True)
                assert (scratch / "package.toml").read_bytes() == hidden and manifest.read_bytes() == expected
                assert repaired["commit"] == wanted["zprovider"] and not sync(["zprovider"])["packages"][0].get("recovery_copy")
                assert journals() == settled and fingerprint(unselected) == untouched and origins() == refs
                return dict(before=before, restored=recovered, selected=wanted, worker=marker, refusal=refusal,
                            hidden_restore_sha256=hashlib.sha256(hidden).hexdigest(), installed_manifest_sha256=hashlib.sha256(expected).hexdigest(),
                            import_refused=(initial == 0),
                            upstreams=refs, unselected=untouched, repeated=repeated, effects=[1, 2], locks_released=True)
            try:
                if args.recovery_only:
                    baseline.record("DB-RECOVERY", "Save failure, restore, whole-set publication and repeat", lambda: recovery(0))
                elif args.batch_samples:
                    select({name: values[0] for name, values in versions.items()})
                    sync(["zprovider"])
                    sync(["aconsumer"])
                    for name in versions:
                        h.git(fixture / name, "reset", "--hard", versions[name][0])
                        h.git(server.root / f"qa/{name}.git", "config", "http.receivepack", "true")
                    samples = []
                    def measure_batches():
                        for version in range(2, 12):
                            commits = {}
                            for name in versions:
                                repo = fixture / name
                                if name == "aconsumer":
                                    path = repo / "programs/hook/program.ts"
                                    path.write_text(path.read_text().replace(f"version:{version - 1}", f"version:{version}"))
                                else:
                                    (repo / "revision.ts").write_text(f"export const revision = {version};\n")
                                h.git(repo, "add", ".")
                                h.git(repo, "commit", "-qm", f"Compatible batch {version}")
                                commits[name] = h.git(repo, "rev-parse", "HEAD")
                                h.command(["git", "push", f"http://127.0.0.1:{server.server_port}/qa/{name}.git", "HEAD:refs/heads/measured"],
                                          cwd=repo, env=git_environment(server))
                            select(commits)
                            before, started = resources(), time.monotonic()
                            result = sync(list(versions) if version % 2 == 0 else list(reversed(versions)))
                            elapsed = time.monotonic() - started
                            samples.append(dict(operation="ordinary-batch", input_version=version, warm=True,
                                                commits=commits, elapsed_seconds=elapsed, before=before, after=resources(), result=result))
                            args.output.with_name(args.output.stem + "-samples.json").write_text(json.dumps(samples, indent=2) + "\n")
                            assert elapsed <= 180, elapsed
                            assert_set(commits, list(range(1, version + 1)))
                        return dict(samples=len(samples), effects=effects(dev), journals=journals())
                    baseline.record("BATCH-SAMPLES", "Ten matched compatible ordinary selected-set updates; no missing effects", measure_batches)
                else:
                    def ordinary_set():
                        results = []
                        for version in [0, 1]:
                            commits = {name: values[version] for name, values in versions.items()}
                            select(commits)
                            previous = len(journals())
                            result = sync(list(versions) if version == 0 else list(reversed(versions)))
                            assert_set(commits, list(range(1, version + 2)))
                            journal = journals()[-1]
                            assert len(journals()) == previous + 1 and journal["stage"] == "complete", journal
                            assert {c["package_id"] for c in journal["candidates"]} == {"qa/" + name for name in versions}
                            for candidate in journal["candidates"]:
                                assert candidate["commit"] == commits[candidate["package_id"].split("/")[1]]
                                for hook in candidate["hooks"]:
                                    attempts = int(candidate["package_id"] == "qa/aconsumer" and hook["hook"] == "post-activate")
                                    assert hook["state"] == "succeeded" and hook["attempts"] == attempts, journal
                            results.append(dict(result=result, journal=journal))
                        before = journals()
                        for _ in range(10):
                            started = time.monotonic()
                            sync(list(versions))
                            assert time.monotonic() - started <= 30
                        assert journals() == before and [r["version"] for r in effects(dev)] == [1, 2]
                        roles = h.evaluate(dev, 'const R=(await import("/p/the8020/auth/tables/roles.ts")).default;'
                                           'return (await R.selectAll().execute()).filter(r=>r.name.startsWith("qa."));')
                        assert len(roles) == 2 and all(r["managedCommit"] in commits.values() for r in roles), roles
                        return dict(versions=versions, results=results, roles=roles)
                    passed = baseline.record("BATCH-SET", "Both selected orders publish one complete transitive source/schema/hook/role set; no-op has no effects", ordinary_set)
                    if passed:
                        if not baseline.record("BATCH-AHEAD", "Recover clean and detached unpublished work before sync", lambda: recovery(1)):
                            return 1
                        def cycles():
                            values = h.seed_cycle(args.output.parent / (args.output.stem + "-cycle"))
                            for name in values:
                                remote = server.root / f"acme/{name}.git"
                                h.git(fixture, "clone", "--bare", str(args.output.parent / (args.output.stem + "-cycle") / "packages/acme" / name), str(remote))
                            for version, order in [(0, ["alpha", "beta"]), (1, ["beta", "alpha"])]:
                                for name in order:
                                    h.admin(dev, "packages.index.set", "acme/" + name, "--source",
                                            f"http://127.0.0.1:{server.server_port}/acme/{name}.git",
                                            "--secret", "baseline.upstream", "--commit", values[name][version])
                                result = h.admin(dev, "packages.synchronize", "--packages", ",".join("acme/" + name for name in order))
                                journal = journals()[-1]
                                assert journal["stage"] == "complete" and len(journal["candidates"]) == 2, journal
                                assert all(hook["attempts"] == 1 and hook["state"] == "succeeded"
                                           for c in journal["candidates"] for hook in c["hooks"]), journal
                            return dict(versions=values, result=result, journal=journal)
                        baseline.record("BATCH-CYCLE", "Cyclic imports execute through staged pre-hooks and installed post-hooks in both selected orders", cycles)
                        def rejected_sets():
                            before = journals()
                            h.admin(dev, "packages.index.set", "qa/missing", "--source",
                                    f"http://127.0.0.1:{server.server_port}/qa/missing.git", "--secret", "baseline.upstream", "--commit", "a" * 40)
                            select({name: values[0] for name, values in versions.items()})
                            try:
                                sync(["aconsumer", "missing"])
                                raise AssertionError("Missing selected provider was accepted")
                            except RuntimeError as error:
                                missing = str(error)
                            assert journals() == before
                            assert_set({name: values[1] for name, values in versions.items()}, [1, 2],
                                       {name: values[0] for name, values in versions.items()})
                            cycle_root = args.output.parent / (args.output.stem + "-cycle") / "packages/acme"
                            for name, version in [("alpha", 1), ("beta", 2)]:
                                h.admin(dev, "packages.index.set", "acme/" + name, "--source",
                                        f"http://127.0.0.1:{server.server_port}/acme/{name}.git", "--secret", "baseline.upstream",
                                        "--commit", h.git(cycle_root / name, "rev-list", "--max-count=1", f"HEAD~{2 - version}"))
                            try:
                                h.admin(dev, "packages.synchronize", "--packages", "acme/alpha,acme/beta")
                                raise AssertionError("Incompatible retained provider was accepted")
                            except RuntimeError as error:
                                incompatible = str(error)
                            journal = journals()[-1]
                            assert "peer source not staged" in incompatible, incompatible
                            assert all(hook["attempts"] == 0 for c in journal["candidates"] for hook in c["hooks"] if hook["hook"] == "post-activate"), journal
                            for name in ["alpha", "beta"]:
                                assert h.git(dev / "packages/acme" / name, "rev-parse", "HEAD") == h.git(cycle_root / name, "rev-parse", "HEAD")
                            assert [r["version"] for r in effects(dev)] == [1, 2]
                            return dict(missing=missing, incompatible=incompatible, journal=journal, effects=effects(dev))
                        baseline.record("BATCH-REFUSAL", "Missing selected source and incompatible pre-hook provider fail before source/effect publication; no replay", rejected_sets)
                        def catchup():
                            select({name: values[1] for name, values in versions.items()})
                            before = journals()
                            h.admin(target, "kernel.shutdown")
                            h.processes[1][1].wait(timeout=25)
                            cold = base / f"test{n + 2}"
                            cold.mkdir(mode=0o700)
                            prepare(cold)
                            shutil.copytree(dev / "node/kernel/keys", cold / "node/kernel/keys", dirs_exist_ok=True)
                            node = re.search(r"nod-[a-z0-9]{10}", (cold / "kernel.toml").read_text()).group()
                            port = h.port()
                            config = dict(node_id=node, url=f"http://127.0.0.1:{port}", recipient_address="127.0.0.1", recipient_port=h.port(), enabled=True)
                            h.evaluate(dev, 'const {kernel}=await import("@the8020/kernel");return await kernel.nodes.set('+json.dumps(config)+');')
                            database = dev / "database/system.db" if args.backend == "sqlite" else f"postgresql://127.0.0.1/baseline_{dev.name}?host=/var/run/postgresql"
                            h.start_node(cold, database, port)
                            def receipts():
                                return h.evaluate(dev, 'const N=(await import("/p/the8020/packages/tables/node_packages.ts")).default;'
                                                  f'return (await N.selectAll().where(N.nodeId,"=",{json.dumps(node)}).execute()).filter(r=>r.packageId.startsWith("qa/")||r.packageId.startsWith("acme/"));')
                            assert not receipts()
                            try:
                                h.admin(cold, "packages.synchronize", "--packages", "acme/beta,qa/aconsumer")
                                raise AssertionError("Missing listener provider accepted")
                            except RuntimeError as error:
                                assert "qa/zprovider/listener" in str(error), error
                            assert not receipts() and not any((cold / "packages" / package).exists() for package in ("acme/beta", "qa/aconsumer"))
                            result = h.admin(cold, "packages.synchronize", "--packages", "qa/zprovider,qa/aconsumer")
                            ready = receipts()
                            assert {r["packageId"]: r["activeCommit"] for r in ready if r["ready"]} == {"qa/"+name: values[1] for name, values in versions.items()}
                            for name, values in versions.items():
                                assert h.git(cold / "packages/qa" / name, "rev-parse", "HEAD") == values[1]
                            assert journals() == before and [r["version"] for r in effects(cold)] == [1, 2]
                            h.admin(cold, "kernel.shutdown")
                            h.processes[-1][1].wait(timeout=25)
                            return dict(root=str(cold), node=node, result=result, ready=ready, effects=effects(dev))
                        if all(row["status"] == "pass" for row in baseline.results):
                            baseline.record("BATCH-CATCHUP", "Cold node rejects missing handler peer without receipts, then installs published pair without shared effects", catchup)
                        def failed_post_hook():
                            commits = {}
                            for name in versions:
                                repo = fixture / name
                                (repo / "mod.ts").write_text("export const value = 3;\n")
                                if name == "aconsumer":
                                    (repo / "programs/hook/program.ts").write_text(
                                        'import {value} from "../../transitive.ts";\n'
                                        'import Effects from "../../tables/effects.ts";\n'
                                        'export default async()=>{if(value!==3)throw Error("wrong staged provider");'
                                        'await Effects.insert({version:3}).execute();throw Error("synthetic post-hook failure");};\n')
                                h.git(repo, "add", ".")
                                h.git(repo, "commit", "-qm", "Failed selected set")
                                commits[name] = h.git(repo, "rev-parse", "HEAD")
                                h.git(server.root / f"qa/{name}.git", "config", "http.receivepack", "true")
                                h.command(["git", "push", f"http://127.0.0.1:{server.server_port}/qa/{name}.git", "HEAD:refs/heads/failure"],
                                          cwd=repo, env=git_environment(server))
                            select(commits)
                            failures = []
                            for attempt in range(2):
                                try:
                                    sync(list(versions))
                                    raise AssertionError("Failed selected set was acknowledged")
                                except RuntimeError as error:
                                    failures.append(str(error))
                                journal = journals()[-1]
                                assert journal["stage"] == "code_switched" and len(journal["candidates"]) == 2, journal
                                assert [row["version"] for row in effects(dev)] == [1, 2, 3]
                                for candidate in journal["candidates"]:
                                    for hook in candidate["hooks"]:
                                        if candidate["package_id"] == "qa/aconsumer" and hook["hook"] == "post-activate":
                                            assert hook["state"] == "failed" and hook["attempts"] == 1, journal
                                for name in versions:
                                    row = h.admin(dev, "packages.index.inspect", "qa/" + name)["package"]
                                    assert row["active_commit"] == versions[name][1] and row["commit"] == commits[name], row
                                    assert h.git(dev / "packages/qa" / name, "rev-parse", "HEAD") == commits[name]
                                if attempt == 0:
                                    assert "synthetic post-hook failure" in failures[0], failures
                            assert "unfinished activation" in failures[1], failures
                            return dict(commits=commits, failures=failures, journal=journal, effects=effects(dev))
                        if all(row["status"] == "pass" for row in baseline.results):
                            baseline.record("BATCH-FAILURE", "Failed post-hook retains both exact candidates without acknowledgement or ordinary retry replay", failed_post_hook)
            finally:
                args.output.with_name(args.output.stem + "-journals.json").write_text(json.dumps(journals(), indent=2) + "\n")
            return 0 if all(row["status"] == "pass" for row in baseline.results) else 1
        versions, upgraded = None, None
        def selected_set():
            nonlocal versions, upgraded
            versions = seed_set(args.output.parent / (args.output.stem + "-set"), server)
            h.admin(dev, "secrets.set", "baseline.upstream", "--value-stdin", input=baseline.passwords[0] + "\n")
            for version in [0, 1]:
                for name in versions:
                    source = f"http://127.0.0.1:{server.server_port}/qa/{name}.git"
                    h.admin(dev, "packages.index.set", "qa/" + name, "--source", source,
                            "--secret", "baseline.upstream", "--commit", versions[name][version])
                # Keep provider-first seeding for the matched recipient baseline setup.
                for name in reversed(versions):
                    result = h.admin(dev, "packages.synchronize", "--packages", "qa/" + name)
                    assert all(row.get("outcome") != "failed" for row in result["packages"]), result
                count = len(server.requests)
                run = apply([item("qa/" + name, None if version == 0 else versions[name][0], versions[name][version]) for name in versions])
                assert len(server.requests) == count, "Recipient contacted private upstream"
                assert [row["after"] for row in run["packages"]] == [versions[name][version] for name in versions]
                journal = h.admin(target, "kernel.packages.activation.inspect", run["activationId"])["activation"]
                assert journal["stage"] == "complete"
                for candidate in journal["candidates"]:
                    for hook in candidate["hooks"]:
                        attempts = 1 if candidate["package_id"] == "qa/aconsumer" and hook["hook"] == "post-activate" else 0
                        assert hook["state"] == "succeeded" and hook["attempts"] == attempts, journal
                assert [row["version"] for row in effects(target)] == list(range(1, version + 2))
                upgraded = run
            roles = h.evaluate(target, 'const Roles=(await import("/p/the8020/auth/tables/roles.ts")).default;'
                               'return (await Roles.selectAll().execute()).filter(r=>r.name.startsWith("qa."));')
            assert len(roles) == 2, roles
            return dict(versions=versions, run=upgraded, effects=effects(target), roles=roles)
        selected = baseline.record("BASE-05", "Consumer-first selected set publishes transitive hook, schema and included provider roles once", selected_set)
        def rollback():
            assert selected, "Selected-set upgrade failed"
            run = h.evaluate(target, 'const {rollbackRun}=await import("/p/the8020/deployments/src/runs.ts");'
                             f'return await rollbackRun({json.dumps(upgraded["id"])});')
            restored = finish(target, run)
            assert [row["after"] for row in restored["packages"]] == [versions[name][0] for name in versions]
            assert [row["version"] for row in effects(target)] == [1, 2, 1]
            assert inspect_run(target, upgraded["id"]) == upgraded
            return restored
        baseline.record("BASE-06", "Supported set rollback records new immutable run and expected additive schema/effects", rollback)
        if args.set_only:
            return 0 if all(row["status"] == "pass" for row in baseline.results) else 1
        samples = []
        def measure(operation, version, fn):
            before = resources()
            start = time.monotonic()
            value = fn()
            elapsed = time.monotonic() - start
            samples.append(dict(operation=operation, input_version=version, warm=True, elapsed_seconds=elapsed,
                                before=before, after=resources()))
            args.output.with_name(args.output.stem + "-samples.json").write_text(json.dumps(samples, indent=2) + "\n")
            assert elapsed <= (30 if operation == "no-op" else 180), (operation, elapsed)
            return value
        def activate(version):
            h.admin(dev, "dev-core.sandbox.shell", "baseline", "--command",
                    f"printf %s {shlex.quote(f'export default () => {version};') } > /workspace/packages/qa/first/programs/version/program.ts")
            h.admin(dev, "dev-core.activate.run", "baseline", "--packages", package, "--message", f"Baseline version {version}")
            return h.git(dev / "packages" / package, "rev-parse", "HEAD")
        current = sha
        def maintenance():
            nonlocal current
            assert deployed, "First deployment failed"
            prior_effects = effects(target) if selected else None
            for version in range(2, 12):
                after = measure("activation", version, lambda: activate(version))
                measure("deployment", version, lambda: apply([item(package, current, after)]))
                current = after
                measure("no-op", version, lambda: h.admin(target, "packages.synchronize", "--packages", package))
                assert h.git(target / "packages" / package, "rev-parse", "HEAD") == current
            assert inspect_run(target, first_run["id"]) == first_run
            assert not selected or effects(target) == prior_effects
            return dict(samples=len(samples), final_commit=current, resource_boundary=resources())
        measured = baseline.record("BASE-07", "Ten comparable activations/deployments/no-ops preserve source, journals and hook effects", maintenance)
        def remove_restore():
            assert measured, "Maintenance baseline did not finish"
            removed = apply([item(package, current, None)])
            assert not (target / "packages" / package).exists()
            run = h.evaluate(target, 'const {rollbackRun}=await import("/p/the8020/deployments/src/runs.ts");'
                             f'return await rollbackRun({json.dumps(removed["id"])});')
            restored = finish(target, run)
            assert h.git(target / "packages" / package, "rev-parse", "HEAD") == current
            execution = h.evaluate(target, 'const {kernel}=await import("@the8020/kernel");return await kernel.programs.run({programId:"qa/first/version"});')
            assert execution["state"] == "succeeded" and execution["result"] == 11 and execution["packageCommit"] == current
            return dict(removed=removed, restored=restored, execution=execution)
        baseline.record("BASE-08", "Product removal and rollback reintroduction converge files and run state", remove_restore)
        def private_work():
            source, first, second = origin
            h.admin(dev, "secrets.set", "baseline.upstream", "--value-stdin", input=baseline.passwords[0] + "\n")
            h.admin(dev, "packages.index.set", "qa/private", "--source", source, "--secret", "baseline.upstream", "--commit", second)
            result = h.admin(dev, "packages.synchronize", "--packages", "qa/private")
            assert all(row.get("outcome") != "failed" for row in result["packages"]), result
            repo = dev / "packages/qa/private"
            private = repo / "private.txt"
            private.write_text("Synthetic private work\n")
            h.git(repo, "add", ".")
            h.git(repo, "commit", "-qm", "Synthetic ahead work")
            ahead = h.git(repo, "rev-parse", "HEAD")
            private.write_text("Synthetic dirty work\n")
            h.admin(dev, "packages.repository.fetch", "qa/private")
            try:
                result = h.admin(dev, "packages.synchronize", "--packages", "qa/private")
            except RuntimeError as error:
                result = str(error)
            assert private.read_text() == "Synthetic dirty work\n" and h.git(repo, "rev-parse", "HEAD") == ahead
            assert h.git(repo, "remote", "get-url", "origin") == source
            names = h.admin(target, "secrets.list")
            assert "baseline.upstream" not in json.dumps(names)
            return dict(synchronize=result, ahead_commit=ahead, upstream=source, target_secret_names=names)
        def malformed():
            from native_packaging_e2e import seed_invalid_release
            authorization = 'const {verify}=await import("/p/the8020/auth/mod.ts");return await verify("baseline_unassigned","qa.baseline.view","x");'
            assert h.evaluate(dev, authorization) is False
            fixture = args.output.parent / (args.output.stem + "-invalid")
            good, invalid, _ = seed_invalid_release(fixture)
            remote = server.root / "qa/invalid.git"
            h.git(fixture, "clone", "--bare", str(fixture / "packages/qa/invalid"), str(remote))
            source = f"http://127.0.0.1:{server.server_port}/qa/invalid.git"
            h.admin(dev, "packages.index.set", "qa/invalid", "--source", source, "--secret", "baseline.upstream", "--commit", good)
            h.admin(dev, "packages.synchronize", "--packages", "qa/invalid")
            h.admin(dev, "packages.index.set", "qa/invalid", "--source", source, "--secret", "baseline.upstream", "--commit", invalid)
            try:
                result = h.admin(dev, "packages.synchronize", "--packages", "qa/invalid")
            except RuntimeError as error:
                result = str(error)
            assert "description" in json.dumps(result).lower(), result
            assert h.git(dev / "packages/qa/invalid", "rev-parse", "HEAD") == good
            assert h.evaluate(dev, authorization) is False
            result_version = h.evaluate(dev, 'const {kernel}=await import("@the8020/kernel");return await kernel.programs.run({programId:"qa/first/version"});')
            assert result_version["state"] == "succeeded"
            return dict(rejected=result, accepted_application=result_version)
        baseline.record("BASE-11", "Malformed hook is actionable and rejected while accepted application code remains usable", malformed)
        def session(route=None):
            authorization = "Basic " + base64.b64encode(("baseline:" + baseline.passwords[1]).encode()).decode()
            headers = {"Authorization": authorization}
            if route:
                headers["the8020-route"] = route
            request = urllib.request.Request(urls[0] + "/qa/first/api/", headers=headers)
            with urllib.request.urlopen(request, timeout=90) as response:
                return json.load(response), response.headers.get("the8020-route")
        def live_work():
            old, route = session()
            assert route and old["version"] == 11, old
            with ThreadPoolExecutor(max_workers=1) as pool:
                future = pool.submit(h.evaluate, dev, 'const {kernel}=await import("@the8020/kernel");return await kernel.programs.run({programId:"qa/first/hold"});')
                def entered():
                    rows = h.evaluate(dev, 'const Jobs=(await import("/p/qa/first/tables/jobs.ts")).default;return await Jobs.selectAll().execute();')
                    assert any(row["id"] == "started" for row in rows)
                h.bounded_wait(entered, seconds=30)
                after = activate(12)
                h.evaluate(dev, 'const Jobs=(await import("/p/qa/first/tables/jobs.ts")).default;await Jobs.insert({id:"release"}).execute();return true;')
                job = future.result(timeout=60)
            assert job["state"] == "succeeded" and job["result"] == 11, job
            retained, retained_route = session(route)
            new, new_route = session()
            assert retained["version"] == 11 and retained_route == route and new["version"] == 12 and new_route != route
            for _ in range(10):
                h.admin(dev, "packages.synchronize", "--packages", package)
            assert session(route)[1] == route and session(new_route)[1] == new_route
            return dict(job=job, retained_version=retained, new_version=new, after=after,
                        binding_fingerprints=[hashlib.sha256(value.encode()).hexdigest() for value in [route, new_route]])
        baseline.record("BASE-12", "Active job finishes once; retained API binding keeps old imports, new binding converges and survives no-ops", live_work)
        baseline.record("BASE-10", "Authenticated configured upstream preserves dirty/ahead private work and confines its secret to development", private_work)
        baseline.record("BASE-04", "Promote tested exact selection to independent production configuration through development Git without upstream credentials", production)
        return 0 if all(row["status"] == "pass" for row in baseline.results) else 1
    finally:
        server.shutdown()
        server.server_close()
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
    raise SystemExit(main())
