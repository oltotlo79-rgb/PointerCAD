"""Standard-library steps for rebuild-netgen-pyodide.sh (Linux, no network, no package imports).

Every expected byte identity comes from pins.json next to this file; the shell script pins both files by SHA-256
before any step. Paths are argv data only. Each subcommand writes only under the given --out directory.

  extract    OUT NETGEN_TAR PYBIND_TAR ZLIB_TAR      safe extraction (no links/devices/escapes, exact top dirs)
  packaging  OUT RECIPE_ZIP ZCONF                    exact r4 packaging: pyproject.toml, ng/CMakeLists.txt, zconf.h
  marker     OUT                                     verify the marker patch result (modified variant only)
  snapshot   OUT                                     source tree SHA-256 list before the build
  objects    OUT                                     15 zlib objects are WebAssembly, libz.a is an ar archive
  configure  OUT XBUILDENV                           effective CMake cache, link graph, compiler wrapper settings
  wheel      OUT VARIANT [REFERENCE_WHEEL]           wheel/module set, dylink needed, config flags, marker count
  provenance OUT                                     rebuild-provenance.json (exclusive create)
"""
import ast
import hashlib
import json
import os
import pathlib
import re
import shutil
import sys
import tarfile
import zipfile
from pathlib import PurePosixPath

HERE = pathlib.Path(__file__).resolve().parent
PINS = json.loads((HERE / "pins.json").read_text(encoding="utf-8"))
sha = lambda data: hashlib.sha256(data).hexdigest()


def require(condition, message):
    if not condition:
        raise SystemExit("netgen-rebuild: " + message)


def file_sha(path):
    return sha(pathlib.Path(path).read_bytes())


def write_new(path, value):
    with open(path, "x", encoding="utf-8", newline="\n") as stream:
        json.dump(value, stream, indent=2, allow_nan=False)
        stream.write("\n")


def safe_extract(archive, target, top):
    require(not target.exists(), "source target already exists: " + str(target))
    with tarfile.open(archive, "r:gz") as source:
        members = source.getmembers()
        names = set()
        for member in members:
            p = PurePosixPath(member.name)
            require(not p.is_absolute() and ".." not in p.parts and "\\" not in member.name, "unsafe archive path")
            require(p.parts and p.parts[0] == top, "wrong archive root: " + member.name)
            require(member.isdir() or member.isfile(), "archive link/device refused: " + member.name)
            require(member.name not in names, "duplicate archive member: " + member.name)
            names.add(member.name)
        target.mkdir(parents=True)
        for member in members:
            parts = PurePosixPath(member.name).parts[1:]
            if not parts:
                continue
            dest = target.joinpath(*parts)
            require(dest.resolve().is_relative_to(target.resolve()), "extraction escape")
            if member.isdir():
                dest.mkdir(parents=True, exist_ok=True)
            else:
                dest.parent.mkdir(parents=True, exist_ok=True)
                with source.extractfile(member) as src, dest.open("xb") as dst:
                    shutil.copyfileobj(src, dst)
    return len(members)


def tree(root):
    result = {}
    for current, directories, files in os.walk(root, followlinks=False):
        for name in directories + files:
            require(not (pathlib.Path(current) / name).is_symlink(), "unexpected link: " + str(pathlib.Path(current) / name))
        for name in files:
            p = pathlib.Path(current) / name
            result[p.relative_to(root).as_posix()] = file_sha(p)
    return result


def extract(out, netgen_tar, pybind_tar, zlib_tar):
    src = out / "src"
    counts = {"netgen": safe_extract(netgen_tar, src / "netgen", PINS["netgenTop"])}
    gitlink = src / "netgen/external_dependencies/pybind11"
    require(gitlink.is_dir() and not any(gitlink.iterdir()), "external_dependencies/pybind11 must be the empty gitlink")
    gitlink.rmdir()  # empty placeholder only
    counts["pybind11"] = safe_extract(pybind_tar, gitlink, PINS["pybindTop"])
    counts["zlib"] = safe_extract(zlib_tar, src / "zlib", PINS["zlibTop"])
    print(json.dumps({"extracted": counts}))


