#!/usr/bin/env bash
# Root-only packet-6: build-only continuation (steps 39..62) of the existing native task after Sol's acquisition 28..35.
# Usage (inside WSL, own process group), after reading the digest printed by `admission.py digest <task>`:
#   setsid --wait bash build.sh <prior-log-evidence-digest>
# No CPython/venv/download/xbuildenv/emsdk recreation. Every step writes raw stdout/stderr/exit under
# <task>/logs/build-r1 (created exclusively) and the run stops at the first non-zero exit. Prior logs are never
# written; step 39 admits them by digest before any source extraction and step 62 proves them unchanged.
# Corresponding-source changes, both pinned and checked before and after: packet-5/v2 Timer patch and the peer's r8
# util.py lazy-matplotlib patch. USE_IML=OFF stays required. This is not a whole-source legal clearance.
set -Eeuo pipefail
umask 022
[ "$#" -eq 1 ] && [[ "$1" =~ ^[0-9a-f]{64}$ ]] || { echo 'usage: build.sh <64-hex prior-log evidence digest>' >&2; exit 64; }
DIGEST=$1
REPO=/mnt/c/Users/oltot/Documents/git-projects/PointerCAD
TASK=/home/yuya/pcad-oofem-rebuild-20261011-2136
PK5="$REPO/scratchpad/claude/agents/pcad_opus_fastening_core/before/beam-transient-r1/runtime-source-completion-r1/native-rebuild-r1/packet-5"
PK6="$REPO/scratchpad/claude/agents/pcad_opus_fastening_core/before/beam-transient-r1/runtime-source-completion-r1/native-rebuild-r1/packet-6"
R8="$REPO/scratchpad/claude/agents/pcad_opus_extrude_core/before/weld-beads-r1/ci-review-1/composite-license-review-1/r8"
[ "$(ps -o pgid= -p $$ | tr -d ' ')" = "$$" ] || { echo 'own process group required: setsid --wait bash build.sh ...' >&2; exit 64; }
CURRENT=none
LOG="$TASK/logs/build-r1"
on_signal() {
  # Disarm first so the group TERM cannot re-enter, record if the log exists, kill only the owned group, exit.
  trap '' INT TERM
  if [ -d "$LOG" ]; then
    printf '%s INTERRUPTED %s during %s\n' "$(date --iso-8601=seconds)" "$1" "$CURRENT" >> "$LOG/steps.txt"
  fi
  kill -TERM -- "-$$"
  if [ "$1" = INT ]; then exit 130; fi
  exit 143
}
trap 'on_signal INT' INT
trap 'on_signal TERM' TERM
[ ! -L "$TASK" ] && [ "$(realpath "$TASK")" = "$TASK" ] && [ -d "$TASK/logs/continuation-r1" ] || { echo 'task or acquisition log missing' >&2; exit 64; }
mkdir "$LOG"                                    # exclusive: never reuse or overwrite a previous build attempt
export PIP_CACHE_DIR="$TASK/cache/pip" XDG_CACHE_HOME="$TASK/cache" PIP_DISABLE_PIP_VERSION_CHECK=1
# git apply must act on the extracted tree itself, never on a repository discovered above it (it would re-root paths).
export GIT_CEILING_DIRECTORIES="$TASK/src"
# Bounded concurrency for the measured 15.7 GB WSL shared with the user's ORI3 work (not all 12 cores).
JOBS=4
export CMAKE_BUILD_PARALLEL_LEVEL=$JOBS PYODIDE_JOBS=$JOBS
step() {
  local name=$1; shift
  CURRENT=$name
  printf '%s %s\n' "$(date --iso-8601=seconds)" "$name" >> "$LOG/steps.txt"
  set +e
  "$@" 0<&0 > "$LOG/$name.stdout" 2> "$LOG/$name.stderr" &
  local pid=$!
  wait "$pid"
  local rc=$?
  set -e
  echo "$rc" > "$LOG/$name.exit"
  if [ "$rc" -ne 0 ]; then echo "FAILED $name exit $rc" >&2; exit "$rc"; fi
}
expect_sha() { echo "$2  $1" | sha256sum -c -; }
PY="$TASK/venv/bin/python"
ADMISSION_SHA=b082079c7504767c7d3d396ca03924bbf590d10988a3b1b5c4dda7f4ed7395b7

