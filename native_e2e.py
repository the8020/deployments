"""Real two-system activation smoke; uses fresh /root/8020/test<N> instances.

python3 native_e2e.py --runtime-root /root/8020/test13
Requires a built sibling kernel, Git, OpenSSL, and a qualified rootless image.
CPU affinity, aggregate proportional memory, and runtime limits include spawned kernels.
"""
import argparse
import base64
import http.client
import http.server
import json
import os
from pathlib import Path
import re
import shutil
import signal
import socket
import ssl
import subprocess
import threading
import time
import urllib.request
import uuid

SOURCE = Path(__file__).resolve().parent.parent
KERNEL = SOURCE / "kernel/.development/bin/kernel"
ADMIN = SOURCE / "kernel/.development/bin/admin"
processes = []
servers = []
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


def admin(root, *args):
    result = json.loads(command([ADMIN, "--root", root, "--json", *args]))
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


def monitor(start, memory_mib, seconds):
    while True:
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
                break
            descendants = expanded
        total = sum(memory.get(pid, 0) for pid in descendants)
        available = int(re.search(r"^MemAvailable:\s+(\d+)", Path("/proc/meminfo").read_text(), re.M)[1])
        if total > memory_mib * 1024 or available < 750 * 1024 or time.monotonic() - start > seconds:
            print(f"Native smoke stopped at {total // 1024} MiB proportional memory, {available // 1024} MiB available.", flush=True)
            os.kill(os.getpid(), signal.SIGTERM)
            return
        time.sleep(1)


def proxy(backend, cert, key):
    class Handler(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            self.forward()

        def do_POST(self):
            self.forward()

        def forward(self):
            length = int(self.headers.get("Content-Length", 0))
            if length > 512 * 1024:
                self.send_error(413)
                return
            conn = http.client.HTTPConnection("127.0.0.1", backend, timeout=90)
            try:
                conn.request(self.command, self.path, body=self.rfile.read(length),
                             headers={name: self.headers[name] for name in ["Content-Type", "Authorization", "the8020-authorization"] if name in self.headers})
                response = conn.getresponse()
                data = response.read(8 * 1024 * 1024 + 1)
                if len(data) > 8 * 1024 * 1024:
                    raise RuntimeError("Native fixture response exceeds 8 MiB")
                self.send_response(response.status)
                self.send_header("Content-Type", response.getheader("Content-Type", "application/octet-stream"))
                if response.getheader("WWW-Authenticate"):
                    self.send_header("WWW-Authenticate", response.getheader("WWW-Authenticate"))
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)
            finally:
                conn.close()

        def log_message(self, *_):
            pass
    server = http.server.ThreadingHTTPServer(("0.0.0.0", 0), Handler)
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    context.load_cert_chain(cert, key)
    server.socket = context.wrap_socket(server.socket, server_side=True)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    servers.append(server)
    return server.server_port


def prepare(root, runtime, cert):
    command([KERNEL, "--root", root, "--init-defaults", "--init-only"])
    shutil.copytree(SOURCE / "kernel/defaults/config/runtime", root / "node/kernel/runtime/definitions", dirs_exist_ok=True)
    shutil.copytree(SOURCE / "kernel/defaults/scripts", root / "scripts", dirs_exist_ok=True)
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
        # Trust the local test CA only in this disposable image. Production source is unchanged.
        (rootfs / "etc/deployments-test-ca.pem").write_bytes(cert.read_bytes())
        binary = rootfs / "usr/bin/deno"
        binary.rename(binary.with_name("deno-real"))
        binary.write_text('''#!/bin/bash
export DENO_CERT=/etc/deployments-test-ca.pem
args=("$@")
for i in "${!args[@]}"; do
  if [[ ${args[$i]} == --allow-run=/usr/bin/deno ]]; then
    args[$i]=--allow-run=/usr/bin/deno,/usr/bin/deno-real
  fi
done
exec /usr/bin/deno-real "${args[@]}"
''')
        binary.chmod(0o755)
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


