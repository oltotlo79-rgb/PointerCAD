"""Root-only discriminating controls for the r15 recipe corrections (NOT executed by the worker). Linux (WSL) only.

    python3 -I -B replay_controls.py --new r15/rebuild-oofem-pyodide.sh --old r14/rebuild-oofem-pyodide.sh \
        --work NEW_ABSOLUTE_DIR --wheelhouse ACQUIRED_WHEELHOUSE \
        --oofem-tar F --pybind11-tar F --timer-patch F --util-patch F --venv D --emsdk-env F --xbuildenv D

Both scripts are bound by SHA-256 (new 1eb34343..., old r14 c01caeba...); anything else is refused before any run.
--work must not exist; every fixture, output folder and raw stdout/stderr/exit stays under it (nothing is deleted).
argv lists only, no shell=True. Each full-script run is `setsid --wait bash SCRIPT ...` (the recipe requires its own
process group). The real inputs are the same ones Root used for the passed source smoke; WHEELHOUSE is the directory
built from acquisition-request.json.

Cases (each has an independent expectation; the old-script cases are the negative controls that show the defect):
  E-new  failing venv python (fixture exits 9): the new script stops before any step (no logs/steps.txt).
  E-old  same fixture with the r14 script: it continues into 00-host with empty PIP_FIND_LINKS/PIP_CONSTRAINT
         (`export X="$(...)"` discarded the failure) -> steps.txt names 00-host.
  W0     new script, exact wheelhouse, --stop-after source -> exit 0, 10w-wheelhouse.exit 0, SOURCE OK.
  W1-W5  new script, wheelhouse missing one file / with an extra file / with one byte appended to a file / with a
         symlink in place of a file / with a subdirectory -> nonzero, 10w-wheelhouse.exit nonzero, 11-venv never
         started, src/ empty.
  W6     r14 script with the W1 wheelhouse (a required wheel missing) -> exit 0 and SOURCE OK: r14 accepted it.
  C-new  s_toolchain (with step, source_emsdk, emscripten_cache_count extracted verbatim) against a fixture emsdk
         whose upstream/emscripten/cache is absent -> the step exits nonzero.
  C-old  the same with the r14 functions -> the step exits 0 although the count failed (discarded by echo).
  S      step() is byte-identical in both scripts, so Root's passed step regression (fixed4 + old-defect1) still
         applies; recorded, not rerun."""
import argparse
import hashlib
import json
import os
import pathlib
import shutil
import subprocess
import sys

NEW_SHA = "1eb34343d9d97ac5d9dab563f359d8e63f56f8ec6ef9e0b3c62ce138b81684aa"
OLD_SHA = "c01caebab43eb78d39def3d8046f0840f63b9bac55e5139aa5c4bef5e0d7c0c4"

p = argparse.ArgumentParser()
for name in ("new", "old", "work", "wheelhouse", "oofem-tar", "pybind11-tar", "timer-patch", "util-patch", "venv", "emsdk-env", "xbuildenv"):
    p.add_argument("--" + name, required=True)
a = p.parse_args()
sha = lambda path: hashlib.sha256(pathlib.Path(path).read_bytes()).hexdigest()
if sha(a.new) != NEW_SHA or sha(a.old) != OLD_SHA:
    raise SystemExit("script SHA mismatch: refusing before any run")
work = pathlib.Path(a.work)
if not work.is_absolute() or work.exists():
    raise SystemExit("--work must be absolute and must not exist")
work.mkdir()
results = []


def record(case, ok, **detail):
    results.append({"case": case, "pass": bool(ok), **detail})


def run_script(script, case, args):
    out = work / f"out-{case}"
    r = subprocess.run(["setsid", "--wait", "bash", script, *args, "--out", str(out)], capture_output=True, timeout=1800)
    for suffix, data in (("stdout", r.stdout), ("stderr", r.stderr), ("exit", str(r.returncode).encode())):
        (work / f"{case}.{suffix}").write_bytes(data)
    return r.returncode, out


def read(path):
    path = pathlib.Path(path)
    return path.read_text() if path.is_file() else None


# E: export masking of file_uri.
fx = work / "fixture-e"
(fx / "venv/bin").mkdir(parents=True)
(fx / "venv/bin/python").write_text("#!/bin/sh\nexit 9\n")
os.chmod(fx / "venv/bin/python", 0o755)
for name in ("oofem.tar.gz", "pybind11.tar.gz", "timer.patch", "util.diff", "emsdk_env.sh"):
    (fx / name).write_bytes(b"fixture\n")
for name in ("xbuildenv", "wheelhouse"):
    (fx / name).mkdir()
e_args = ["--oofem-tar", str(fx / "oofem.tar.gz"), "--pybind11-tar", str(fx / "pybind11.tar.gz"), "--timer-patch", str(fx / "timer.patch"),
          "--util-patch", str(fx / "util.diff"), "--venv", str(fx / "venv"), "--emsdk-env", str(fx / "emsdk_env.sh"),
          "--xbuildenv", str(fx / "xbuildenv"), "--wheelhouse", str(fx / "wheelhouse")]
rc, out = run_script(a.new, "E-new", e_args)
record("E-new failing file_uri stops before any step", rc == 9 and not (out / "logs/steps.txt").exists(), rc=rc)
rc, out = run_script(a.old, "E-old", e_args)
steps = read(out / "logs/steps.txt") or ""
record("E-old (negative control) r14 continued into 00-host", " 00-host\n" in steps, rc=rc, steps=steps.splitlines())

