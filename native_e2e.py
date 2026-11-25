"""Real two-system activation smoke; uses fresh /root/8020/test<N> instances.

python3 native_e2e.py --runtime-root /root/8020/test13
Requires a built sibling kernel, Git and a qualified rootless image.
CPU affinity, memory, and runtime limits include spawned kernels.
"""
import argparse
import base64
import http.cookiejar
import json
import os
from pathlib import Path
import re
import shutil
import signal
import socket
import sqlite3
import subprocess
import threading
import time
import urllib.request
import uuid

SOURCE = Path(__file__).resolve().parent.parent
KERNEL = SOURCE / "kernel/.development/bin/kernel"
ADMIN = SOURCE / "kernel/.development/bin/admin"
processes = []
peer_host = "127.0.0.1"


def command(args, cwd=None, **kwargs):
    result = subprocess.run([str(arg) for arg in args], cwd=cwd, text=True,
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=120, **kwargs)
    if result.returncode:
        raise RuntimeError(result.stderr or result.stdout)
    return result.stdout.strip()


def git(root, *args):
    return command(["git", "-c", "user.name=Deployment Test", "-c",
                    "user.email=deploy@example.invalid", "-c", "commit.gpgsign=false", *args], cwd=root)


def admin(root, *args, **kwargs):
    result = json.loads(command([ADMIN, "--root", root, "--json", *args], **kwargs))
    if not result.get("success"):
        raise RuntimeError(str(result.get("error")))
    return result["result"]


def evaluate(root, expression):
    result = admin(root, "runtime", "eval", "export default async () => {" + expression + "}",
                   "--timeout-ms", "90000", "--detail", "--read", "/workspace/packages", "--network", peer_host,
                   "--imports", "jsr.io,registry.npmjs.org")["execution"]["execution"]
    if result.get("state") != "SUCCEEDED":
        raise RuntimeError(str(result))
    return result.get("result")


def port():
    with socket.socket() as sock:
        sock.bind(("", 0))
        return sock.getsockname()[1]


def bounded_wait(fn, seconds=90):
    deadline = time.monotonic() + seconds
    while True:
        try:
            return fn()
        except Exception:
            if time.monotonic() >= deadline:
                raise
            time.sleep(1)


def descendant_memory_kib():
    parents, memory = {}, {}
    for entry in Path("/proc").iterdir():
        if not entry.name.isdigit():
            continue
        try:
            status = (entry / "status").read_text()
            parents[int(entry.name)] = int(re.search(r"^PPid:\s+(\d+)", status, re.M)[1])
            match = re.search(r"^Pss:\s+(\d+)", (entry / "smaps_rollup").read_text(), re.M)
            memory[int(entry.name)] = int(match[1]) if match else 0
        except (OSError, TypeError):
            pass
    descendants = {os.getpid()}
    while True:
        expanded = descendants | {pid for pid, parent in parents.items() if parent in descendants}
        if expanded == descendants:
            return sum(memory.get(pid, 0) for pid in descendants)
        descendants = expanded


def monitor(start, memory_mib, seconds):
    cgroup = Path("/sys/fs/cgroup")
    try:
        hard_limit = int((cgroup / "memory.max").read_text())
    except (OSError, ValueError):
        hard_limit = 0
    # A tighter container cap also accounts for detached processes. gVisor mappings inflate summed PSS.
    capped = 0 < hard_limit <= memory_mib * 1024 * 1024
    while True:
        used = int((cgroup / "memory.current").read_text()) // 1024 if capped else descendant_memory_kib()
        available = int(re.search(r"^MemAvailable:\s+(\d+)", Path("/proc/meminfo").read_text(), re.M)[1])
        if used > memory_mib * 1024 or available < 750 * 1024 or time.monotonic() - start > seconds:
            print(f"Native smoke stopped at {used // 1024} MiB, {available // 1024} MiB available.", flush=True)
            os.kill(os.getpid(), signal.SIGTERM)
            return
        time.sleep(1)