def main():
    global peer_host
    args = argparse.ArgumentParser(description=__doc__)
    args.add_argument("--runtime-root", type=Path, required=True)
    args.add_argument("--max-memory-mib", type=int, default=3584)
    args.add_argument("--max-seconds", type=int, default=900)
    options = args.parse_args()
    os.sched_setaffinity(0, sorted(os.sched_getaffinity(0))[:2])
    signal.signal(signal.SIGTERM, lambda *_: (_ for _ in ()).throw(RuntimeError("Native smoke stopped")))
    threading.Thread(target=monitor, args=(time.monotonic(), options.max_memory_mib, options.max_seconds), daemon=True).start()
    base = Path("/root/8020")
    number = max([int(p.name[4:]) for p in base.glob("test[0-9]*") if p.name[4:].isdigit()] + [0]) + 1
    roots = [base / f"test{number}", base / f"test{number + 1}"]
    for root in roots:
        root.mkdir(mode=0o700)
    print("Fresh independent systems:", *roots, flush=True)
    tls = roots[0] / "test-tls"
    tls.mkdir(mode=0o700)
    cert, key = tls / "cert.pem", tls / "key.pem"
    ca, ca_key, csr = tls / "ca.pem", tls / "ca-key.pem", tls / "server.csr"
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
        sock.connect(("192.0.2.1", 80))
        host = sock.getsockname()[0]
        peer_host = host
    command(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
             "-keyout", ca_key, "-out", ca, "-subj", "/CN=Deployment Native Test CA",
             "-addext", "basicConstraints=critical,CA:TRUE"])
    command(["openssl", "req", "-new", "-newkey", "rsa:2048", "-nodes", "-keyout", key,
             "-out", csr, "-subj", "/CN=Deployment Native Test"])
    extensions = tls / "server.ext"
    extensions.write_text(f"basicConstraints=critical,CA:FALSE\nkeyUsage=digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=IP:{host},IP:127.0.0.1,DNS:localhost\n")
    command(["openssl", "x509", "-req", "-in", csr, "-CA", ca, "-CAkey", ca_key, "-CAcreateserial",
             "-out", cert, "-days", "1", "-extfile", extensions])
    urls = []
    try:
        for root in roots:
            prepare(root, options.runtime_root, ca)
            if root == roots[0]:
                versions = seed_release(root)
            backend = port()
            urls.append(f"https://{host}:{proxy(backend, cert, key)}")
            log = open(root / "native-smoke.log", "w")
            child = subprocess.Popen([str(KERNEL), "--root", str(root), "--set", f"network.main_port={backend}",
                "--set", f"network.ssh_port={port()}", "--set", f"database.location={root}/database/system.db",
                "--set", "sandbox.runtime.mode=rootless", "--set", "sandbox.warm_pool.size=0",
                "--set", "runtime.sandbox.keep_alive=0"],
                env={**os.environ, "GOMAXPROCS": "2", "GIT_SSL_CAINFO": str(ca)}, stdout=log, stderr=log)
            processes.append((root, child, log))
            bounded_wait(lambda: admin(root, "kernel.status"))
            print("Kernel ready:", root, flush=True)
        profiles = []
        for root, role in zip(roots, ["development", "test"]):
            profiles.append(bounded_wait(lambda: evaluate(root,
                'const {setSystemProfile}=await import("/p/the8020/system/profile.ts");'
                f'return await setSystemProfile({json.dumps({"name": "Native " + role, "role": role})});')))
        assert profiles[0]["id"] != profiles[1]["id"], profiles
        print("Independent database profiles verified", flush=True)
        passwords = ["native-dev-password", "native-test-password"]
        for root, password in zip(roots, passwords):
            evaluate(root, 'const {add}=await import("/p/the8020/users/src/admin.ts");'
                f'return await add("deployer",{json.dumps(password)});')
        for url in urls:
            for path in ["/identity", "/snapshot", "/git/acme/release.git/info/refs"]:
                for header in [None, "Basic " + base64.b64encode(b"deployer:wrong").decode()]:
                    request = urllib.request.Request(url + "/the8020/deployments/peer" + path,
                        headers={} if header is None else {"Authorization": header})
                    try:
                        urllib.request.urlopen(request, context=ssl.create_default_context(cafile=str(ca)), timeout=90)
                        raise AssertionError("Private endpoint admitted an unauthenticated request")
                    except urllib.error.HTTPError as error:
                        assert error.code == 401 and error.headers["WWW-Authenticate"].startswith("Basic "), error.code
                        error.close()
        print("Private endpoints challenge missing and wrong Basic credentials", flush=True)
        for root in roots:
            for url, password in zip(urls, passwords):
                evaluate(root, 'const {saveConnection}=await import("/p/the8020/deployments/src/peers.ts");'
                    f'return await saveConnection({json.dumps(url)},"deployer",{json.dumps(password)});')
        print("Both directions authenticated over trusted HTTPS", flush=True)
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
        evaluate(roots[0], 'const {kernel}=await import("@the8020/kernel"); await kernel.packages.delete("acme/release",true); return true;')
        authorization = "Basic " + base64.b64encode(f"deployer:{passwords[0]}".encode()).decode()
        missing = evaluate(roots[1], f'const response=await fetch({json.dumps(urls[0] + "/the8020/deployments/peer/git/acme/release.git/info/refs")},{{headers:{{Authorization:{json.dumps(authorization)}}}}}); await response.body?.cancel(); return response.status;')
        assert missing == 404, missing
        for role in ["test", "production"]:
            result = evaluate(roots[1], 'const {setSystemProfile}=await import("/p/the8020/system/profile.ts");'
                f'await setSystemProfile({json.dumps({"name": "Native " + role,"role": role})});'
                'const {packages}=await import("/p/the8020/packages/src/admin.ts");'
                'const {development}=await import("/p/the8020/dev-core/src/development.ts");'
                'for (const action of [()=>packages.delete("acme/release",true),()=>packages.versions.list("acme/release"),()=>development.activate.run({user_id:"unused"}),()=>development.sandbox.run("create","unused")]) {'
                'try {await action();return false;}catch(error){if(!String(error).includes("Deployments")) throw error;}} return true;')
            assert result is True, result
        print("Native deployment smoke passed: independent profiles, HTTPS peers, queued lists, tags, update, ad hoc update, rollback, removal, restore from Git, deleted source returns 404, role gates.", flush=True)
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
        for server in servers:
            server.shutdown()


if __name__ == "__main__":
    main()