# 39. Admission before any source mutation: pinned admission code, then actual acquisition evidence, venv, repo pins,
#     prior-log digest and fresh build state (admission.py docstring).
step 39-admission bash -e -o pipefail -c "
  $(declare -f expect_sha)
  expect_sha '$PK6/admission.py' $ADMISSION_SHA
  '$PY' -I -B '$PK6/admission.py' admit '$TASK' '$REPO' $DIGEST"

# 40. Retained source inputs, exact bytes.
OOFEM="$REPO/scratchpad/claude/agents/cx_v103_fem_runtime_astra/before/source/oofem-214b161ed3acb471f2d0104b004c37fd73bafaa2.tar.gz"
PYBIND="$REPO/scratchpad/claude/agents/cx_v103_fem_runtime_astra/before/distribution-r4/downloads/pybind11-d6ae0e163a6fb414c81c7f4a98291460e5a18bfe.tar.gz"
step 40-inputs bash -e -o pipefail -c "
  $(declare -f expect_sha)
  expect_sha '$OOFEM'  4688f06a4b0235dcb30b79e0ca086df5b271cd3206ab6dbce869ebe6b708b6c5
  expect_sha '$PYBIND' e171d6cd4f855f65e7e12129d4a594999310b7549a737d80aa1ebf3adee32e9b"

# 41-42. Source tree: exact OOFEM 051 plus the exact pybind11 gitlink d6ae0e1 placed in extern/pybind11 (empty in 051).
step 41-extract-oofem tar -xzf "$OOFEM" -C "$TASK/src"
SRC="$TASK/src/oofem-oofem-214b161"
step 42-extract-pybind11 bash -e -o pipefail -c "rmdir '$SRC/extern/pybind11'
  mkdir '$SRC/extern/pybind11'
  tar -xzf '$PYBIND' -C '$SRC/extern/pybind11' --strip-components=1
  test -f '$SRC/extern/pybind11/CMakeLists.txt'"

# 43. Timer corresponding-source patch (packet-5/v2): parents, apply, exact results.
step 43-timer-patch bash -e -o pipefail -c "
  echo '12a365db2c908fff736f2bd6ac606bafbfdc6fd82686c3f6c9b761d533eaa2f6  $PK5/v2/oofem-051-timer.patch' | sha256sum -c -
  cd '$SRC'
  echo '8532eb86b5dbd3a89e079c33cae0abbb6bfcb9648f3e616470ef6f62954e7bfb  src/core/timer.h' | sha256sum -c -
  echo 'ceb5190500dc5fceed79058bb80419f8245319bec0c4b22ec123e006f9914cfc  src/core/timer.C' | sha256sum -c -
  echo 'c64727ff7dfd4ef70760b0ce94ee952ba3c780e3493683383f70ffad9ae9b069  src/core/engngm.C' | sha256sum -c -
  echo '3e990965a60d2f53ea87c05e3829a30ae0a7bd89945e346c2fcfa9e8140aba2f  src/core/outputexportmodule.C' | sha256sum -c -
  echo 'a3164db32e77add24ba9913e36fb00c96d008d6bac317b1b8f7356e76fa7b665  src/core/solutionstatusexportmodule.C' | sha256sum -c -
  git apply --check --verbose '$PK5/v2/oofem-051-timer.patch'
  git apply --verbose '$PK5/v2/oofem-051-timer.patch'
  echo 'd00caf0752d9df49dd5fb755f746d707e795f03fc94657849bb1a7673e9b82ae  src/core/timer.h' | sha256sum -c -
  echo 'deb3c9a78fd35885fa7f35b5fabff461def1bd69daef7eb6c68d041e9fab5db2  src/core/timer.C' | sha256sum -c -
  echo '94979bcb2e1acbcfca619a4ea7a64e947f1a393b3f41f3164df8637946ad8fa1  src/core/engngm.C' | sha256sum -c -
  echo '36040e5b7fdd2e8ef67d0ac3af7f71f589ae3ac1e4161dbe0420b8257d93d104  src/core/outputexportmodule.C' | sha256sum -c -
  echo '3ccb1dd7932cb1fdbfa53e0b8ea16cbf92e8c5b64114344a628bd0f10626d32a  src/core/solutionstatusexportmodule.C' | sha256sum -c -"

