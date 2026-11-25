"""Start one hosted build or verify one downloaded successful attempt."""
from datetime import datetime, timezone
import argparse
import hashlib
import json
import os
from pathlib import Path
import platform
import re
import shutil
import subprocess
import tarfile
import time

from build import HERE, PINS, checked, config_bytes, facts, require, write_new

ROOT = HERE.parents[2]
NOTICE_DIR = Path("docs/standards/licenses")
LIMIT = 5 * 1024**3
IMAGE = PINS["image"]
WORKFLOW = ".github/workflows/occt-iges-kernel.yml"
RECIPE_DIR = HERE.relative_to(ROOT).as_posix()
TEMPLATE = RECIPE_DIR + "/occt-iges-kernel.yml.in"
PATCH = "vendor/opencascade/patches/opencascade.js@2.0.0-beta.b5ff984.patch"
NOTICE_MANIFEST = (NOTICE_DIR / "runtime-notices.json").as_posix()
WORK = "occt-iges-output"
TRIPLE = ("opencascade.full.js", "opencascade.full.wasm", "opencascade.full.d.ts")
SOURCES = {"ocjs": "donalffons/opencascade.js", "occt": "Open-Cascade-SAS/OCCT",
           "emscripten": "emscripten-core/emscripten"}


def now():
    return datetime.now(timezone.utc).isoformat()


def record(path, content):
    write_new(path, (json.dumps(content, indent=2) + "\n").encode())


def local_output(*command):
    return subprocess.check_output(command, cwd=ROOT, text=True).strip()


def git_output(*arguments):
    return subprocess.check_output(["git", "--no-optional-locks", *arguments], cwd=ROOT)


def notice_pins():
    notices = PINS["notices"].copy()
    for pin in PINS["freetype"]["notices"].values():
        notices[(NOTICE_DIR / pin["file"]).as_posix()] = {key: pin[key] for key in ("bytes", "sha256")}
    return notices


def committed_recipe(commit, *, check_worktree=False):
    recipe_files = git_output("ls-tree", "-r", "--name-only", "-z", commit, "--", RECIPE_DIR + "/")
    recipe_paths = set(recipe_files.decode("utf8").strip("\0").split("\0"))
    required = {"build.py", "hosted.py", "package.mjs", "pins.json", "README.md", "opencascade.base.yml", "occt-iges-kernel.yml.in"}
    binding_inputs = [*PINS["bindings"], *PINS["customBindings"].values()]
    required.update("bindings/" + binding["input"] for binding in binding_inputs)
    require(recipe_paths == {RECIPE_DIR + "/" + name for name in required}, "Committed recipe inventory differs")
    notices = notice_pins()
    recipe_paths.update({WORKFLOW, PATCH, "LICENSE", NOTICE_MANIFEST, *notices})

    baseline = PINS["baseline"]
    folder = baseline["vendor"]
    baseline_files = {folder + "/package.json": baseline["package"]}
    baseline_files.update({folder + "/" + name: pin for name, pin in baseline["files"].items()})
    sources = {}
    inputs = {}
    for name in sorted(recipe_paths | baseline_files.keys()):
        data = git_output("show", f"{commit}:{name}")
        pin = notices.get(name, baseline_files.get(name))
        if pin is not None:
            require(facts(data) == pin, f"Committed input differs from pin: {name}")
        if check_worktree:
            require((ROOT / name).read_bytes() == data, f"Sparse checkout differs from committed input: {name}")
        inputs[name] = facts(data)
        if name in recipe_paths:
            sources[name] = inputs[name]
    require(sources[PATCH]["sha256"] == baseline["patch"], "Committed CSP patch differs from pin")
    return sources, inputs


def download(url, destination, limit):
    subprocess.run(["curl", "--proto", "=https", "--proto-redir", "=https", "--fail", "--location",
                    "--silent", "--show-error", "--retry", "2", "--max-time", "180",
                    "--max-filesize", str(limit), "--output", str(destination), url], cwd=ROOT, check=True)
    require(0 < destination.stat().st_size <= limit, f"Unexpected download size: {destination.name}")


