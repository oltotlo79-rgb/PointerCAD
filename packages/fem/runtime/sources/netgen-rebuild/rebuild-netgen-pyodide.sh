#!/usr/bin/env bash
# Portable reconstruction / modified-source replacement recipe for the PointerCAD Netgen Pyodide wheel
# netgen_mesher-6.2.2606.post5.dev0-cp313-cp313-pyodide_2025_0_wasm32.whl (Linux aarch64, no network).
# UNEXECUTED as a whole. It replays the r4 build (sources/netgen-654ed121-build-r4-recipe.zip build.sh/audit.py) from
# the bytes retained in this distribution instead of the historical /mnt/c scratchpad packet and WSL home paths.
# It is not the r4 build and does not claim byte identity with the shipped wheel (compared, never asserted).
#
# Usage (own process group):
#   setsid --wait bash rebuild-netgen-pyodide.sh --variant original|modified \
#     --netgen-tar FILE --pybind11-tar FILE --zlib-tar FILE --zconf FILE --recipe-zip FILE \
#     --venv DIR --emsdk-env FILE --xbuildenv DIR --em-cache DIR --wheelhouse DIR --out NEW_DIR \
#     [--marker-patch FILE] [--reference-wheel FILE] [--jobs 1..4] [--stop-after source]
#
# --variant modified requires --marker-patch (netgen-replacement-marker.patch); original refuses it.
# --wheelhouse is any directory holding the two exact tool wheels below (for example the OOFEM portable 13-file
#   wheelhouse, sources/native-rebuild/portable/wheelhouse-SHA256SUMS lists the same two SHA-256 values).
# --em-cache is the Emscripten 4.0.9 cache of the supplied emsdk; it is copied once under --out and used with
#   EM_FROZEN_CACHE=1, so a missing target library fails instead of being generated or downloaded.
# Paths are data only; every step is a static function; --out must not exist; nothing is deleted; the first failing
# step stops the run and keeps all partial output.
set -Eeuo pipefail
umask 022
die() { printf 'rebuild-netgen-pyodide: %s\n' "$*" >&2; exit 64; }
HERE=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
HELPER="$HERE/netgen_rebuild_steps.py" PINS="$HERE/pins.json"

VARIANT='' NETGEN_TAR='' PYBIND_TAR='' ZLIB_TAR='' ZCONF='' RECIPE_ZIP='' VENV='' EMSDK_ENV='' XBUILDENV='' EM_CACHE_IN=''
WHEELHOUSE='' OUT='' MARKER_PATCH='' REFERENCE_WHEEL='' JOBS=4 STOP_AFTER=''
while [ "$#" -gt 0 ]; do
  [ "$#" -ge 2 ] || die "missing value for $1"
  case "$1" in
    --variant) VARIANT=$2 ;; --netgen-tar) NETGEN_TAR=$2 ;; --pybind11-tar) PYBIND_TAR=$2 ;; --zlib-tar) ZLIB_TAR=$2 ;;
    --zconf) ZCONF=$2 ;; --recipe-zip) RECIPE_ZIP=$2 ;; --venv) VENV=$2 ;; --emsdk-env) EMSDK_ENV=$2 ;;
    --xbuildenv) XBUILDENV=$2 ;; --em-cache) EM_CACHE_IN=$2 ;; --wheelhouse) WHEELHOUSE=$2 ;; --out) OUT=$2 ;;
    --marker-patch) MARKER_PATCH=$2 ;; --reference-wheel) REFERENCE_WHEEL=$2 ;; --jobs) JOBS=$2 ;;
    --stop-after) STOP_AFTER=$2 ;;
    *) die "unknown option $1" ;;
  esac
  shift 2
done
case "$VARIANT" in original) [ -z "$MARKER_PATCH" ] || die '--variant original refuses --marker-patch' ;;
  modified) [ -n "$MARKER_PATCH" ] || die '--variant modified requires --marker-patch' ;;
  *) die '--variant must be original or modified' ;; esac
