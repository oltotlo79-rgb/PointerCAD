#!/usr/bin/env bash
# Portable rebuild recipe for the PointerCAD OOFEM Pyodide wheel from its corresponding source (Linux, no network).
# r15 (replay environment, see replay-environment.json): exact 13-file wheelhouse, all build requirements pinned,
# no discarded exit status in the pip/emscripten set-up, aarch64 host. This recipe is UNEXECUTED as a whole. It mirrors the actually executed native build that produced
# oofem-3.1.dev5+g214b161ed-cp313-cp313-pyodide_2025_0_wasm32.whl (aaff729b15e1cec2ef90c9c0bb2d3594b3997b523d35344b18ba9f64d4d1a7e4);
# see packet-files.json for the exact relationship. It is not that build.
#
# Usage (own process group):
#   setsid --wait bash rebuild-oofem-pyodide.sh --oofem-tar FILE --pybind11-tar FILE --timer-patch FILE \
#     --util-patch FILE --venv DIR --emsdk-env FILE --xbuildenv DIR --wheelhouse DIR --out NEW_DIR \
#     [--jobs 1..4] [--reference-wheel FILE] [--stop-after source]
#
# Paths are data only: every step is a function in this file whose code is static; arguments reach commands as
# quoted words or argv, never as program text. pip list options (find-links, constraint) get percent-encoded
# file:// URIs, because pip splits those environment values on whitespace.
#
# What is installed, and where: this script runs no direct install and no download. `pyodide build` performs an
# isolated PEP 517 build, which installs the build requirements into its own temporary environment, resolved only
# from --wheelhouse (PIP_NO_INDEX=1), which must hold exactly the 13 files listed in s_wheelhouse (step 10w). TMPDIR, pip cache and XDG cache all point under --out, so that environment
# and every temporary file are created under --out. The one exception is the Emscripten compiler cache inside
# the supplied toolchain (emcc may populate it); its file count is logged before and after the build.
#
# --out must not exist; nothing is deleted; the first failing step stops the run and keeps all partial output.
set -Eeuo pipefail
umask 022
die() { printf 'rebuild-oofem-pyodide: %s\n' "$*" >&2; exit 64; }

OOFEM_TAR='' PYBIND_TAR='' TIMER_PATCH='' UTIL_PATCH='' VENV='' EMSDK_ENV='' XBUILDENV='' WHEELHOUSE='' OUT=''
JOBS=4 REFERENCE_WHEEL='' STOP_AFTER=''
while [ "$#" -gt 0 ]; do
  [ "$#" -ge 2 ] || die "missing value for $1"
  case "$1" in
    --oofem-tar) OOFEM_TAR=$2 ;; --pybind11-tar) PYBIND_TAR=$2 ;; --timer-patch) TIMER_PATCH=$2 ;;
    --util-patch) UTIL_PATCH=$2 ;; --venv) VENV=$2 ;; --emsdk-env) EMSDK_ENV=$2 ;; --xbuildenv) XBUILDENV=$2 ;;
    --wheelhouse) WHEELHOUSE=$2 ;; --out) OUT=$2 ;; --jobs) JOBS=$2 ;; --reference-wheel) REFERENCE_WHEEL=$2 ;;
    --stop-after) STOP_AFTER=$2 ;;
    *) die "unknown option $1" ;;
  esac
  shift 2