def archive_member(archive, relative):
    with tarfile.open(archive, "r:gz") as source:
        matches = [member for member in source.getmembers()
                   if member.isfile() and member.name.partition("/")[2] == relative]
        require(len(matches) == 1, f"Missing or ambiguous source member: {archive.name}:{relative}")
        return source.extractfile(matches[0]).read()


def prepare_sources(folder):
    folder.mkdir()
    artifacts = {}
    pins = PINS["freetype"]
    name = "freetype-version_1.zip"
    download(pins["url"], folder / name, pins["bytes"])
    data = checked(folder / name, {key: pins[key] for key in ("bytes", "sha256")})
    require(hashlib.sha512(data).hexdigest() == pins["sha512"], "FreeType SHA-512 changed")
    artifacts[name] = {"origin": pins["url"], **facts(data)}
    for kind, project in SOURCES.items():
        commit = PINS["versions"][kind]
        url = f"https://codeload.github.com/{project}/tar.gz/{commit}"
        name = f"{kind}-{commit}.tar.gz"
        download(url, folder / name, 128 * 1024**2)
        artifacts[name] = {"origin": url, "revision": commit, **facts((folder / name).read_bytes())}
    for path, pin in PINS["imageFiles"].items():
        _, sep, relative = path.partition("/opencascade.js/")
        origin = "ocjs" if sep else "emscripten"
        relative = relative if sep else path.removeprefix("/emsdk/upstream/emscripten/")
        file = folder / f'{origin}-{PINS["versions"][origin]}.tar.gz'
        require(facts(archive_member(file, relative)) == pin, f"Image and public source differ: {relative}")
    return artifacts


def resources(docker_root, stage):
    usage = {}
    for label, path in (("workspace", ROOT), ("docker", docker_root)):
        total, used, free = shutil.disk_usage(path)
        usage[label] = {"totalBytes": total, "usedBytes": used, "freeBytes": free}
    mem = dict((name, int(kib) * 1024) for name, kib
               in re.findall(r"^(MemTotal|MemAvailable):\s+(\d+) kB$", Path("/proc/meminfo").read_text(), re.MULTILINE))
    return {"at": now(), "stage": stage, "disk": usage, "memoryBytes": mem, "logicalCpus": os.cpu_count()}


def run_build(logs, raw, archive, docker_root, sample):
    name = f'pointercad-iges-{os.environ["GITHUB_RUN_ID"]}-{os.environ["GITHUB_RUN_ATTEMPT"]}'
    command = ["docker", "create", "--name", name, "--pull=never",
               "--platform", "linux/amd64", "--network", "none", "--cpus", "1",
               "--env", "threading=single-threaded", "--env", "EMCC_CORES=1",
               "--mount", f"type=bind,source={HERE},target=/recipe,readonly",
               "--mount", f"type=bind,source={archive},target=/port.zip,readonly",
               "--mount", f"type=bind,source={raw},target=/out",
               "--workdir", "/opencascade.js", "--entrypoint", "python3",
               IMAGE, "-B", "-u", "/recipe/build.py", "/out", "/port.zip"]
    subprocess.run(command, cwd=ROOT, check=True)
    try:
        subprocess.run(["docker", "start", name], check=True)
        with subprocess.Popen(["docker", "wait", name], stdout=subprocess.PIPE, text=True) as waiter:
            stage = "compiling"
            deadline = time.monotonic() + 95 * 60
            while True:
                try:
                    output, _ = waiter.communicate(timeout=30)
                    break
                except subprocess.TimeoutExpired:
                    if (raw / "build-inputs.json").is_file():
                        stage = "linking"
                    sample(docker_root, stage)
                    if time.monotonic() >= deadline:
                        waiter.terminate()
                        raise TimeoutError("Hosted build wait exceeded 95 minutes")
        require(waiter.returncode == 0 and output.strip().isdecimal(), "Docker wait did not return a container status")
        status = int(output)
        record(logs / "container-state.json", {"exitCode": status, "recordedAt": now()})
        require(status == 0, f"Container exited {status}")
    finally:
        with (logs / "stdout.log").open("xb") as out, (logs / "stderr.log").open("xb") as err:
            subprocess.run(["docker", "logs", name], stdout=out, stderr=err, timeout=30, check=False)
        state = local_output("docker", "inspect", "--format", "{{.State.Running}}", name)
        if state == "false":
            subprocess.run(["docker", "rm", name], stdout=subprocess.DEVNULL, check=True)