for value in "$NETGEN_TAR" "$PYBIND_TAR" "$ZLIB_TAR" "$ZCONF" "$RECIPE_ZIP" "$VENV" "$EMSDK_ENV" "$XBUILDENV" "$EM_CACHE_IN" "$WHEELHOUSE" "$OUT"; do
  [ -n "$value" ] || die 'all of --netgen-tar --pybind11-tar --zlib-tar --zconf --recipe-zip --venv --emsdk-env --xbuildenv --em-cache --wheelhouse --out are required'
  case "$value" in /*) ;; *) die "path must be absolute: $value" ;; esac
  case "$value" in *$'\n'*) die 'paths must not contain a newline' ;; esac
done
for value in "$MARKER_PATCH" "$REFERENCE_WHEEL"; do
  [ -z "$value" ] || case "$value" in /*) ;; *) die "path must be absolute: $value" ;; esac
done
case "$JOBS" in 1|2|3|4) ;; *) die '--jobs must be 1..4' ;; esac
case "$STOP_AFTER" in ''|source) ;; *) die '--stop-after accepts only: source' ;; esac
for file in "$NETGEN_TAR" "$PYBIND_TAR" "$ZLIB_TAR" "$ZCONF" "$RECIPE_ZIP" "$EMSDK_ENV" "$HELPER" "$PINS"; do [ -f "$file" ] || die "not a file: $file"; done
for dir in "$VENV" "$XBUILDENV" "$EM_CACHE_IN" "$WHEELHOUSE"; do [ -d "$dir" ] && [ ! -L "$dir" ] || die "not a real directory: $dir"; done
[ -z "$MARKER_PATCH" ] || [ -f "$MARKER_PATCH" ] || die "not a file: $MARKER_PATCH"
[ -z "$REFERENCE_WHEEL" ] || [ -f "$REFERENCE_WHEEL" ] || die "not a file: $REFERENCE_WHEEL"
[ -x "$VENV/bin/python" ] && [ -x "$VENV/bin/pyodide" ] || die "venv must provide bin/python and bin/pyodide: $VENV"
[ ! -e "$OUT" ] && [ ! -L "$OUT" ] || die "output already exists: $OUT"
[ -d "$(dirname -- "$OUT")" ] || die "output parent does not exist: $(dirname -- "$OUT")"
[ "$(ps -o pgid= -p "$$" | tr -d ' ')" = "$$" ] || die 'run in its own process group: setsid --wait bash rebuild-netgen-pyodide.sh ...'
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
LOG="$OUT/logs"; mkdir -- "$LOG" "$OUT/objects" "$OUT/target" "$OUT/target/lib" "$OUT/target/include" "$OUT/dist" "$OUT/cache" "$OUT/tmp" "$OUT/tools"
PY="$VENV/bin/python"
export PYTHONDONTWRITEBYTECODE=1 PIP_NO_INDEX=1 PIP_DISABLE_PIP_VERSION_CHECK=1
export TMPDIR="$OUT/tmp" TEMP="$OUT/tmp" TMP="$OUT/tmp" PIP_CACHE_DIR="$OUT/cache/pip" XDG_CACHE_HOME="$OUT/cache"
export GIT_CEILING_DIRECTORIES="$OUT/src"            # git apply never re-roots onto an enclosing repository
export CMAKE_BUILD_PARALLEL_LEVEL="$JOBS" PYODIDE_JOBS="$JOBS"
unset CMAKE_ARGS SKBUILD_CMAKE_ARGS CFLAGS CXXFLAGS LDFLAGS CC CXX AR RANLIB CMAKE_TOOLCHAIN_FILE PYTHONPATH PYTHONHOME PYODIDE_ROOT NETGEN_ARCH NETGEN_MPI

step() {
  local name=$1; shift
  CURRENT=$name
  printf '%s %s\n' "$(date --iso-8601=seconds)" "$name" >> "$LOG/steps.txt"
  { printf '%q ' "$@"; echo; declare -f "$1" 2>/dev/null || true
    printf '# %s=%q\n' VARIANT "$VARIANT" NETGEN_TAR "$NETGEN_TAR" PYBIND_TAR "$PYBIND_TAR" ZLIB_TAR "$ZLIB_TAR" ZCONF "$ZCONF" \
      RECIPE_ZIP "$RECIPE_ZIP" VENV "$VENV" EMSDK_ENV "$EMSDK_ENV" XBUILDENV "$XBUILDENV" EM_CACHE_IN "$EM_CACHE_IN" \
      WHEELHOUSE "$WHEELHOUSE" MARKER_PATCH "$MARKER_PATCH" OUT "$OUT" JOBS "$JOBS"; } > "$LOG/$name.command"
  ( set -Eeuo pipefail; "$@" ) 0<&0 > "$LOG/$name.stdout" 2> "$LOG/$name.stderr" &
  local pid=$!
  set +e
  wait "$pid"
  local rc=$?
  set -e
  echo "$rc" > "$LOG/$name.exit"
  if [ "$rc" -ne 0 ]; then echo "FAILED $name exit $rc (see $LOG/$name.stderr)" >&2; exit "$rc"; fi
}
expect_sha() {
  local actual
  actual=$(sha256sum < "$1" | cut -d' ' -f1)
  [ "$actual" = "$2" ] || { printf 'SHA mismatch for %s: %s != %s\n' "$1" "$actual" "$2" >&2; return 1; }
  printf '%s  %s OK\n' "$2" "$1"
}
helper() { "$PY" -I -B "$HELPER" "$@"; }
source_emsdk() { . "$EMSDK_ENV" >/dev/null || { echo 'emsdk_env.sh failed' >&2; return 1; }; export EM_CACHE="$OUT/cache/emscripten" EM_FROZEN_CACHE=1; }

s_host() {
  uname -a
  [ "$(uname -m)" = aarch64 ] || { echo 'the pinned cmake/ninja tool wheels are Linux aarch64 only' >&2; return 1; }
  local t
  for t in git sha256sum nice setsid ps find cut grep wc tr sort nproc; do command -v "$t" || { echo "MISSING $t" >&2; return 1; }; done
  nproc
}
s_inputs() {
  expect_sha "$HELPER" 52f93713eedecba9c9eb6b05f7b8e8fb567f2940a0a34052de34cc81f704ac5e
  expect_sha "$PINS" 1ddc3333a600e1e61bc85a46bd411da10c043d8c2be66a52ecc0e8035227548b
  expect_sha "$NETGEN_TAR" 4ad944f59dea9d198d11e12485f6ac93f8226eb314d58dec98e7e790fc46feee
  expect_sha "$PYBIND_TAR" e84c2929c340a59eef985dc31e309f290982de8617d9aeb7b77c123c4bb044a4
  expect_sha "$ZLIB_TAR" 17e88863f3600672ab49182f217281b6fc4d3c762bde361935e436a95214d05c
  expect_sha "$ZCONF" 77304005ceb5f0d03ad4c37eb8386a10866e4ceeb204f7c3b6599834c7319541
  expect_sha "$RECIPE_ZIP" a5e6ff23a1c8f300b6955074701bc9229f5187d0fee0f09a20a165c044b2f761
  if [ -n "$MARKER_PATCH" ]; then expect_sha "$MARKER_PATCH" f50252df94ae725290a3436763f9e2e2f9529b5b6836d6d60f6c7ca5b0cfec6a; fi
  if [ -n "$REFERENCE_WHEEL" ]; then expect_sha "$REFERENCE_WHEEL" 3f0d507e8daa11b5a26654d904c529d6c1338e9a3a4c7d7728152f3596954ba3; fi
}
# Exactly one regular file per tool wheel SHA-256; other wheelhouse entries are ignored and never installed.
s_tools() {
  local name sum binary binsum wheel found
  while read -r name sum binary binsum; do
    found=''
    for wheel in "$WHEELHOUSE"/*.whl; do
      [ -f "$wheel" ] && [ ! -L "$wheel" ] || continue
      if [ "$(sha256sum < "$wheel" | cut -d' ' -f1)" = "$sum" ]; then [ -z "$found" ] || { echo "duplicate $name wheel" >&2; return 1; }; found=$wheel; fi
    done
    [ -n "$found" ] || { echo "missing $name tool wheel $sum" >&2; return 1; }
    mkdir -- "$OUT/tools/$name"
    # CMake keeps cmake/data; ninja extracts exactly its pinned single member.
    "$PY" -I -B - "$found" "$OUT/tools/$name" "$name" "$binary" <<'PYTOOLS'
import pathlib, shutil, stat, sys, zipfile
root = pathlib.Path(sys.argv[2]).resolve(strict=True)
with zipfile.ZipFile(sys.argv[1]) as wheel:
    selected = [row for row in wheel.infolist() if (row.filename.startswith('cmake/data/')
                if sys.argv[3] == 'cmake' else row.filename == sys.argv[4])]
    assert selected and (sys.argv[3] == 'cmake' or len(selected) == 1), 'pinned tool wheel member missing or duplicated'
    names = set()
    for row in selected:
        relative = pathlib.PurePosixPath(row.filename)
        assert not relative.is_absolute() and '..' not in relative.parts and chr(92) not in row.filename
        assert row.filename not in names, 'duplicate CMake wheel member'
        names.add(row.filename)
        mode = stat.S_IFMT(row.external_attr >> 16)
        assert mode in (0, stat.S_IFREG, stat.S_IFDIR), 'CMake wheel link/device refused'
        target = root.joinpath(*relative.parts)
        assert target.resolve().is_relative_to(root), 'CMake extraction escape'
        if row.is_dir():
            target.mkdir(parents=True, exist_ok=True)
        else:
            target.parent.mkdir(parents=True, exist_ok=True)
            with wheel.open(row) as src, target.open('xb') as dst:
                shutil.copyfileobj(src, dst)
PYTOOLS
    expect_sha "$OUT/tools/$name/$binary" "$binsum"
    chmod 0755 -- "$OUT/tools/$name/$binary"
  done <<'TOOLS'
ninja d775a5e43e9088f507a6250d57fcf5678eb31268c545feb5064ffeee33735622 ninja-1.13.2.data/scripts/ninja 9285b2ae95bc241bcb22e06d50d2290429e001bd7cb1d3fb95dde0f9127609d8
cmake b3029f586853e01ddf2824c1ff124a1c5284f8ae897994758e9c4eeb45903b58 cmake/data/bin/cmake 7cdd347255e8ca723a1adae40d9dafa101ebf3181dc1d8fe6d03d1ca47c21597
TOOLS
  local modules=( "$OUT"/tools/cmake/cmake/data/share/cmake-*/Modules/CMakeDetermineSystem.cmake )
  [ "${#modules[@]}" -eq 1 ] && [ -f "${modules[0]}" ] || { echo 'CMake Modules tree missing or ambiguous' >&2; return 1; }
  "$OUT/tools/cmake/cmake/data/bin/cmake" --version | grep -Fx 'cmake version 4.4.4'
  "$OUT/tools/ninja/ninja-1.13.2.data/scripts/ninja" --version | grep -Fx '1.13.2.git.kitware.jobserver-pipe-1'
}
s_venv() {
  "$PY" -I -B - <<'PYEOF'
import sys
from importlib.metadata import distributions
assert sys.version_info[:3] == (3, 13, 2), sys.version
norm = lambda n: n.lower().replace('_', '-').replace('.', '-')
have = {norm(d.metadata['Name']): d.version for d in distributions()}
# --no-isolation build (r4): these come from the venv itself, not a wheelhouse.
want = {'pyodide-build': '0.31.1', 'scikit-build-core': '0.11.6', 'packaging': '26.3', 'pathspec': '1.1.1'}
diff = {k: (v, have.get(norm(k))) for k, v in want.items() if have.get(norm(k)) != v}
print(sys.version, len(have), 'distributions')
assert not diff, f'venv differs: {diff}'
PYEOF
}
s_xbuildenv() { helper xbuildenv "$OUT" "$XBUILDENV"; }
s_toolchain() {
  [ -d "$EM_CACHE_IN/sysroot" ] || { echo 'supplied Emscripten cache has no sysroot; no download permitted' >&2; return 1; }
  cp -R --no-dereference -- "$EM_CACHE_IN" "$OUT/cache/emscripten"   # owned copy; the supplied cache is not written
  find "$OUT/cache/emscripten" -type f | wc -l
  source_emsdk
  emcc --version | grep -F '4.0.9 (bbf1caa6e24f64fca9eb6a13a9e02d3f42123e77)'
  emcc -v 2>&1 | grep -F 'llvm-project 2f05451198e2f222ec66cec4892ada0509519290'
  ls -la -- "$XBUILDENV"
}
s_extract() { helper extract "$OUT" "$NETGEN_TAR" "$PYBIND_TAR" "$ZLIB_TAR"; }
s_packaging() { helper packaging "$OUT" "$RECIPE_ZIP" "$ZCONF"; }
s_marker() {
  cd -- "$OUT/src/netgen"
  git apply --check --verbose -- "$MARKER_PATCH"
  git apply --verbose -- "$MARKER_PATCH"
  helper marker "$OUT"
}
s_snapshot() { helper snapshot "$OUT"; }
s_zlib() {
  source_emsdk
  local name objects=()
  cp -- "$OUT/src/zlib/zlib.h" "$OUT/src/zlib/zconf.h" "$OUT/target/include/"
  for name in adler32 compress crc32 deflate gzclose gzlib gzread gzwrite infback inffast inflate inftrees trees uncompr zutil; do
    emcc -O2 -fPIC -Wno-deprecated-non-prototype -I "$OUT/src/zlib" -c "$OUT/src/zlib/$name.c" -o "$OUT/objects/$name.o"
    objects+=("$OUT/objects/$name.o")
  done
  emar rcs "$OUT/target/lib/libz.a" "${objects[@]}"
  helper objects "$OUT"
}
s_build() {
  source_emsdk
  export PATH="$OUT/tools/cmake/cmake/data/bin:$OUT/tools/ninja/ninja-1.13.2.data/scripts:$PATH"
  local args=()
  while IFS= read -r line; do args+=(--config-setting "cmake.define.${line//@OUT@/$OUT}"); done <<'DEFINES'
USE_SUPERBUILD=OFF
USE_OCC=OFF
USE_GUI=OFF
USE_MPI=OFF
USE_MPI_WRAPPER=OFF
USE_NATIVE_ARCH=OFF
USE_PYTHON=ON
USE_SPDLOG=OFF
USE_NUMA=OFF
USE_JPEG=OFF
USE_MPEG=OFF
USE_CGNS=OFF
USE_CCACHE=OFF
BUILD_STUB_FILES=OFF
ENABLE_UNIT_TESTS=OFF
BUILD_FOR_CONDA=ON
PREFER_SYSTEM_PYBIND11=OFF
NG_INSTALL_DIR_PYTHON=.
NG_INSTALL_DIR_LIB=.
NETGEN_VERSION_GIT=v6.2.2606-5-g654ed121
NETGEN_VERSION_PYTHON=6.2.2606.post5.dev0
BUILD_ZLIB=OFF
ZLIB_INCLUDE_DIRS=@OUT@/target/include
ZLIB_LIBRARIES=@OUT@/target/lib/libz.a
ZLIB_USE_STATIC_LIBS=ON
CMAKE_BUILD_TYPE=Release
DEFINES
  cd -- "$OUT/src/netgen"
  nice -n 10 "$VENV/bin/pyodide" build . --no-isolation --xbuildenv-path "$XBUILDENV" --outdir "$OUT/dist" \
    --config-setting "build-dir=$OUT/skbuild" "${args[@]}"
}
s_configure() { helper configure "$OUT" "$XBUILDENV"; }
s_wheel() { helper wheel "$OUT" "$VARIANT" "$REFERENCE_WHEEL"; }
s_provenance() { helper provenance "$OUT"; }

step 00-host s_host
step 10-inputs s_inputs
step 20-extract s_extract
step 21-packaging s_packaging
if [ "$VARIANT" = modified ]; then step 22-marker s_marker; fi
step 23-snapshot s_snapshot
if [ "$STOP_AFTER" = source ]; then
  CURRENT=done
  echo "SOURCE OK $VARIANT $(date --iso-8601=seconds)" > "$LOG/done.txt"
  exit 0
fi
step 11-tools s_tools
step 12-venv s_venv
step 14-xbuildenv s_xbuildenv
step 13-toolchain s_toolchain
step 30-zlib s_zlib
step 50-build s_build
step 51-configure s_configure
step 60-wheel s_wheel
step 61-provenance s_provenance
CURRENT=done
echo "REBUILD OK $VARIANT $(date --iso-8601=seconds); product-loader replacement still unexecuted" > "$LOG/done.txt"