def packaging(out, recipe_zip, zconf):
    src, record = out / "src", out / "dist-source"
    record.mkdir()
    members = {}
    with zipfile.ZipFile(recipe_zip) as z:
        for name, digest in PINS["recipeMembers"].items():
            data = z.read(name)
            require(sha(data) == digest, "recipe member differs: " + name)
            members[name] = data
    project = src / "netgen/pyproject.toml"
    require(file_sha(project) == PINS["upstreamPyprojectSha256"], "upstream pyproject.toml differs")
    shutil.copyfile(project, record / "upstream-pyproject.toml")
    project.write_bytes(members["pyproject.toml"])
    for name, digest in PINS["nativeLinkSourcePins"].items():
        require(file_sha(src / "netgen" / name) == digest, "native link source differs: " + name)
    # r4 target_linkage.py, applied as an exact single replacement (its own module is pinned above; not executed).
    ng = src / "netgen/ng/CMakeLists.txt"
    before = ng.read_bytes()
    link = PINS["ngLinkPatch"]
    old, new = link["old"].encode("utf-8"), link["new"].encode("utf-8")
    require(before.count(old) == 1, "ngpy original link declaration multiplicity changed")
    after = before.replace(old, new, 1)
    require(sha(after) == link["afterSha256"], "patched ng/CMakeLists.txt differs")
    shutil.copyfile(ng, record / "upstream-ng-CMakeLists.txt")
    ng.write_bytes(after)
    zsrc = src / "zlib/zconf.h"
    require(file_sha(zsrc) == PINS["upstreamZconfSha256"], "upstream zlib zconf.h differs")
    require(file_sha(zconf) == PINS["targetZconfSha256"], "target zconf.h differs")
    shutil.copyfile(zsrc, record / "upstream-zconf.h")
    shutil.copyfile(zconf, zsrc)
    (out / "packet").mkdir()
    for name, data in members.items():
        (out / "packet" / name).write_bytes(data)
    print(json.dumps({"pyproject": PINS["recipeMembers"]["pyproject.toml"], "ngCMakeLists": link["afterSha256"],
                      "zconf": PINS["targetZconfSha256"]}))


def marker(out):
    marker_pin = PINS["marker"]
    path = out / "src/netgen" / marker_pin["file"]
    require(file_sha(path) == marker_pin["afterSha256"], "marker patch result differs")
    print(json.dumps({"marker": marker_pin["file"], "sha256": marker_pin["afterSha256"]}))


def snapshot(out):
    files = tree(out / "src")
    write_new(out / "dist-source/source-before-build.json", files)
    print(json.dumps({"sourceFiles": len(files)}))


def objects(out):
    found = sorted((out / "objects").glob("*.o"))
    require(len(found) == 15, "zlib object count differs from the 15 port sources")
    for p in found:
        require(p.read_bytes()[:8] == b"\x00asm\x01\x00\x00\x00", "not a WebAssembly object: " + p.name)
    require((out / "target/lib/libz.a").read_bytes()[:8] == b"!<arch>\n", "libz.a is not an ar archive")
    write_new(out / "dist-source/zlib-target.json", {"objects": {p.name: file_sha(p) for p in found},
                                                     "librarySha256": file_sha(out / "target/lib/libz.a")})
    print(json.dumps({"objects": len(found)}))


def link_libraries(ninja, target):
    blocks = re.findall(r"^build " + re.escape(target) + r":[^\n]*\n((?:[ \t]+[^\n]*\n)*)", ninja, flags=re.MULTILINE)
    require(len(blocks) == 1, "missing or ambiguous native link target: " + target)
    lines = [line.strip()[len("LINK_LIBRARIES = "):] for line in blocks[0].splitlines()
             if line.strip().startswith("LINK_LIBRARIES = ")]
    require(len(lines) == 1, "missing or ambiguous LINK_LIBRARIES: " + target)
    return lines[0].split()


def xbuildenv_root(xbuildenv):
    try:
        base = pathlib.Path(xbuildenv).resolve(strict=True)
        require(base.is_dir(), "--xbuildenv must resolve to a directory")
        roots = set()
        for candidate in base.glob("*/xbuildenv/pyodide-root"):
            actual = candidate.resolve(strict=True)
            require(actual.is_relative_to(base) and actual.is_dir(), "pyodide-root outside --xbuildenv or not a directory")
            roots.add(actual)
    except (OSError, RuntimeError) as error:
        raise SystemExit("netgen-rebuild: invalid xbuildenv path: " + str(error)) from error
    require(len(roots) == 1, "expected exactly one real pyodide-root under --xbuildenv")
    return next(iter(roots))