def build_parent(commit):
    commit_and_parents = git_output("rev-list", "--parents", "-n", "1", commit).decode().split()
    require(len(commit_and_parents) == 2 and commit_and_parents[0] == commit, "Expected exactly one reviewed source parent")
    _, parent = commit_and_parents
    diff = git_output("diff-tree", "--no-commit-id", "--no-renames", "--name-status", "-r", "-z", parent, commit)
    require(diff == b"A\0" + WORKFLOW.encode() + b"\0", "Build commit must add exactly one definition")
    template = git_output("show", f"{parent}:{TEMPLATE}")
    require(git_output("show", f"{commit}:{WORKFLOW}") == template, "Workflow differs from the reviewed template")
    return parent


def build_ref(parent):
    return f"refs/heads/build/occt-iges-{parent}"


def build_inputs(repository, commit, tree, parent, ref, *, check_worktree=False):
    recipe, inputs = committed_recipe(commit, check_worktree=check_worktree)
    signature = {"repository": repository, "commit": commit, "tree": tree, "parent": parent,
                 "ref": ref, "workflow": WORKFLOW, "inputs": inputs}
    return {"recipeFiles": recipe, "inputFiles": inputs, "workflowFile": inputs[WORKFLOW],
            "signature": hashlib.sha256(json.dumps(signature, sort_keys=True, separators=(",", ":")).encode()).hexdigest()}


def identity():
    require(os.environ.get("GITHUB_ACTIONS") == "true" and os.environ.get("GITHUB_EVENT_NAME") == "push"
            and os.environ.get("RUNNER_ENVIRONMENT") == "github-hosted" and os.environ.get("RUNNER_ARCH") == "X64"
            and os.environ.get("GITHUB_RUN_ATTEMPT") == "1" and platform.system() == "Linux"
            and platform.machine() == "x86_64" and platform.freedesktop_os_release()["VERSION_ID"] == "24.04",
            "Expected the first attempt of a GitHub-hosted Ubuntu 24.04 x64 build push")
    sha = local_output("git", "--no-optional-locks", "rev-parse", "HEAD")
    tree = local_output("git", "--no-optional-locks", "rev-parse", "HEAD^{tree}")
    parent = build_parent(sha)
    ref = os.environ["GITHUB_REF"]
    event = json.loads(Path(os.environ["GITHUB_EVENT_PATH"]).read_bytes())
    require(ref == build_ref(parent) == event["ref"] and event["created"] is True
            and event["deleted"] is False and event["forced"] is False
            and event["before"] == "0" * 40 and event["after"] == sha,
            "Expected a creation push to the one ref for the reviewed parent")
    workflow_ref = f'{os.environ["GITHUB_REPOSITORY"]}/{WORKFLOW}@{ref}'
    require(sha == os.environ["GITHUB_SHA"] == os.environ["GITHUB_WORKFLOW_SHA"]
            and os.environ["GITHUB_WORKFLOW_REF"] == workflow_ref, "Checkout and push workflow differ")
    return {"commit": sha, "tree": tree, "repository": os.environ["GITHUB_REPOSITORY"],
            "run": os.environ["GITHUB_RUN_ID"], "attempt": os.environ["GITHUB_RUN_ATTEMPT"],
            "job": os.environ["GITHUB_JOB"], "workflow": WORKFLOW, "platform": PINS["platform"],
            "ref": ref, "parent": parent, "workflowRef": workflow_ref, "workflowSha": sha,
            "runnerImage": os.environ["ImageOS"], "runnerImageVersion": os.environ["ImageVersion"]}