# 44. util.py lazy-matplotlib patch (peer r8): parent, apply, exact result, then both resulting paths on the patched
#     source: setupDomain has no matplotlib dependency at module level; both plotting helpers keep their bodies and
#     import matplotlib themselves (AST, no import of the module).
step 44-util-patch bash -e -o pipefail -c "
  echo '1b0cc4f061c46070f1967ef019991e96f38b2409068435365db964b2402f48fd  $R8/oofem-util.py.diff' | sha256sum -c -
  cd '$SRC'
  echo '448e766badcbcda63f9481e124e9f5d3d7fb02511ed2f8817640831812a09323  bindings/python/oofem/util.py' | sha256sum -c -
  git apply --check --verbose '$R8/oofem-util.py.diff'
  git apply --verbose '$R8/oofem-util.py.diff'
  echo 'd443986373a3a2aca6cd903e464941d417236607eceb66991f41f2224868e692  bindings/python/oofem/util.py' | sha256sum -c -"
step 44b-util-paths "$PY" -I -B - "$SRC/bindings/python/oofem/util.py" <<'PYEOF'
import ast, sys
tree = ast.parse(open(sys.argv[1], encoding='utf-8').read())
MPL = {'matplotlib', 'matplotlib.pyplot', 'matplotlib.tri'}
is_mpl = lambda n: isinstance(n, ast.Import) and {a.name for a in n.names} <= MPL
assert not any(is_mpl(n) for n in tree.body), 'module-level matplotlib import remains'
funcs = {n.name: n for n in tree.body if isinstance(n, ast.FunctionDef)}
assert sorted(funcs) == ['plot1Dmesh', 'plot2Dmesh', 'setupDomain'], sorted(funcs)
for name in ('plot2Dmesh', 'plot1Dmesh'):
    imports = sorted(a.name for s in funcs[name].body if is_mpl(s) for a in s.names)
    assert imports == sorted(MPL), (name, imports)
assert not any(is_mpl(s) for s in ast.walk(funcs['setupDomain'])), 'setupDomain imports matplotlib'
print('util.py: no module-level matplotlib; setupDomain independent; plot2Dmesh and plot1Dmesh import it lazily')
PYEOF

# 45-46. Focused Timer proof on the shipped target (em++ + node from the same emsdk) before the long build:
#        patched tree must pass; the unchanged parent (packet-5/v2/parents) is the negative control and must fail
#        exactly the deterministic old defects (stop of a never-started timer, repeated stop, 60 s boundary).
step 45-timer-proof bash -e -o pipefail -c "
  echo '81fb586747848df51ba40f0acaf3ec42c20a4a64d880db6bf454b8094ccc986f  $PK5/proof/timer_proof.cpp' | sha256sum -c -
  echo 'd0b50488fc5d31fc487dd57ac14fe27ffa2175712219c901c5ac5c65025dfd83  $PK5/proof/include/oofemenv.h' | sha256sum -c -
  . \"\$(cat '$TASK/emsdk_env_path')\" >/dev/null || { echo 'emsdk_env.sh failed' >&2; exit 1; }
  test -n \"\$EMSDK_NODE\"
  mkdir '$TASK/proof'
  em++ -std=c++17 -O1 -Wall -Wextra -Werror -I '$PK5/proof/include' -I '$SRC/src/core' \
    '$PK5/proof/timer_proof.cpp' '$SRC/src/core/timer.C' -o '$TASK/proof/timer_proof.js'
  \"\$EMSDK_NODE\" '$TASK/proof/timer_proof.js'"
step 46-timer-proof-parent-control bash -e -o pipefail -c "
  echo 'ceb5190500dc5fceed79058bb80419f8245319bec0c4b22ec123e006f9914cfc  $PK5/v2/parents/src/core/timer.C' | sha256sum -c -
  echo '8532eb86b5dbd3a89e079c33cae0abbb6bfcb9648f3e616470ef6f62954e7bfb  $PK5/v2/parents/src/core/timer.h' | sha256sum -c -
  . \"\$(cat '$TASK/emsdk_env_path')\" >/dev/null || { echo 'emsdk_env.sh failed' >&2; exit 1; }
  em++ -std=c++17 -O1 -DPCAD_PROOF_PARENT -I '$PK5/proof/include' -I '$PK5/v2/parents/src/core' \
    '$PK5/proof/timer_proof.cpp' '$PK5/v2/parents/src/core/timer.C' -o '$TASK/proof/timer_parent.js'
  set +e
  \"\$EMSDK_NODE\" '$TASK/proof/timer_parent.js' > '$TASK/proof/timer_parent.out' 2>&1
  rc=\$?
  set -e
  cat '$TASK/proof/timer_parent.out'
  echo \"parentExit \$rc\"
  test \"\$rc\" -eq 1
  grep -F 'FAIL P2 stop/pause of a never-started timer adds nothing' '$TASK/proof/timer_parent.out'
  grep -F 'FAIL P3 repeated stop/pause leaves the total unchanged' '$TASK/proof/timer_parent.out'
  grep -F 'FAIL P7 60 s is one minute' '$TASK/proof/timer_parent.out'"