done
for value in "$OOFEM_TAR" "$PYBIND_TAR" "$TIMER_PATCH" "$UTIL_PATCH" "$VENV" "$EMSDK_ENV" "$XBUILDENV" "$WHEELHOUSE" "$OUT"; do
  [ -n "$value" ] || die 'all of --oofem-tar --pybind11-tar --timer-patch --util-patch --venv --emsdk-env --xbuildenv --wheelhouse --out are required'
  case "$value" in /*) ;; *) die "path must be absolute: $value" ;; esac
  case "$value" in *$'\n'*) die 'paths must not contain a newline' ;; esac
done
case "$JOBS" in 1|2|3|4) ;; *) die '--jobs must be 1..4' ;; esac
case "$STOP_AFTER" in ''|source) ;; *) die '--stop-after accepts only: source' ;; esac
for file in "$OOFEM_TAR" "$PYBIND_TAR" "$TIMER_PATCH" "$UTIL_PATCH" "$EMSDK_ENV"; do [ -f "$file" ] || die "not a file: $file"; done
for dir in "$VENV" "$XBUILDENV" "$WHEELHOUSE"; do [ -d "$dir" ] || die "not a directory: $dir"; done
[ -z "$REFERENCE_WHEEL" ] || [ -f "$REFERENCE_WHEEL" ] || die "not a file: $REFERENCE_WHEEL"
[ -x "$VENV/bin/python" ] || die "not an executable venv python: $VENV/bin/python"
[ ! -e "$OUT" ] && [ ! -L "$OUT" ] || die "output already exists: $OUT"
[ -d "$(dirname -- "$OUT")" ] || die "output parent does not exist: $(dirname -- "$OUT")"
[ "$(ps -o pgid= -p "$$" | tr -d ' ')" = "$$" ] || die 'run in its own process group: setsid --wait bash rebuild-oofem-pyodide.sh ...'
CURRENT=none
on_signal() {
  trap '' INT TERM
  if [ -d "$OUT/logs" ]; then printf '%s INTERRUPTED %s during %s\n' "$(date --iso-8601=seconds)" "$1" "$CURRENT" >> "$OUT/logs/steps.txt"; fi
  kill -TERM -- "-$$"
  if [ "$1" = INT ]; then exit 130; fi
  exit 143
}
trap 'on_signal INT' INT
trap 'on_signal TERM' TERM
mkdir -- "$OUT"                                      # exclusive: never reuses an earlier output
LOG="$OUT/logs"; mkdir -- "$LOG" "$OUT/src" "$OUT/dist" "$OUT/cache" "$OUT/tmp"
PY="$VENV/bin/python"
file_uri() { "$PY" -I -B -c 'import pathlib, sys; print(pathlib.Path(sys.argv[1]).as_uri())' "$1"; }
# Every isolated build requirement is pinned (r15 replay-environment.json); the wheelhouse holds exactly these.
printf '%s\n' 'cmake==4.4.4' 'iniconfig==2.3.1' 'ninja==1.13.2' 'packaging==26.3' 'pathspec==1.1.1' 'pluggy==1.6.0' 'pybind11==3.1.0' 'pygments==2.21.0' 'pytest==9.1.1' 'scikit-build-core==0.11.6' 'setuptools==84.0.0' 'setuptools-scm==10.3.4' 'vcs-versioning==2.6.0' > "$OUT/constraints.txt"
# Plain assignments: errexit applies, so a failing file_uri stops here (an `export X="$(...)"` would discard it).
FIND_LINKS_URI=$(file_uri "$WHEELHOUSE")
CONSTRAINT_URI=$(file_uri "$OUT/constraints.txt")
case "$FIND_LINKS_URI" in file:///*) ;; *) die "bad wheelhouse URI: $FIND_LINKS_URI" ;; esac
case "$CONSTRAINT_URI" in file:///*) ;; *) die "bad constraint URI: $CONSTRAINT_URI" ;; esac
export TMPDIR="$OUT/tmp" PIP_CACHE_DIR="$OUT/cache/pip" XDG_CACHE_HOME="$OUT/cache" PIP_DISABLE_PIP_VERSION_CHECK=1
export PIP_NO_INDEX=1 PIP_FIND_LINKS="$FIND_LINKS_URI" PIP_CONSTRAINT="$CONSTRAINT_URI"
export GIT_CEILING_DIRECTORIES="$OUT/src"            # git apply never re-roots onto an enclosing repository
export CMAKE_BUILD_PARALLEL_LEVEL="$JOBS" PYODIDE_JOBS="$JOBS"
SRC="$OUT/src/oofem-oofem-214b161"

step() {
  local name=$1; shift
  CURRENT=$name
  printf '%s %s\n' "$(date --iso-8601=seconds)" "$name" >> "$LOG/steps.txt"
  # The exact command: the step function's static code plus the quoted values it reads.
  { printf '%q ' "$@"; echo; declare -f "$1"
    printf '# %s=%q\n' OOFEM_TAR "$OOFEM_TAR" PYBIND_TAR "$PYBIND_TAR" TIMER_PATCH "$TIMER_PATCH" UTIL_PATCH "$UTIL_PATCH" \
      VENV "$VENV" EMSDK_ENV "$EMSDK_ENV" XBUILDENV "$XBUILDENV" WHEELHOUSE "$WHEELHOUSE" OUT "$OUT" JOBS "$JOBS" \
      PIP_FIND_LINKS "$PIP_FIND_LINKS" PIP_CONSTRAINT "$PIP_CONSTRAINT" TMPDIR "$TMPDIR"; } > "$LOG/$name.command"
  # The step function runs in an explicit subshell that re-enables errexit (and errtrace, nounset, pipefail) itself:
  # a background child would otherwise inherit `set +e`, and a failing command followed by a succeeding one would
  # make the step exit 0. The parent disables errexit only around `wait`, to record the exit code. The subshell stays
  # in this script's process group, so on_signal's group kill still reaches it.
  ( set -Eeuo pipefail; "$@" ) 0<&0 > "$LOG/$name.stdout" 2> "$LOG/$name.stderr" &
  local pid=$!
  set +e
  wait "$pid"
  local rc=$?
  set -e
  echo "$rc" > "$LOG/$name.exit"
  if [ "$rc" -ne 0 ]; then echo "FAILED $name exit $rc (see $LOG/$name.stderr)" >&2; exit "$rc"; fi
}
# Reads the file through stdin, so the file name is never parsed by sha256sum.
expect_sha() {
  local actual
  actual=$(sha256sum < "$1" | cut -d' ' -f1)
  [ "$actual" = "$2" ] || { printf 'SHA mismatch for %s: %s != %s\n' "$1" "$actual" "$2" >&2; return 1; }
  printf '%s  %s OK\n' "$2" "$1"
}
source_emsdk() { . "$EMSDK_ENV" >/dev/null || { echo 'emsdk_env.sh failed' >&2; return 1; }; }
emscripten_cache_count() { find "$EMSDK/upstream/emscripten/cache" -type f | wc -l; }

s_host() {
  uname -a
  [ "$(uname -m)" = aarch64 ] || { echo 'the r15 wheelhouse (cmake/ninja) is aarch64-only' >&2; return 1; }
  local t
  for t in git sha256sum nice setsid ps find cut grep wc tr sort nproc; do command -v "$t" || { echo "MISSING $t" >&2; return 1; }; done
  nproc
}
s_inputs() {
  expect_sha "$OOFEM_TAR" 4688f06a4b0235dcb30b79e0ca086df5b271cd3206ab6dbce869ebe6b708b6c5
  expect_sha "$PYBIND_TAR" e171d6cd4f855f65e7e12129d4a594999310b7549a737d80aa1ebf3adee32e9b
  expect_sha "$TIMER_PATCH" 12a365db2c908fff736f2bd6ac606bafbfdc6fd82686c3f6c9b761d533eaa2f6
  expect_sha "$UTIL_PATCH" 1b0cc4f061c46070f1967ef019991e96f38b2409068435365db964b2402f48fd
}
# Exactly these regular files, byte-exact (r15 wheelhouse-SHA256SUMS); no other entry, symlink or directory.
s_wheelhouse() {
  local sums names listed others
  sums=$(cat <<'SUMS'
b3029f586853e01ddf2824c1ff124a1c5284f8ae897994758e9c4eeb45903b58  cmake-4.4.4-py3-none-manylinux2014_aarch64.manylinux_2_17_aarch64.whl
9121e2c1fdb355232495be3194c8dfe87ccc2d5dee45947b78e68f499790d7a7  iniconfig-2.3.1-py3-none-any.whl
d775a5e43e9088f507a6250d57fcf5678eb31268c545feb5064ffeee33735622  ninja-1.13.2-py3-none-manylinux2014_aarch64.manylinux_2_17_aarch64.whl
d7193f7c8e4e93f444fde0262bf90af30e16fa0ad0ad44cb553c87339b23cd1c  packaging-26.3-py3-none-any.whl
a00ce642f577bf7f473932318056212bc4f8bfdf53128c78bbd5af0b9b20b189  pathspec-1.1.1-py3-none-any.whl
e920276dd6813095e9377c0bc5566d94c932c33b27a3e3945d8389c374dd4746  pluggy-1.6.0-py3-none-any.whl
b8488090f8acffbcb6b5d6a85571a6827a0a2981ffb75e5a0b27b87c4a6b7dd0  pybind11-3.1.0-py3-none-any.whl
2363c69b61c4a97c838da3b130dcd6468f4848992b21a82f2a63ec34377137d9  pygments-2.21.0-py3-none-any.whl
37a86b45efb9a47a61a36449063e8e18d0cab3161329fc099eb21783169c4f0c  pytest-9.1.1-py3-none-any.whl
ce6d8fe64e6b4c759ea0fb95d2f8a68f60d2df31c2989838633b8ec930736360  scikit_build_core-0.11.6-py3-none-any.whl
51a52592b3b99e102b609654876bd65f19f999935166d1352678931132b0c670  setuptools-84.0.0-py3-none-any.whl
82f34c3e3084fc2b57d397200637cc13f2338004052d2fee47baa5f0e902464e  setuptools_scm-10.3.4-py3-none-any.whl
f8bebd1302ebc12e67ceb30fc7dd698ec969414b6fa43b30c3f14ac9b1e72c41  vcs_versioning-2.6.0-py3-none-any.whl
SUMS
)
  names=$(printf '%s\n' "$sums" | cut -c67- | LC_ALL=C sort)
  listed=$(find "$WHEELHOUSE" -mindepth 1 -maxdepth 1 -type f -printf '%f\n' | LC_ALL=C sort)
  others=$(find "$WHEELHOUSE" -mindepth 1 -maxdepth 1 ! -type f -printf '%f\n')
  [ -z "$others" ] || { printf 'wheelhouse has non-regular entries:\n%s\n' "$others" >&2; return 1; }
  [ "$listed" = "$names" ] || { printf 'wheelhouse file set differs\nexpected:\n%s\nfound:\n%s\n' "$names" "$listed" >&2; return 1; }
  ( cd -- "$WHEELHOUSE" && printf '%s\n' "$sums" | sha256sum --check --strict - )
}
s_venv() {
  "$PY" -I -B - <<'PYEOF'
import sys
from importlib.metadata import distributions
assert sys.version_info[:3] == (3, 13, 2), sys.version
want = {'annotated-doc': '0.0.5', 'annotated-types': '0.8.0', 'anyio': '4.15.1', 'auditwheel-emscripten': '0.2.5',
        'build': '1.2.2.post1', 'certifi': '2026.7.22', 'charset-normalizer': '3.5.2', 'click': '8.3.1',
        'distlib': '0.4.3', 'filelock': '4.1.0', 'h11': '0.16.0', 'httpcore': '1.0.9', 'httpx': '0.28.1',
        'idna': '3.20', 'leb128': '1.0.9', 'markdown-it-py': '4.2.0', 'mdurl': '0.1.2', 'packaging': '26.3',
        'pathspec': '1.1.1', 'pip': '24.3.1', 'platformdirs': '4.13.0', 'pydantic': '2.14.0',
        'pydantic-core': '2.50.0', 'pygments': '2.21.0', 'pyodide-build': '0.31.1', 'pyodide-cli': '0.5.0',
        'pyodide-lock': '0.1.3', 'pyproject-hooks': '1.3.3', 'python-discovery': '1.6.2', 'requests': '2.34.2',
        'resolvelib': '1.2.1', 'rich': '15.0.0', 'ruamel-yaml': '0.19.1', 'scikit-build-core': '0.11.6',
        'shellingham': '1.5.4', 'typer': '0.25.1', 'typing-inspection': '0.4.4', 'typing-extensions': '4.16.0',
        'unearth': '0.18.3', 'urllib3': '2.8.0', 'virtualenv': '21.14.6', 'wheel': '0.48.0'}
norm = lambda n: n.lower().replace('_', '-').replace('.', '-')
have = {norm(d.metadata['Name']): d.version for d in distributions()}
want = {norm(k): v for k, v in want.items()}
diff = {k: (want.get(k), have.get(k)) for k in sorted(set(want) | set(have)) if want.get(k) != have.get(k)}
print(sys.version, len(have), 'distributions')
assert not diff, f'venv differs from the recorded post-repair venv: {diff}'
PYEOF
}
s_toolchain() {
  source_emsdk
  emcc --version | grep -F '4.0.9 (bbf1caa6e24f64fca9eb6a13a9e02d3f42123e77)'
  emcc -v 2>&1 | grep -F 'llvm-project 2f05451198e2f222ec66cec4892ada0509519290'
  "$EMSDK_NODE" --version
  local count
  count=$(emscripten_cache_count)
  echo "emscripten cache files before: $count"
  ls -la -- "$XBUILDENV"
}
# tarfile 'data' filter: no absolute paths, no .., no device files; exactly the expected top directory.
s_extract() {
  "$PY" -I -B - "$OOFEM_TAR" "$PYBIND_TAR" "$OUT/src" <<'PYEOF'
import pathlib, sys, tarfile
oofem, pybind, dest = sys.argv[1], sys.argv[2], pathlib.Path(sys.argv[3])
with tarfile.open(oofem) as t:
    tops = {m.name.split('/', 1)[0] for m in t.getmembers()}
    assert tops == {'oofem-oofem-214b161'}, tops
    t.extractall(dest, filter='data')
target = dest / 'oofem-oofem-214b161' / 'extern' / 'pybind11'
assert target.is_dir() and not any(target.iterdir()), 'extern/pybind11 must be the empty gitlink directory'
with tarfile.open(pybind) as t:
    members = t.getmembers()
    tops = {m.name.split('/', 1)[0] for m in members}
    assert len(tops) == 1, tops
    top = tops.pop()
    keep = []
    for m in members:
        if m.name != top:
            m.name = m.name[len(top) + 1:]
            keep.append(m)
    t.extractall(target, members=keep, filter='data')
assert (target / 'CMakeLists.txt').is_file()
print('extracted oofem-oofem-214b161 and pybind11 from', top)
PYEOF
}
s_timer_patch() {
  cd -- "$SRC"
  expect_sha src/core/timer.h 8532eb86b5dbd3a89e079c33cae0abbb6bfcb9648f3e616470ef6f62954e7bfb
  expect_sha src/core/timer.C ceb5190500dc5fceed79058bb80419f8245319bec0c4b22ec123e006f9914cfc
  expect_sha src/core/engngm.C c64727ff7dfd4ef70760b0ce94ee952ba3c780e3493683383f70ffad9ae9b069
  expect_sha src/core/outputexportmodule.C 3e990965a60d2f53ea87c05e3829a30ae0a7bd89945e346c2fcfa9e8140aba2f
  expect_sha src/core/solutionstatusexportmodule.C a3164db32e77add24ba9913e36fb00c96d008d6bac317b1b8f7356e76fa7b665
  git apply --check --verbose -- "$TIMER_PATCH"
  git apply --verbose -- "$TIMER_PATCH"
  expect_sha src/core/timer.h d00caf0752d9df49dd5fb755f746d707e795f03fc94657849bb1a7673e9b82ae
  expect_sha src/core/timer.C deb3c9a78fd35885fa7f35b5fabff461def1bd69daef7eb6c68d041e9fab5db2
  expect_sha src/core/engngm.C 94979bcb2e1acbcfca619a4ea7a64e947f1a393b3f41f3164df8637946ad8fa1
  expect_sha src/core/outputexportmodule.C 36040e5b7fdd2e8ef67d0ac3af7f71f589ae3ac1e4161dbe0420b8257d93d104
  expect_sha src/core/solutionstatusexportmodule.C 3ccb1dd7932cb1fdbfa53e0b8ea16cbf92e8c5b64114344a628bd0f10626d32a
}
s_util_patch() {
  cd -- "$SRC"
  expect_sha bindings/python/oofem/util.py 448e766badcbcda63f9481e124e9f5d3d7fb02511ed2f8817640831812a09323
  git apply --check --verbose -- "$UTIL_PATCH"
  git apply --verbose -- "$UTIL_PATCH"
  expect_sha bindings/python/oofem/util.py d443986373a3a2aca6cd903e464941d417236607eceb66991f41f2224868e692
}
# USE_IML=OFF is passed explicitly; USE_DSS is OFF by default and checked below; SM/FM/TM/MPM come from pyproject.toml.
s_build() {
  source_emsdk
  cd -- "$SRC"
  SETUPTOOLS_SCM_PRETEND_VERSION=3.1.dev5+g214b161ed nice -n 10 "$VENV/bin/pyodide" build . \
    --outdir "$OUT/dist" --xbuildenv-path "$XBUILDENV" \
    --config-setting cmake.define.USE_IML=OFF --config-setting "build-dir=$OUT/skbuild"
}
s_configuration() {
  local line
  for line in USE_IML:BOOL=OFF USE_DSS:BOOL=OFF USE_SM:BOOL=1 USE_FM:BOOL=1 USE_TM:BOOL=1 USE_MPM:BOOL=1 \
    USE_PYBIND_BINDINGS:BOOL=1 USE_SHARED_LIB:BOOL=0 USE_OOFEM_EXE:BOOL=0 CMAKE_BUILD_TYPE:STRING=Release; do
    grep -x -- "$line" "$OUT/skbuild/CMakeCache.txt"
  done
  grep -F -- '*** scikit-build-core 0.11.6 using CMake 4.4.4 (wheel)' "$LOG/50-build.stdout"
  grep -F -- 'Ninja version: 1.13.2' "$LOG/50-build.stderr"
  source_emsdk
  local count
  count=$(emscripten_cache_count)
  echo "emscripten cache files after: $count"
}
s_wheel() {
  "$PY" -I -B - "$OUT/dist" "$REFERENCE_WHEEL" <<'PYEOF'
import hashlib, json, pathlib, sys, zipfile
dist, reference = pathlib.Path(sys.argv[1]), sys.argv[2]
wheels = sorted(dist.glob('*.whl'))
assert [w.name for w in wheels] == ['oofem-3.1.dev5+g214b161ed-cp313-cp313-pyodide_2025_0_wasm32.whl'], wheels
w = wheels[0]
sha = lambda b: hashlib.sha256(b).hexdigest()
def members(path):
    with zipfile.ZipFile(path) as z:
        return {i.filename: z.read(i) for i in z.infolist()}
built = members(w)
module = built['oofem/oofempy.so']
assert module[:4] == b'\0asm', 'oofempy.so is not WebAssembly'
assert module.count(b'IMLSolver') == 0, 'USE_IML=OFF did not take effect'
assert sha(built['oofem/util.py']) == 'd443986373a3a2aca6cd903e464941d417236607eceb66991f41f2224868e692'
record = {'wheel': w.name, 'wheelSha256': sha(w.read_bytes()), 'moduleSha256': sha(module), 'moduleBytes': len(module),
          'members': {name: sha(data) for name, data in sorted(built.items())}}
if reference:
    ref_bytes = pathlib.Path(reference).read_bytes()
    ref = members(pathlib.Path(reference))
    # Reported in layers and never asserted; a byte difference alone is not a failure and not an ABI/API statement.
    record['comparison'] = {
        'referenceWheelSha256': sha(ref_bytes), 'wheelBytesIdentical': record['wheelSha256'] == sha(ref_bytes),
        'memberNamesIdentical': sorted(built) == sorted(ref),
        'membersWithDifferentBytes': sorted(n for n in set(built) & set(ref) if built[n] != ref[n]),
        'moduleBytesIdentical': module == ref.get('oofem/oofempy.so')}
print(json.dumps(record, indent=2))
PYEOF
}
s_provenance() {
  "$PY" -I -B - "$OUT" <<'PYEOF'
import hashlib, json, pathlib, sys
out = pathlib.Path(sys.argv[1])
sha = lambda p: hashlib.sha256(p.read_bytes()).hexdigest()
logs = sorted(p for p in (out / 'logs').iterdir()
              if p.is_file() and p.name != 'steps.txt' and not p.name.startswith('61-'))  # this step is still writing
record = {'schema': 'pointercad-oofem-portable-rebuild/1', 'executedRecipe': 'rebuild-oofem-pyodide.sh',
          'wheel': json.loads((out / 'logs/60-wheel.stdout').read_text()),
          'configuration': (out / 'logs/51-configuration.stdout').read_text().splitlines(),
          'logs': {p.name: sha(p) for p in logs}}
data = json.dumps(record, indent=2).encode('utf-8')
with open(out / 'rebuild-provenance.json', 'xb') as fh:
    fh.write(data)
print(hashlib.sha256(data).hexdigest(), 'rebuild-provenance.json')
PYEOF
}

step 00-host s_host
step 10-inputs s_inputs
step 10w-wheelhouse s_wheelhouse
step 11-venv s_venv
step 12-toolchain s_toolchain
step 20-extract s_extract
step 30-timer-patch s_timer_patch
step 31-util-patch s_util_patch
if [ "$STOP_AFTER" = source ]; then
  CURRENT=done
  echo "SOURCE OK $(date --iso-8601=seconds)" > "$LOG/done.txt"
  exit 0
fi
step 50-build s_build
step 51-configuration s_configuration
step 60-wheel s_wheel
step 61-provenance s_provenance
CURRENT=done
echo "REBUILD OK $(date --iso-8601=seconds)" > "$LOG/done.txt"