def preflight():
    run = identity()
    inputs = build_inputs(run["repository"], run["commit"], run["tree"], run["parent"], run["ref"], check_worktree=True)
    config_bytes()
    return {**run, **inputs}


def seal(folder, intent, digest):
    inventory = {path.relative_to(folder).as_posix(): facts(path.read_bytes())
                 for path in sorted(folder.rglob("*")) if path.is_file()}
    for name in TRIPLE:
        require("vendor/" + name in inventory, f"Missing materialized output: {name}")
    receipt = {"schema": "pointercad-occt-iges/1", "status": "success", **intent, "finishedAt": now(),
               "imageId": digest["Id"], "imageDigest": IMAGE, "imageSizeBytes": digest["Size"], "files": inventory}
    record(folder / "receipt.json", receipt)


def verify(folder, repository, commit, tree, parent, run, attempt):
    require(re.fullmatch(r"[0-9a-f]{40}", commit) and re.fullmatch(r"[0-9a-f]{40}", tree)
            and re.fullmatch(r"[0-9a-f]{40}", parent) and re.fullmatch(r"[1-9][0-9]*", run) and attempt == "1",
            "Expected full commit, parent and tree SHA-1s, a positive run and attempt 1")
    receipt_path = folder / "receipt.json"
    require(not receipt_path.is_symlink(), "Unexpected receipt symlink")
    receipt = json.loads(receipt_path.read_bytes())
    expected = {"schema": "pointercad-occt-iges/1", "status": "success", "imageDigest": IMAGE,
                "repository": repository, "commit": commit, "tree": tree, "run": run, "attempt": attempt,
                "platform": PINS["platform"], "workflow": WORKFLOW,
                "workflowSha": commit, "job": "iges-kernel"}
    require(all(receipt[k] == val for k, val in expected.items()), "Unexpected run, input or result status")
    ref = build_ref(parent)
    require(build_parent(commit) == parent == receipt["parent"] and receipt["ref"] == ref
            and receipt["workflowRef"] == f"{repository}/{WORKFLOW}@{ref}", "Build parent or workflow ref differs")
    require(git_output("rev-parse", f"{commit}^{{tree}}").decode().strip() == tree, "Source commit and tree differ")
    files = {path.relative_to(folder).as_posix() for path in folder.rglob("*") if path.is_file()}
    require(files == set(receipt["files"]) | {"receipt.json"}, "Recovery inventory differs")
    for name in files - {"receipt.json"}:
        path = folder / name
        require(not path.is_symlink() and path.resolve().is_relative_to(folder), f"Unsafe recovery path: {name}")
        checked(path, receipt["files"][name])
    materialized = json.loads((folder / "vendor/materialization.json").read_bytes())
    raw = json.loads((folder / "raw/build-outputs.json").read_bytes())
    staged = json.loads((folder / "raw/build-inputs.json").read_bytes())
    require(staged["configuration"] == PINS["configuration"]["candidate"] and staged["image"] == IMAGE,
            "Build records disagree with the pinned inputs")
    require(materialized["expectedNewExports"] == PINS["exports"] and materialized["raw"] == raw,
            "Materialization and build outputs disagree")
    require(set(raw) == {"opencascade.closed.js", "opencascade.closed.wasm", "opencascade.closed.d.ts"},
            "Unexpected raw output names")
    for name, pin in raw.items():
        require(receipt["files"]["raw/" + name] == pin, f"Wrong raw output: {name}")
    for name in TRIPLE:
        require(receipt["files"]["vendor/" + name] == materialized["vendor"][name], f"Wrong vendor output: {name}")
    transports = materialized["wasmTransport"]
    require(all(transports[target]["decoded"] == raw["opencascade.closed.wasm"] for target in ("web", "desktop"))
            and materialized["vendor"]["opencascade.full.wasm"] == raw["opencascade.closed.wasm"],
            "Raw, installed or decoded WASM differs")
    source_names = {f'{kind}-{PINS["versions"][kind]}.tar.gz' for kind in SOURCES}
    source_names.update(("freetype-version_1.zip", "rapidjson-headers.tar.gz"))
    upstreams = json.loads((folder / "sources/upstreams.json").read_bytes())
    require(set(upstreams) == source_names and "sources/pointercad-iges-recipe.tar.gz" in files,
            "Incomplete corresponding source")
    for name, row in upstreams.items():
        require(receipt["files"]["sources/" + name] == {key: row[key] for key in ("bytes", "sha256")},
                f"Wrong source archive: {name}")
    for kind, project in SOURCES.items():
        revision = PINS["versions"][kind]
        row = upstreams[f"{kind}-{revision}.tar.gz"]
        require(row["revision"] == revision and row["origin"] == f"https://codeload.github.com/{project}/tar.gz/{revision}",
                f"Wrong upstream revision: {kind}")
    freetype = upstreams["freetype-version_1.zip"]
    require(all(freetype[key] == PINS["freetype"][key] for key in ("bytes", "sha256"))
            and freetype["origin"] == PINS["freetype"]["url"]
            and upstreams["rapidjson-headers.tar.gz"]["origin"] == IMAGE, "Wrong embedded dependency source")
    for path, pin in notice_pins().items():
        require(receipt["files"]["licenses/" + Path(path).name] == pin, f"Wrong notice: {path}")
    inputs = build_inputs(repository, commit, tree, parent, ref)
    require(all(receipt[key] == value for key, value in inputs.items()), "Build input receipt differs from the source commit")
    recipe = inputs["recipeFiles"]
    with tarfile.open(folder / "sources/pointercad-iges-recipe.tar.gz", "r:gz") as source:
        members = source.getmembers()
        require(len(members) == len(recipe) and {item.name for item in members} == recipe.keys(),
                "Recipe archive inventory differs")
        for item in members:
            require(item.isfile() and facts(source.extractfile(item).read()) == recipe[item.name],
                    f"Recipe archive member differs: {item.name}")
    print(json.dumps({"verifiedRun": run, "attempt": attempt, "commit": commit, "tree": tree,
                      "receipt": facts(receipt_path.read_bytes())}))
    return receipt