step 47-toolchain-record bash -e -o pipefail -c ". \"\$(cat '$TASK/emsdk_env_path')\" >/dev/null || { echo 'emsdk_env.sh failed' >&2; exit 1; }
  command -v emcc em++
  emcc --version
  em++ -v 2>&1 | grep -F 'clang version'
  \"\$EMSDK_NODE\" --version"
step 49-constraints bash -e -o pipefail -c "printf 'scikit-build-core==0.11.6\n' > '$TASK/constraints.txt'; cat '$TASK/constraints.txt'"

# 50. Build from the patched source. USE_IML=OFF: iml/*.C (IMLSolver, ST_IML) are compiled only under USE_IML
#     (src/core/CMakeLists.txt:59-65); LinearStatic defaults to ST_Direct (linearstatic.C:64) and no supplied driver
#     sets lstype. The define reaches CMake as a scikit-build-core config setting; build-dir keeps CMakeCache.txt local.
step 50-build bash -e -o pipefail -c ". \"\$(cat '$TASK/emsdk_env_path')\" >/dev/null || { echo 'emsdk_env.sh failed' >&2; exit 1; }
  cd '$SRC'
  SETUPTOOLS_SCM_PRETEND_VERSION=3.1.dev5+g214b161ed PIP_CONSTRAINT='$TASK/constraints.txt' \
  nice -n 10 '$TASK/venv/bin/pyodide' build . --outdir '$TASK/dist' --xbuildenv-path '$TASK/xbuildenv' \
  --config-setting cmake.define.USE_IML=OFF --config-setting build-dir='$TASK/skbuild'"
step 51-cmake-config bash -e -o pipefail -c "grep -x 'USE_IML:BOOL=OFF' '$TASK/skbuild/CMakeCache.txt'
  grep -E '^(USE_PYBIND_BINDINGS|USE_SHARED_LIB|USE_SM|USE_FM|USE_TM|USE_MPM|USE_OOFEM_EXE|USE_DSS):BOOL=' '$TASK/skbuild/CMakeCache.txt'
  grep -E '^CMAKE_(CXX_COMPILER|BUILD_TYPE):' '$TASK/skbuild/CMakeCache.txt'"

# 60. Wheel identity: tag, WebAssembly module, no IMLSolver code, patched Timer text present, patched util.py.
step 60-wheel "$PY" -I -B - "$TASK/dist" "$REPO/packages/fem/runtime/assets/oofem-3.0-cp313-cp313-pyodide_2025_0_wasm32.whl" <<'PYEOF'
import hashlib, pathlib, sys, zipfile, json
dist, shipped = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2])
wheels = sorted(dist.glob('oofem-*.whl'))
assert len(wheels) == 1, wheels
w = wheels[0]
assert w.name.endswith('-cp313-cp313-pyodide_2025_0_wasm32.whl'), w.name
def module(path):
    with zipfile.ZipFile(path) as z:
        data, util = z.read('oofem/oofempy.so'), z.read('oofem/util.py')
        return {'sha256': hashlib.sha256(data).hexdigest(), 'bytes': len(data), 'wasm': data[:4] == b'\0asm',
                'IMLSolverMarkers': data.count(b'IMLSolver'), 'notAvailableMarkers': data.count(b'not available'),
                'utilSha256': hashlib.sha256(util).hexdigest()}
rebuilt, original = module(w), module(shipped)
assert rebuilt['wasm'], 'rebuilt oofempy.so is not WebAssembly'
assert rebuilt['IMLSolverMarkers'] == 0, 'USE_IML=OFF did not take effect'
assert rebuilt['notAvailableMarkers'] >= 1, 'patched Timer::formatHMS text missing from the module'
assert rebuilt['utilSha256'] == 'd443986373a3a2aca6cd903e464941d417236607eceb66991f41f2224868e692', 'wheel util.py is not the patched one'
print(json.dumps({'wheel': w.name, 'wheelSha256': hashlib.sha256(w.read_bytes()).hexdigest(), 'rebuiltModule': rebuilt,
                  'shippedModule': original, 'moduleBytesIdentical': rebuilt['sha256'] == original['sha256']}, indent=2))
PYEOF