def configure(out, xbuildenv):
    cache = {}
    for line in (out / "skbuild/CMakeCache.txt").read_text().splitlines():
        if line and not line.startswith(("#", "//")) and ":" in line and "=" in line:
            left, value = line.split("=", 1)
            cache[left.split(":", 1)[0]] = value
    for name, value in PINS["cmakeDefinitions"].items():
        value = value.replace("@OUT@", str(out))
        require(cache.get(name) == value, "CMake effective setting mismatch: " + name)
    require("pywasmcross" in cache.get("CMAKE_CXX_COMPILER", ""), "host C++ compiler refused")
    ninja = (out / "skbuild/build.ninja").read_text()
    zlib = str(out / "target/lib/libz.a")
    ngpy, nglib = link_libraries(ninja, "ng/libngpy.so"), link_libraries(ninja, "libnglib.so")
    require(not any("libz.a" in item or item == "-lz" for item in ngpy), "ngpy must not enumerate a second zlib")
    require(ngpy.count("libnglib.so") == 1, "ngpy lost its nglib provider")
    require(nglib.count(zlib) == 1, "nglib must keep exactly one target zlib archive")
    require(not any(("libz.a" in item and item != zlib) or item == "-lz" for item in nglib), "unadmitted zlib provider")
    actual_prefix = str(xbuildenv_root(xbuildenv).parent.parent)
    wrapper = json.loads((out / "src/netgen/.pyodide_build/pywasmcross_symlinks/pywasmcross_env.json").read_text())
    expected = PINS["wrapperSettings"]
    normalize = lambda value, prefix: value.replace(prefix, "@XBUILDENV_VERSION_DIR@") if isinstance(value, str) else value
    for key, value in expected.items():
        require(normalize(wrapper.get(key), actual_prefix) == normalize(value, PINS["historicalXbuildenvVersionDir"]),
                "effective Pyodide compiler wrapper setting changed: " + key)
    write_new(out / "dist-source/native-link-graph.json", {"ngpy": ngpy, "nglib": nglib, "zlibOwner": "libnglib.so"})
    print(json.dumps({"cmake": len(PINS["cmakeDefinitions"]), "ngpy": ngpy, "nglib": nglib}))


def uleb(data, pos):
    value, shift = 0, 0
    while True:
        require(pos < len(data) and shift < 35, "invalid WASM LEB")
        byte = data[pos]
        pos += 1
        value |= (byte & 127) << shift
        if byte < 128:
            return value, pos
        shift += 7


def needed(data):
    require(data[:8] == b"\x00asm\x01\x00\x00\x00", "module is not WebAssembly")
    pos, found, result = 8, False, []
    while pos < len(data):
        section = data[pos]
        size, start = uleb(data, pos + 1)
        end = start + size
        require(end <= len(data), "WASM section overrun")
        if section == 0:
            length, at = uleb(data, start)
            if data[at:at + length] == b"dylink.0":
                found = True
                at += length
                while at < end:
                    kind = data[at]
                    count, begin = uleb(data, at + 1)
                    if kind == 2:
                        n, cursor = uleb(data, begin)
                        for _ in range(n):
                            ln, cursor = uleb(data, cursor)
                            result.append(data[cursor:cursor + ln].decode("utf-8"))
                            cursor += ln
                    at = begin + count
        pos = end
    require(found, "missing dylink.0")
    return result