def release_source(folder, destination, repository, commit, tree, parent, run, attempt):
    receipt = verify(folder, repository, commit, tree, parent, run, attempt)
    digest = receipt["files"]["vendor/opencascade.full.wasm"]["sha256"]
    name = f"pointercad-occt-source-{run}-{attempt}-{digest[:16]}.tar.gz"
    destination.mkdir()
    staging = destination / (name + ".pending")
    with tarfile.open(staging, "x:gz") as archive:
        for path in sorted(receipt["files"]):
            if path.startswith(("sources/", "licenses/")) or path == "vendor/materialization.json":
                archive.add(folder / path, arcname=path, recursive=False)
        archive.add(folder / "receipt.json", arcname="receipt.json", recursive=False)
    final = destination / name
    staging.rename(final)
    print(json.dumps({"releaseSource": final.name, "vendorWasmSha256": digest, **facts(final.read_bytes())}))


def hosted():
    work = ROOT / WORK
    work.mkdir()
    logs = work / "diagnostics"
    logs.mkdir()
    pending = work / "pending"
    pending.mkdir()
    raw = pending / "raw"
    raw.mkdir()
    inputs = pending / "sources"
    try:
        intent = {"startedAt": now(), **preflight()}
        record(logs / "intent.json", intent)
        docker_root = Path(local_output("docker", "info", "--format", "{{.DockerRootDir}}"))

        def sample(path, stage):
            data = resources(path, stage)
            with (logs / "resources.jsonl").open("a", encoding="utf8", newline="\n") as out:
                out.write(json.dumps(data) + "\n")
            return data

        first = sample(docker_root, "checkout")
        require(min(row["freeBytes"] for row in first["disk"].values()) >= LIMIT, "Insufficient initial disk space (5 GiB)")
        input_files = prepare_sources(inputs)
        sample(docker_root, "sources-acquired")
        subprocess.run(["docker", "pull", "--platform", PINS["platform"], IMAGE],
                       check=True, timeout=600)
        digest, = json.loads(local_output("docker", "image", "inspect", IMAGE))
        require(IMAGE in digest["RepoDigests"] and f'{digest["Os"]}/{digest["Architecture"]}' == PINS["platform"],
                "Docker image identity differs")
        record(logs / "image.json", {key: digest[key] for key in ("Id", "Os", "Architecture", "RepoDigests", "Size")})
        after_pull = sample(docker_root, "image-acquired")
        require(min(row["freeBytes"] for row in after_pull["disk"].values()) >= LIMIT, "Insufficient disk after image pull (5 GiB)")
        require(after_pull["memoryBytes"].get("MemAvailable", 0) >= LIMIT, "Insufficient available memory (5 GiB)")
        run_build(logs, raw, inputs / "freetype-version_1.zip", docker_root, sample)
        sample(docker_root, "build-reaped")

        staged = json.loads((raw / "build-inputs.json").read_bytes())
        occt = inputs / f'occt-{PINS["versions"]["occt"]}.tar.gz'
        header = archive_member(occt, "src/Standard/Standard_Version.hxx")
        require(facts(header) == staged["occtVersionHeader"], "Image OCCT version header differs from public source")
        (raw / "rapidjson-headers.tar.gz").rename(inputs / "rapidjson-headers.tar.gz")
        input_files["rapidjson-headers.tar.gz"] = {"origin": IMAGE, **facts((inputs / "rapidjson-headers.tar.gz").read_bytes())}
        record(inputs / "upstreams.json", input_files)
        recipe = inputs / "pointercad-iges-recipe.tar.gz"
        license_dir = pending / "licenses"
        license_dir.mkdir()
        for rel, pin in notice_pins().items():
            write_new(license_dir / Path(rel).name, checked(ROOT / rel, pin))
        with tarfile.open(recipe, "x:gz") as archive:
            for relative, pin in intent["recipeFiles"].items():
                path = ROOT / relative
                checked(path, pin)
                archive.add(path, arcname=relative, recursive=False)
        subprocess.run(["node", str(HERE / "package.mjs"), str(raw), str(pending / "vendor")],
                       cwd=ROOT, check=True)
        sample(docker_root, "ready")
        shutil.copytree(logs, pending / "diagnostics")
        seal(pending, intent, digest)
        verify(pending, intent["repository"], intent["commit"], intent["tree"], intent["run"], intent["attempt"])
        pending.rename(work / "success")
    except Exception as error:
        record(logs / "failure.json", {"status": "failure", "at": now(), "error": str(error)})
        raise


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("build")
    commands.add_parser("preflight")
    recovery = commands.add_parser("verify")
    recovery.add_argument("folder", type=Path)
    release = commands.add_parser("release-source")
    release.add_argument("folder", type=Path)
    release.add_argument("destination", type=Path)
    for command in (recovery, release):
        for flag in ("repository", "commit", "tree", "parent", "run", "attempt"):
            command.add_argument("--" + flag, required=True)
    args = parser.parse_args()
    if args.command == "build":
        hosted()
    elif args.command == "preflight":
        print(json.dumps(preflight(), sort_keys=True))
    elif args.command == "verify":
        verify(args.folder.resolve(), args.repository, args.commit, args.tree, args.parent, args.run, args.attempt)
    else:
        release_source(args.folder.resolve(), args.destination.resolve(), args.repository,
                       args.commit, args.tree, args.parent, args.run, args.attempt)