def prepare(root, runtime):
    command([KERNEL, "--root", root, "--init-defaults", "--init-only"])
    shutil.copytree(SOURCE / "kernel/defaults/config/runtime", root / "node/kernel/runtime/definitions", dirs_exist_ok=True)
    command(["bash", SOURCE / "kernel/install-development-assets.sh", root])
    shutil.copytree(runtime / "node/kernel/bin", root / "node/kernel/bin", copy_function=os.link, symlinks=True, dirs_exist_ok=True)
    for kind in ["rootless", "development"]:
        image = root / f"node/kernel/runtime/images/{kind}"
        shutil.copytree(runtime / f"node/kernel/runtime/images/{kind}", image, copy_function=os.link, symlinks=True, dirs_exist_ok=True)
        rootfs = image / "rootfs"
        if kind == "rootless":
            # Exercise current runtime sources with the qualified OS/toolchain image.
            runtime_source = SOURCE / "kernel/defaults/config/runtime"
            shutil.rmtree(rootfs / "opt/runtime")
            command(["bash", runtime_source / "stage-service-runtime.sh", SOURCE / "kernel", rootfs / "opt/runtime"])
            shutil.copy2(runtime_source / "image/deno.json", rootfs / "opt/runtime/deno.json")
            shutil.copy2(runtime_source / "protocol/generated.ts", rootfs / "opt/runtime/protocol.ts")
    manifest = (SOURCE / "kernel/defaults/bootstrap-packages.toml").read_text()
    for package in re.findall(r'^id\s*=\s*"([^"]+)"$', manifest, re.M):
        destination = root / "packages" / package
        shutil.copytree(SOURCE / package.split("/")[1], destination,
                        symlinks=True, ignore=shutil.ignore_patterns(".git", ".env", ".env.*", ".development", "node_modules", "__pycache__"))
        git(destination, "init", "-q", "-b", "main")
        git(destination, "add", "--all")
        git(destination, "commit", "-qm", "Native deployment fixture")


def seed_release(root):
    package = root / "packages/acme/release"
    package.mkdir(parents=True)
    (package / "package.toml").write_text('schema = 1\ndescription = "Deployment native fixture"\n')
    (package / "programs/version").mkdir(parents=True)
    (package / "programs/version/program.toml").write_text('schema = 1\nentrypoint = "program.ts"\n')
    git(package, "init", "-q", "-b", "main")
    versions = []
    for value in [1, 2]:
        (package / "programs/version/program.ts").write_text(f'export default () => {value};\n')
        git(package, "add", "--all")
        git(package, "commit", "-qm", f"Release {value}")
        git(package, "tag", f"v{value}")
        versions.append(git(package, "rev-parse", "HEAD"))
    return versions


def seed_cycle(root):
    versions = {name: [] for name in ["alpha", "beta"]}
    for version in [1, 2]:
        for name, peer in [("alpha", "beta"), ("beta", "alpha")]:
            package = root / f"packages/acme/{name}"
            package.mkdir(parents=True, exist_ok=True)
            (package / "package.toml").write_text('schema = 1\ndescription = "Cyclic deployment fixture"\n')
            if version == 1:
                git(package, "init", "-q", "-b", "main")
            (package / "mod.ts").write_text(
                f'import {{value as peer}} from "/p/acme/{peer}/mod.ts"; '
                f'export function value() {{return {version};}} '
                f'export function check() {{if(peer()!=={version}) throw Error("peer source not staged");}}\n')
            for phase in ["pre", "post"]:
                program = package / f"programs/{phase}"
                program.mkdir(parents=True, exist_ok=True)
                (program / "program.toml").write_text('entrypoint = "program.ts"\n')
                (program / "program.ts").write_text('import {check} from "../../mod.ts"; export default check;\n')
                (package / "hooks").mkdir(exist_ok=True)
                (package / f"hooks/{phase}.toml").write_text(
                    f'hook = "{phase}-activate"\ndescription = "Validate cycle"\nprogram = "acme/{name}/{phase}"\n')
            git(package, "add", "--all")
            git(package, "commit", "-qm", f"Cycle {version}")
            versions[name].append(git(package, "rev-parse", "HEAD"))
    return versions


def start_node(root, database, backend):
    log = open(root / "native-smoke.log", "w")
    child = subprocess.Popen([str(KERNEL), "--root", str(root), "--set", f"network.main_port={backend}",
        "--set", f"network.ssh_port={port()}", "--set", f"network.https_port={port()}",
        "--set", f"database.location={database}",
        "--set", "sandbox.runtime.mode=rootless", "--set", "sandbox.warm_pool.size=0",
        "--set", "runtime.sandbox.keep_alive=0", "--set", "runtime.sandbox.stop_grace_period=1000",
        "--set", "job.default.idle_runtime_timeout=1000"],
        env={**os.environ, "GOMAXPROCS": "2"}, stdout=log, stderr=log)
    processes.append((root, child, log))
    def ready():
        state = admin(root, "kernel.status")
        assert state.get("runtime_ready") and state.get("database_initialized") and not state.get("runtime_application_failure"), state
    bounded_wait(ready, seconds=180)
    print("Kernel ready:", root, flush=True)