def wheel(out, variant, reference=""):
    require(variant in ("original", "modified"), "variant must be original or modified")
    wheels = sorted((out / "dist").glob("*.whl"))
    require([w.name for w in wheels] == [PINS["wheelName"]], "expected exactly " + PINS["wheelName"])
    w = wheels[0]
    with zipfile.ZipFile(w) as z:
        names = z.namelist()
        require(len(names) == len(set(names)), "duplicate wheel member")
        built = {name: z.read(name) for name in names}
    modules = {}
    for row in PINS["modules"]:
        data = built.get(row["member"])
        require(data is not None, "missing module " + row["member"])
        modules[row["member"]] = {"sha256": sha(data), "bytes": len(data), "needed": needed(data)}
        require(modules[row["member"]]["needed"] == row["needed"], "dylink needed differs: " + row["member"])
    require(sorted(n for n in built if n.endswith(".so")) == sorted(modules), "unexpected native module set")
    config = built["netgen/config/config.py"].decode("utf-8")
    assigned = {node.targets[0].id: node.value for node in ast.parse(config).body
                if isinstance(node, ast.Assign) and len(node.targets) == 1 and isinstance(node.targets[0], ast.Name)}
    require(ast.literal_eval(assigned["NETGEN_VERSION_GIT"]) == PINS["cmakeDefinitions"]["NETGEN_VERSION_GIT"], "version")
    require(ast.literal_eval(assigned["NETGEN_VERSION_PYTHON"]) == PINS["cmakeDefinitions"]["NETGEN_VERSION_PYTHON"], "version")
    for name in ("USE_OCC", "USE_MPI", "USE_GUI"):
        value = assigned[name]
        require(isinstance(value, ast.Call) and getattr(value.func, "id", "") == "_cmake_to_bool"
                and len(value.args) == 1 and ast.literal_eval(value.args[0]) == "OFF", "embedded flag: " + name)
    token = PINS["marker"]["token"].encode("utf-8")
    counts = {name: data.count(token) for name, data in built.items() if name.endswith(".so")}
    expected_total = 1 if variant == "modified" else 0
    require(sum(counts.values()) == expected_total, f"marker count {counts} differs for {variant}")
    record = {"variant": variant, "wheel": w.name, "wheelSha256": file_sha(w), "wheelBytes": w.stat().st_size,
              "modules": modules, "markerCounts": counts, "members": {n: sha(d) for n, d in sorted(built.items())}}
    if reference:
        ref_bytes = pathlib.Path(reference).read_bytes()
        require(sha(ref_bytes) == PINS["shippedWheel"]["sha256"], "reference wheel is not the shipped wheel")
        with zipfile.ZipFile(reference) as z:
            ref = {name: z.read(name) for name in z.namelist()}
        # Reported, never asserted: a byte difference alone is not a failure.
        record["comparison"] = {"referenceWheelSha256": sha(ref_bytes),
                                "wheelBytesIdentical": record["wheelSha256"] == sha(ref_bytes),
                                "memberNamesIdentical": sorted(built) == sorted(ref),
                                "membersWithDifferentBytes": sorted(n for n in set(built) & set(ref) if built[n] != ref[n]),
                                "shippedMarkerCount": sum(d.count(token) for n, d in ref.items() if n.endswith(".so"))}
    print(json.dumps(record, indent=2))


def provenance(out):
    logs = sorted(p for p in (out / "logs").iterdir()
                  if p.is_file() and p.name != "steps.txt" and not p.name.startswith("61-"))
    record = {"schema": "pointercad-netgen-portable-rebuild/1", "executedRecipe": "rebuild-netgen-pyodide.sh",
              "pins": file_sha(HERE / "pins.json"), "wheel": json.loads((out / "logs/60-wheel.stdout").read_text()),
              "sourceBeforeBuild": file_sha(out / "dist-source/source-before-build.json"),
              "logs": {p.name: file_sha(p) for p in logs}, "runtimeImportExecuted": False, "legalClearance": False}
    data = json.dumps(record, indent=2).encode("utf-8")
    with open(out / "rebuild-provenance.json", "xb") as fh:
        fh.write(data)
    print(sha(data), "rebuild-provenance.json")


def main(argv):
    command, out = argv[0], pathlib.Path(argv[1])
    require(out.is_absolute() and out.is_dir(), "--out must be an existing absolute directory")
    rest = argv[2:]
    {"extract": lambda: extract(out, *rest), "packaging": lambda: packaging(out, *rest), "marker": lambda: marker(out),
     "snapshot": lambda: snapshot(out), "objects": lambda: objects(out), "configure": lambda: configure(out, *rest), "wheel": lambda: wheel(out, *rest),
     "provenance": lambda: provenance(out),
     "xbuildenv": lambda: print(json.dumps({"pyodideRoot": str(xbuildenv_root(rest[0]))}))}[command]()


if __name__ == "__main__":
    main(sys.argv[1:])