# W: exact wheelhouse.
good = sorted(pathlib.Path(a.wheelhouse).iterdir())
if len(good) != 13 or not all(x.is_file() and not x.is_symlink() for x in good):
    raise SystemExit("acquired wheelhouse must hold 13 regular files")


def wheelhouse(case, mutate):
    target = work / f"wh-{case}"
    target.mkdir()
    for src in good:
        shutil.copyfile(src, target / src.name)
    mutate(target)
    return target


def append_byte(d):
    with open(d / good[0].name, "ab") as fh:
        fh.write(b"\0")


def symlink(d):
    (d / good[0].name).unlink()
    (d / good[0].name).symlink_to(good[0])


variants = {"W0": lambda d: None, "W1": lambda d: (d / good[0].name).unlink(),
            "W2": lambda d: shutil.copyfile(good[0], d / "extra-0.0-py3-none-any.whl"), "W3": append_byte,
            "W4": symlink, "W5": lambda d: (d / "subdir").mkdir()}
real = ["--oofem-tar", a.oofem_tar, "--pybind11-tar", a.pybind11_tar, "--timer-patch", a.timer_patch, "--util-patch", a.util_patch,
        "--venv", a.venv, "--emsdk-env", a.emsdk_env, "--xbuildenv", a.xbuildenv, "--jobs", "1", "--stop-after", "source"]
dirs = {}
for case, mutate in variants.items():
    dirs[case] = wheelhouse(case, mutate)
    rc, out = run_script(a.new, case, real + ["--wheelhouse", str(dirs[case])])
    exit10w = (read(out / "logs/10w-wheelhouse.exit") or "").strip()
    steps = read(out / "logs/steps.txt") or ""
    src_empty = (out / "src").is_dir() and not any((out / "src").iterdir())
    if case == "W0":
        record("W0 exact wheelhouse passes the source stage", rc == 0 and exit10w == "0" and (read(out / "logs/done.txt") or "").startswith("SOURCE OK"), rc=rc)
    else:
        record(f"{case} wheelhouse refused before 11-venv", rc != 0 and exit10w not in ("", "0") and " 11-venv\n" not in steps and src_empty, rc=rc, exit10w=exit10w)
rc, out = run_script(a.old, "W6", real + ["--wheelhouse", str(dirs["W1"])])
record("W6 (negative control) r14 accepted a wheelhouse missing a required wheel", rc == 0 and (read(out / "logs/done.txt") or "").startswith("SOURCE OK"), rc=rc)


# C: discarded emscripten cache-count failure (function-level, functions extracted verbatim).
def extract(text, name):
    lines = text.splitlines(keepends=True)
    starts = [i for i, line in enumerate(lines) if line.startswith(f"{name}() {{")]
    if len(starts) != 1:
        raise SystemExit(f"{name}: {len(starts)} definitions")
    i = starts[0]
    if lines[i].rstrip("\n").endswith("}") and lines[i].strip() != f"{name}() {{":
        return lines[i]
    return "".join(lines[i:i + lines[i:].index("}\n") + 1])


cx = work / "fixture-c"
(cx / "emsdk-without-cache").mkdir(parents=True)
(cx / "xbuildenv").mkdir()
(cx / "emsdk_env.sh").write_text(
    f"EMSDK='{cx / 'emsdk-without-cache'}'\nEMSDK_NODE=/bin/echo\nexport EMSDK EMSDK_NODE\n"
    "emcc() { if [ \"$1\" = --version ]; then echo 'emcc 4.0.9 (bbf1caa6e24f64fca9eb6a13a9e02d3f42123e77)';"
    " else echo 'clang version 21.0.0git (https:/github.com/llvm/llvm-project 2f05451198e2f222ec66cec4892ada0509519290)' >&2; fi; }\n")
harness = r'''set -Eeuo pipefail
OUT="$1"; LOG="$OUT/logs"; mkdir -p -- "$LOG"
OOFEM_TAR= PYBIND_TAR= TIMER_PATCH= UTIL_PATCH= VENV= WHEELHOUSE= JOBS=1 PIP_FIND_LINKS= PIP_CONSTRAINT= TMPDIR="$OUT"
EMSDK_ENV="$3" XBUILDENV="$4"
. "$2"
step 12-toolchain s_toolchain
'''
(cx / "harness.sh").write_text(harness)
texts = {"new": pathlib.Path(a.new).read_text(), "old": pathlib.Path(a.old).read_text()}
for which in ("new", "old"):
    defs = "".join(extract(texts[which], n) for n in ("step", "source_emsdk", "emscripten_cache_count", "s_toolchain"))
    (cx / f"{which}-functions.sh").write_text(defs)
    out = cx / f"out-{which}"
    r = subprocess.run(["bash", str(cx / "harness.sh"), str(out), str(cx / f"{which}-functions.sh"), str(cx / "emsdk_env.sh"), str(cx / "xbuildenv")],
                       capture_output=True, timeout=120)
    (cx / f"{which}.stderr").write_bytes(r.stderr)
    code = (read(out / "logs/12-toolchain.exit") or "").strip()
    if which == "new":
        record("C-new failed cache count stops the step", r.returncode != 0 and code not in ("", "0"), rc=r.returncode, exit=code)
    else:
        record("C-old (negative control) r14 step passed despite the failed count", r.returncode == 0 and code == "0", rc=r.returncode, exit=code)

record("S step() byte-identical (Root's passed step regression applies)", extract(texts["new"], "step") == extract(texts["old"], "step"))
(work / "results.json").write_text(json.dumps(results, indent=2))
print(json.dumps(results, indent=2))
sys.exit(0 if all(r["pass"] for r in results) else 1)