def rolling_sync(old, new, versions):
    command([KERNEL, "--root", new, "--init-defaults", "--init-only"])
    for folder in ["bin", "runtime/images", "runtime/definitions"]:
        shutil.copytree(old / "node/kernel" / folder, new / "node/kernel" / folder,
                        copy_function=os.link, symlinks=True, dirs_exist_ok=True)
    command(["bash", SOURCE / "kernel/install-development-assets.sh", new])
    shutil.copytree(old / "node/kernel/keys", new / "node/kernel/keys", dirs_exist_ok=True)
    shutil.copytree(old / "packages", new / "packages", symlinks=True, dirs_exist_ok=True)
    node = re.search(r"nod-[a-z0-9]{10}", (new / "kernel.toml").read_text()).group()
    backend = port()
    config = dict(node_id=node, url=f"http://127.0.0.1:{backend}", recipient_address="127.0.0.1", recipient_port=port(), enabled=True)
    evaluate(old, 'const {kernel}=await import("@the8020/kernel"); return await kernel.nodes.set('+json.dumps(config)+');')
    start_node(new, old / "database/system.db", backend)
    expression = ('const {packages}=await import("/p/the8020/packages/src/admin.ts");'
                  'const index=await packages.index.inspect("acme/release");'
                  'await packages.index.set({author:index.author,repository:index.repository,source:index.source,commit:'+json.dumps(versions[1])+'});'
                  'const {packageDifferences,synchronizeNode}=await import("/p/the8020/packages/src/node-sync.ts");'
                  'const rows=(await packageDifferences()).filter(r=>r.packageId==="acme/release");'
                  'if(rows.length!==2)throw Error(JSON.stringify(rows));'
                  'await synchronizeNode(rows.find(r=>r.node==='+json.dumps(node)+')); return rows;')
    evaluate(old, expression)
    for root, wanted in [(old, 1), (new, 2)]:
        result=evaluate(root,'const {kernel}=await import("@the8020/kernel"); return await kernel.programs.run({programId:"acme/release/version"});')
        assert result["result"] == wanted, result
    print("Shared DB rolling sync served v1 on the old node and v2 on the selected new node", flush=True)
    admin(new, "kernel.shutdown")
    processes[-1][1].wait(timeout=25)