# 61. Corresponding-source record next to (not inside) dist/: both patches, the Timer provenance and a build
#     provenance binding pinned original source, patches, wheel and toolchain evidence. Flags are not changed here.
step 61-source-provenance bash -e -o pipefail -c "mkdir '$TASK/dist-source'
  cp '$PK5/v2/oofem-051-timer.patch' '$PK5/v2/patch-provenance.json' '$R8/oofem-util.py.diff' '$TASK/dist-source/'
  '$PY' -I -B - '$TASK' <<'PYEOF'
import hashlib, json, pathlib, sys, zipfile
task = pathlib.Path(sys.argv[1]); out = task / 'dist-source'
sha = lambda p: hashlib.sha256(p.read_bytes()).hexdigest()
w = sorted((task / 'dist').glob('oofem-*.whl'))[0]
cont = task / 'logs/continuation-r1'
cache = (task / 'skbuild/CMakeCache.txt').read_text(encoding='utf-8', errors='replace').splitlines()
with zipfile.ZipFile(w) as z:
    module = hashlib.sha256(z.read('oofem/oofempy.so')).hexdigest()
record = {
    'schema': 'pointercad-oofem-native-build-provenance/1',
    'originalSource': {'oofemTarballSha256': '4688f06a4b0235dcb30b79e0ca086df5b271cd3206ab6dbce869ebe6b708b6c5',
                       'commit': '214b161ed3acb471f2d0104b004c37fd73bafaa2',
                       'pybind11TarballSha256': 'e171d6cd4f855f65e7e12129d4a594999310b7549a737d80aa1ebf3adee32e9b',
                       'pybind11Commit': 'd6ae0e163a6fb414c81c7f4a98291460e5a18bfe'},
    'patches': [
        {'file': 'oofem-051-timer.patch', 'sha256': sha(out / 'oofem-051-timer.patch'), 'strip': 1,
         'files': json.loads((out / 'patch-provenance.json').read_text())['files']},
        {'file': 'oofem-util.py.diff', 'sha256': sha(out / 'oofem-util.py.diff'), 'strip': 1,
         'files': {'bindings/python/oofem/util.py': {
             'parentSha256': '448e766badcbcda63f9481e124e9f5d3d7fb02511ed2f8817640831812a09323',
             'patchedSha256': 'd443986373a3a2aca6cd903e464941d417236607eceb66991f41f2224868e692'}}}],
    'configuration': {'USE_IML': 'OFF', 'cmakeCache': [l for l in cache if l.split(':', 1)[0] in (
        'USE_IML', 'USE_PYBIND_BINDINGS', 'USE_SHARED_LIB', 'USE_SM', 'USE_FM', 'USE_TM', 'USE_MPM', 'USE_OOFEM_EXE',
        'USE_DSS', 'CMAKE_CXX_COMPILER', 'CMAKE_BUILD_TYPE')]},
    'toolchain': {'emsdkHead': (cont / '35-emsdk-provenance.stdout').read_text().splitlines()[0],
                  'emsdkProvenanceStdoutSha256': sha(cont / '35-emsdk-provenance.stdout'),
                  'emccVersionStdoutSha256': sha(cont / '34-emcc-version.stdout'),
                  'buildToolchainRecordSha256': sha(task / 'logs/build-r1/47-toolchain-record.stdout'),
                  'venvFreezeSha256': sha(task / 'logs/cli-compatibility-r1/02-after.stdout'),
                  'preRepairVenvFreezeSha256': sha(task / 'logs/22-pip-freeze.stdout'),
                  'buildLogStdoutSha256': sha(task / 'logs/build-r1/50-build.stdout'),
                  'buildLogStderrSha256': sha(task / 'logs/build-r1/50-build.stderr')},
    'output': {'wheel': w.name, 'wheelSha256': sha(w), 'moduleSha256': module},
    'limits': ['emsdk revision is the default branch cloned by pyodide-build (recorded, not pinned)',
               'isolated build-environment packages are recorded only in the step 50 log',
               'USE_IML=OFF and these patches are not a whole-source legal clearance'],
}
data = json.dumps(record, indent=2).encode('utf-8')
with open(out / 'build-provenance.json', 'xb') as fh:
    fh.write(data)
print(data.decode('utf-8'))
PYEOF
  cd '$TASK/dist-source'
  sha256sum oofem-051-timer.patch patch-provenance.json oofem-util.py.diff build-provenance.json"

# 62. Every prior log is byte-identical to admission time.
step 62-prior-logs-unchanged "$PY" -I -B "$PK6/admission.py" unchanged "$TASK" "$DIGEST"
CURRENT=done
echo "BUILD OK $(date --iso-8601=seconds)" > "$LOG/done.txt"