def main():
    global peer_host
    args = argparse.ArgumentParser(description=__doc__)
    args.add_argument("--runtime-root", type=Path, required=True)
    args.add_argument("--max-memory-mib", type=int, default=3584)
    args.add_argument("--max-seconds", type=int, default=900)
    options = args.parse_args()
    os.sched_setaffinity(0, sorted(os.sched_getaffinity(0))[:2])
    signal.signal(signal.SIGTERM, lambda *_: (_ for _ in ()).throw(SystemExit("Native smoke stopped")))
    threading.Thread(target=monitor, args=(time.monotonic(), options.max_memory_mib, options.max_seconds), daemon=True).start()
    base = Path("/root/8020")
    number = max([int(p.name[4:]) for p in base.glob("test[0-9]*") if p.name[4:].isdigit()] + [0]) + 1
    roots = [base / f"test{number}", base / f"test{number + 1}"]
    for root in roots:
        root.mkdir(mode=0o700)
    print("Fresh independent systems:", *roots, flush=True)
    host = peer_host = "127.0.0.1"
    urls = []
    try:
        for root in roots:
            prepare(root, options.runtime_root)
            if root == roots[0]:
                versions = seed_release(root)
                cycle_versions = seed_cycle(root)
            backend = port()
            urls.append(f"http://{host}:{backend}")
            start_node(root, root / "database/system.db", backend)
        profiles = []
        for root, role in zip(roots, ["development", "production"]):
            profiles.append(bounded_wait(lambda: evaluate(root,
                'const {setSystemProfile}=await import("/p/the8020/system/profile.ts");'
                f'return await setSystemProfile({json.dumps({"name": "Native " + role, "role": role})});')))
        assert profiles[0]["id"] != profiles[1]["id"]
        assert all(re.fullmatch(r"sys-[a-z0-9]{10}", profile["id"]) for profile in profiles)
        assert admin(roots[0], "kernel.signing.status") != admin(roots[1], "kernel.signing.status")
        print("Independent short system IDs and master keys verified", flush=True)
        passwords = ["native-password", "native-password"]
        for root, password in zip(roots, passwords):
            # Release UI Workers promptly and keep the peer's normal Git service lifetime.
            evaluate(root, 'const {updateDesired}=await import("/p/the8020/services/src/admin.ts");'
                'for (const id of ["the8020/uui/login","the8020/uui/shell"]) '
                'await updateDesired(id,{overrides:{minimumWorkers:0,workerKeepAliveMs:1000}});'
                'const {kernel}=await import("@the8020/kernel"); await kernel.admin.execute("kernel.reindex",{packages:"the8020/uui"}); return true;')
            admin(root, "users.add", "deployer", "--password-stdin", input=password + "\n")
            admin(root, "auth.users.assign", "deployer", "the8020.deployments.peer")
        for url in urls:
            for path in ["/identity", "/snapshot", "/git/acme/release.git/info/refs"]:
                for header in [None, "Basic " + base64.b64encode(b"deployer:wrong").decode()]:
                    request = urllib.request.Request(url + "/the8020/deployments/peer" + path,
                        headers={} if header is None else {"Authorization": header})
                    try:
                        urllib.request.urlopen(request, timeout=90)
                        raise AssertionError("Private endpoint admitted an unauthenticated request")
                    except urllib.error.HTTPError as error:
                        assert error.code == 401 and error.headers["WWW-Authenticate"].startswith("Basic "), error.code
                        error.close()
        print("Private endpoints challenge missing and wrong Basic credentials", flush=True)
        for root in roots:
            for url, password in zip(urls, passwords):
                admin(root, "deployments.connect", url, "deployer", "--password-stdin", input=password + "\n")
            with sqlite3.connect(root / "database/system.db") as database:
                values = database.execute("SELECT value FROM the8020__secrets__secrets").fetchall()
                assert len(values) == 2 and all(value.startswith("v1:") and passwords[0] not in value for (value,) in values)
        print("Connection command authenticated both directions over loopback; database credentials are encrypted", flush=True)
        detected = admin(roots[1], "packages.source.inspect", "acme/release")["source"]
        assert detected["package_id"] == "acme/release" and detected["default_commit"] == versions[1], detected
        observed = evaluate(roots[1], 'const {remoteVersions}=await import("/p/the8020/deployments/src/versions.ts");'
            'const {remoteSnapshot,localSnapshot}=await import("/p/the8020/deployments/src/peers.ts");'
            'const {compareSystems}=await import("/p/the8020/deployments/src/comparison.ts");'
            f'const source={json.dumps(profiles[0]["id"])}; const versions=await remoteVersions(source,"acme/release");'
            'const rows=compareSystems(await remoteSnapshot(source,true),await localSnapshot());'
            'return {commits:versions.versions.map(version=>version.commit),release:rows.find(row=>row.packageId==="acme/release")};')
        assert versions[1] in observed["commits"] and observed["release"]["after"] == versions[1], observed
        jar = http.cookiejar.CookieJar()
        client = urllib.request.build_opener(urllib.request.ProxyHandler({}), urllib.request.HTTPCookieProcessor(jar))
        for url, password in zip(urls, passwords):
            request = urllib.request.Request(url + "/the8020/uui/login/", data=urllib.parse.urlencode({"username": "deployer", "password": password}).encode())
            with client.open(request, timeout=90) as response:
                assert response.status == 200 and response.url.endswith("/the8020/uui/shell/")
        names = {f"the8020_auth_{profile['id']}" for profile in profiles}
        assert {cookie.name for cookie in jar} == names
        for url in urls:
            with client.open(url + "/the8020/deployments/peer/identity", timeout=90) as response:
                assert response.status == 200
        with client.open(urls[0] + "/the8020/uui/login/logout", timeout=90) as response:
            assert response.status == 200
        assert {cookie.name for cookie in jar} == {f"the8020_auth_{profiles[1]['id']}"}
        with client.open(urls[1] + "/the8020/deployments/peer/identity", timeout=90) as response:
            assert response.status == 200
        print("Same-hostname login and logout cookies stay isolated across ports", flush=True)
        for root in roots:
            evaluate(root, 'const {updateDesired}=await import("/p/the8020/services/src/admin.ts");'
                'for(const id of ["the8020/uui/login","the8020/uui/shell"]) await updateDesired(id,{enabled:false});'
                'const {kernel}=await import("@the8020/kernel"); await kernel.admin.execute("kernel.reindex",{packages:"the8020/uui"}); return true;')
        for version, order in [(0, ["alpha", "beta"]), (1, ["beta", "alpha"])]:
            payload = dict(schema=1, id=str(uuid.uuid4()), name="Cyclic selected set", sourceSystemId=profiles[0]["id"],
                           targetSystemId=profiles[1]["id"], packages=[dict(packageId=f"acme/{name}",
                           before=None if version == 0 else cycle_versions[name][0],
                           target=dict(commit=cycle_versions[name][version], tag=None)) for name in order])
            cycle_run = evaluate(roots[1], 'const {saveList}=await import("/p/the8020/deployments/src/peers.ts");'
                'const {applyList}=await import("/p/the8020/deployments/src/runs.ts");'
                f'const input={json.dumps(payload)}; await saveList(input); return await applyList(input,input.id);')
            def cycle_finished():
                current = evaluate(roots[1], 'const {inspectRun}=await import("/p/the8020/deployments/src/runs.ts");'
                    f'return await inspectRun({json.dumps(cycle_run["id"])});')
                assert current["state"] != "running", current
                return current
            completed = bounded_wait(cycle_finished, seconds=180)
            assert completed["state"] == "succeeded" and completed["lockKey"] is None, completed
            assert [item["packageId"] for item in completed["packages"]] == [f"acme/{name}" for name in order]
            activation = admin(roots[1], "kernel.packages.activation.inspect", completed["activationId"])["activation"]
            assert activation["stage"] == "complete" and len(activation["candidates"]) == 2, activation
            assert all(hook["state"] == "succeeded" and hook["attempts"] == 1
                       for item in activation["candidates"] for hook in item["hooks"]), activation
            assert [item["after"] for item in completed["packages"]] == [cycle_versions[name][version] for name in order]
        print("Real cyclic imports passed in both selected orders through one deployment activation, staged pre-hooks and switched post-hooks", flush=True)
        def deploy(before, target):
            payload = dict(schema=1, id=str(uuid.uuid4()), name="Native promotion", sourceSystemId=profiles[0]["id"],
                           targetSystemId=profiles[1]["id"], packages=[dict(packageId="acme/release", before=before, target=target)])
            evaluate(roots[0], 'const {sendList}=await import("/p/the8020/deployments/src/peers.ts");'
                     f'await sendList({json.dumps(payload)}); return true;')
            return evaluate(roots[1], 'const Lists=(await import("/p/the8020/deployments/tables/lists.ts")).default;'
                f'const saved=await Lists.selectAll().where(Lists.id,"=",{json.dumps(payload["id"])}).executeTakeFirstOrThrow();'
                'if(!saved.received) throw new Error("List was not queued");'
                'const {applyList}=await import("/p/the8020/deployments/src/runs.ts"); return await applyList(saved.payload,saved.id);')
        def applied(run, expected):
            def finished():
                current = evaluate(roots[1], 'const {inspectRun}=await import("/p/the8020/deployments/src/runs.ts");'
                                   f'return await inspectRun({json.dumps(run["id"])});')
                assert current["state"] != "running", current
                return current
            run.update(bounded_wait(finished, seconds=180))
            assert run["state"] == "succeeded", run
            assert run["packages"][0]["after"] == expected, run
            if expected:
                assert git(roots[1] / "packages/acme/release", "rev-parse", "HEAD") == expected
                execution = evaluate(roots[1], 'const {kernel}=await import("@the8020/kernel"); return await kernel.programs.run({programId:"acme/release/version"});')
                assert execution["state"] == "succeeded" and execution["result"] == versions.index(expected) + 1, execution
        first = deploy(None, {"commit": None, "tag": "v1"})
        applied(first, versions[0])
        second = deploy(versions[0], {"commit": versions[1], "tag": None})
        applied(second, versions[1])
        assert second["packages"][0]["change"] == "upgraded", second
        print("Queued tag install and commit upgrade activated", flush=True)
        rollback = evaluate(roots[1], 'const {rollbackRun}=await import("/p/the8020/deployments/src/runs.ts");'
            f'return await rollbackRun({json.dumps(second["id"])});')
        applied(rollback, versions[0])
        assert rollback["packages"][0]["change"] == "downgraded", rollback
        assert rollback["rollbackOf"] == second["id"] and rollback["listId"] is None
        adhoc_input = dict(schema=1, id=str(uuid.uuid4()), name="Ad hoc release", sourceSystemId=profiles[0]["id"],
                           targetSystemId=profiles[1]["id"], packages=[dict(packageId="acme/release", before=versions[0], target=dict(commit=versions[1], tag=None))])
        adhoc = evaluate(roots[1], 'const {applyList}=await import("/p/the8020/deployments/src/runs.ts");'
                         f'return await applyList({json.dumps(adhoc_input)});')
        applied(adhoc, versions[1])
        assert adhoc["listId"] is None and adhoc["rollbackOf"] is None
        reverted = evaluate(roots[1], 'const {rollbackRun}=await import("/p/the8020/deployments/src/runs.ts");'
                            f'return await rollbackRun({json.dumps(adhoc["id"])});')
        applied(reverted, versions[0])
        removed = deploy(versions[0], None)
        applied(removed, None)
        restored = evaluate(roots[1], 'const {rollbackRun}=await import("/p/the8020/deployments/src/runs.ts");'
            f'return await rollbackRun({json.dumps(removed["id"])});')
        applied(restored, versions[0])
        rolling_sync(roots[1], base / f"test{number + 2}", versions)
        checked = evaluate(roots[1], 'const {packages}=await import("/p/the8020/packages/src/admin.ts"); return await packages.versions.list("acme/release",1);')
        assert checked["current_commit"] == versions[0] and checked["update_commit"] == versions[1], checked
        upstream = roots[0] / "repair/acme/release.git"
        upstream.parent.mkdir(parents=True)
        git(roots[0], "clone", "--bare", str(roots[0] / "packages/acme/release"), str(upstream))
        git(upstream, "update-server-info")
        evaluate(roots[0], 'const {kernel}=await import("@the8020/kernel"); await kernel.packages.delete("acme/release",true); return true;')
        authorization = "Basic " + base64.b64encode(f"deployer:{passwords[0]}".encode()).decode()
        missing = evaluate(roots[1], f'const response=await fetch({json.dumps(urls[0] + "/the8020/deployments/peer/git/acme/release.git/info/refs")},{{headers:{{Authorization:{json.dumps(authorization)}}}}}); await response.body?.cancel(); return response.status;')
        assert missing == 404, missing
        for role in ["test", "production"]:
            result = evaluate(roots[1], 'const {setSystemProfile}=await import("/p/the8020/system/profile.ts");'
                f'await setSystemProfile({json.dumps({"name": "Native " + role,"role": role})});'
                'const {packages}=await import("/p/the8020/packages/src/admin.ts");'
                'const {development}=await import("/p/the8020/dev-core/src/development.ts");'
                'for (const [action,reason] of [[()=>packages.delete("acme/release",true),"Deployments"],'
                '[()=>development.activate.run({user_id:"unused"}),"development.activation_allowed"]]) {'
                'try {await action();return false;}catch(error){if(!String(error).includes(reason)) throw error;}} return true;')
            assert result is True, result
        admin(roots[0], "kernel.shutdown")
        processes[0][1].wait(timeout=25)
        from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
        from functools import partial
        server = ThreadingHTTPServer(("127.0.0.1", 0), partial(SimpleHTTPRequestHandler, directory=upstream.parents[1]))
        threading.Thread(target=server.serve_forever, daemon=True).start()
        try:
            source=f"http://127.0.0.1:{server.server_port}/acme/release.git"
            admin(roots[1], "packages.repair", "acme/release", "--source", source, "--confirm")
            admin(roots[1], "packages.repair", "acme/release", "--source", source, "--commit", versions[1], "--confirm")
            assert git(roots[1] / "packages/acme/release", "rev-parse", "HEAD")==versions[1]
        finally:
            server.shutdown()
            server.server_close()
        print("Confirmed upstream repair fetched and applied with development stopped",flush=True)
        print("Native deployment smoke passed: independent profiles, HTTP peers, queued lists, tags, update, ad hoc update, rollback, removal, restore from Git, deleted source returns 404, role gates.", flush=True)
    finally:
        for root, child, log in reversed(processes):
            if child.poll() is None:
                try:
                    admin(root, "kernel.shutdown")
                    child.wait(timeout=20)
                except Exception:
                    child.terminate()
                    try:
                        child.wait(timeout=10)
                    except subprocess.TimeoutExpired:
                        child.kill()
            log.close()


if __name__ == "__main__":
    main()
