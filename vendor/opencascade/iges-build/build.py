"""Build the additive IGES bindings in the pinned OpenCascade.js image."""
import hashlib
import json
import multiprocessing
import os
from pathlib import Path
import re
import runpy
import shutil
import stat
import subprocess
import sys
import tarfile
import zipfile

HERE = Path(__file__).resolve().parent
PINS = json.loads((HERE / "pins.json").read_bytes())
IMAGE = Path("/opencascade.js")
EMSCRIPTEN = Path("/emsdk/upstream/emscripten")
SINGLE = "single-threaded"


def require(condition, detail):
    if not condition:
        raise ValueError(detail)


def facts(data):
    return {"bytes": len(data), "sha256": hashlib.sha256(data).hexdigest()}


def checked(path, expected):
    data = path.read_bytes()
    require(facts(data) == expected, f"Input differs from pin: {path}")
    return data


def write_new(path, data):
    with path.open("xb") as output:
        output.write(data)


def config_bytes():
    pins = PINS["configuration"]
    base = checked(HERE / "opencascade.base.yml", pins["base"])
    spec = json.loads(base)
    previous = [item["symbol"] for item in spec["mainBuild"]["bindings"]]
    additions = pins["add"]
    anchor = b'    "bindings": [\n'
    added = "".join('      {\n        "symbol": "' + name + '"\n      },\n' for name in additions).encode()
    require(base.count(anchor) == 1, "Configuration binding list is ambiguous")
    candidate = base.replace(anchor, anchor + added, 1)
    require(facts(candidate) == pins["candidate"], "IGES configuration differs from its pin")
    combined = json.loads(candidate)
    require(len(previous) == pins["counts"][0] and len(set(previous + additions)) == pins["counts"][1],
            "Unexpected or duplicate binding registrations")
    combined["mainBuild"]["bindings"] = combined["mainBuild"]["bindings"][len(additions):]
    require(combined == spec, "Configuration changed outside the four registrations")
    return candidate


def prepare_bindings():
    library = IMAGE / "build/bindings"
    changed = []
    shared = None
    for item in PINS["bindings"]:
        target = library / item["imagePath"]
        original = target.read_bytes()
        require(facts(original) == item["before"], f"Wrong image binding: {target.name}")
        replacement = checked(HERE / "bindings" / item["input"], item["source"])
        if target.suffix == ".cpp":
            prefix = original[:PINS["bindingPrefix"]["bytes"]]
            require(facts(prefix) == PINS["bindingPrefix"], f"Wrong binding prefix: {target.name}")
            shared = prefix
            replacement = prefix + replacement
        require(facts(replacement) == item["after"], f"Wrong derived binding: {target.name}")
        changed.append((target, replacement))
    require(shared is not None, "No source binding supplied the common prefix")
    custom = {}
    for name in ("OCJS.cpp", "OCJS.d.ts.json", "Handle_IMeshTools_Context.cpp", "Handle_IMeshTools_Context.d.ts.json"):
        item = PINS["customBindings"][name]
        body = checked(HERE / "bindings" / item["input"], item["source"])
        data = shared + body if name.endswith(".cpp") else body
        require(facts(data) == item["after"], f"Wrong custom binding: {name}")
        custom[name] = data
    return changed, custom


def stage_freetype(archive, flags):
    sys.path.insert(0, str(EMSCRIPTEN))
    from tools import config, ports
    from tools.settings import settings

    port_pin = PINS["freetype"]
    data = checked(archive, {k: port_pin[k] for k in ("bytes", "sha256")})
    require(hashlib.sha512(data).hexdigest() == port_pin["sha512"], "FreeType archive SHA-512 differs")
    for flag in flags:
        if flag.startswith("-sUSE_"):
            match = re.fullmatch(r"-s(USE_[A-Z0-9_]+)=([0-9]+)", flag)
            require(match is not None, f"Unsupported port flag: {flag}")
            setattr(settings, match[1], int(match[2]))
    require([port.name for port in ports.get_needed_ports(settings)] == ["freetype"]
            and not ports.ports_by_name["freetype"].deps, "Unexpected Emscripten port closure")
    folder = Path(config.PORTS).resolve() / "freetype"
    require(not os.path.lexists(folder.with_suffix(".zip")), "Existing FreeType archive in image")
    with zipfile.ZipFile(archive) as source:
        infos = source.infolist()
        names = {item.filename for item in infos}
        total = sum(item.file_size for item in infos)
        require(len(infos) == len(names) == port_pin["entries"] and total == port_pin["decodedBytes"],
                "Unexpected FreeType archive inventory")
        folder.mkdir(parents=True)
        for item in infos:
            parts = item.filename.rstrip("/").split("/")
            kind = stat.S_IFMT(item.external_attr >> 16)
            require(parts[0] == "FreeType-version_1" and all(p not in ("", ".", "..") for p in parts)
                    and not re.search(r"[\\:\x00]", item.filename) and not item.flag_bits & 1
                    and kind in (0, stat.S_IFDIR if item.is_dir() else stat.S_IFREG),
                    f"Invalid FreeType member: {item.filename!r}")
            path = folder.joinpath(*parts)
            if item.is_dir():
                path.mkdir(parents=True, exist_ok=True)
            else:
                path.parent.mkdir(parents=True, exist_ok=True)
                write_new(path, source.read(item))
        for name, pin in port_pin["notices"].items():
            checked(folder / name, {k: pin[k] for k in ("bytes", "sha256")})
    write_new(folder / ".emscripten_url", (port_pin["url"] + "\n").encode())
    return {"entries": len(infos), "bytes": total, "archiveSha256": port_pin["sha256"]}


def archive_rapidjson(paths, out):
    headers = {header.resolve() for folder in paths
               if (header := Path(folder) / "rapidjson/rapidjson.h").is_file()}
    require(len(headers) == 1, f"Could not identify the image RapidJSON headers from {paths!r}")
    header = next(iter(headers))
    include = header.parent
    parent = include.parent.parent
    possible_licenses = [parent / "license.txt", parent / "LICENSE",
                         parent / "LICENSE.txt", Path("/usr/share/doc/rapidjson-dev/copyright")]
    license_file = next((path for path in possible_licenses if path.is_file()), None)
    require(license_file is not None, f"Missing license for the image RapidJSON headers at {include}")
    with tarfile.open(out / "rapidjson-headers.tar.gz", "x:gz") as archive:
        for path in sorted(include.rglob("*")):
            require(not path.is_symlink(), f"Unexpected RapidJSON header symlink: {path.name}")
            if path.is_file():
                archive.add(path, arcname="rapidjson/" + path.relative_to(include).as_posix(), recursive=False)
        archive.add(license_file.resolve(), arcname="LICENSE.txt", recursive=False)
    return {"header": facts(header.read_bytes()), "license": facts(license_file.read_bytes())}


def main(out, archive):
    require(os.environ.get("threading") == SINGLE and os.environ.get("EMCC_CORES") == "1",
            "Expected the single-threaded builder and compiler")
    require(out.is_dir() and not list(out.iterdir()), "A fresh output directory is required")
    sys.path.insert(0, str(IMAGE / "src"))
    for path, pin in PINS["imageFiles"].items():
        checked(Path(path), pin)
    version = subprocess.check_output(["emcc", "--version"], text=True).splitlines()[0]
    versions = PINS["versions"]
    require(Path(shutil.which("emcc") or "").resolve().parent == EMSCRIPTEN
            and f'{versions["emscriptenRelease"]} ({versions["emscripten"]})' in version, "Wrong emcc")
    from Common import additionalIncludePaths, ocIncludePaths
    from compileBindings import buildOneFile

    headers = {path.resolve() for folder in ocIncludePaths
               if (path := Path(folder) / "Standard_Version.hxx").is_file()}
    require(len(headers) == 1, "Could not uniquely locate OCCT version header")
    header = next(iter(headers)).read_bytes()
    for macro, number in zip(("MAJOR", "MINOR", "MAINTENANCE"), versions["occtRelease"].split(".")):
        require(re.search(rb"^\s*#\s*define\s+OCC_VERSION_" + macro.encode() + rb"\s+" + number.encode() + rb"\b",
                          header, re.MULTILINE), f"Unexpected OCCT version macro: {macro}")
    configuration = config_bytes()
    changed, custom = prepare_bindings()
    flags = json.loads(configuration)["mainBuild"]["emccFlags"]
    staging = stage_freetype(archive, flags)
    rapidjson = archive_rapidjson(ocIncludePaths + additionalIncludePaths, out)
    config = out / "opencascade.closed.yml"
    write_new(config, configuration)

    # Replace only the image builder's call that regenerates the custom sources.
    upstream = IMAGE / "src/buildFromYaml.py"
    original = checked(upstream, PINS["imageFiles"][str(upstream)])
    call = b'generateCustomCodeBindings(buildConfig["additionalCppCode"])\n'
    require(original.count(call) == 1, "Custom code generation anchor changed")
    patched = original.replace(call, b'restore_custom_bindings()\n', 1)
    builder = IMAGE / "src/buildPointerCAD.py"
    write_new(builder, patched)
    custom_folder = IMAGE / "build/bindings/myMain.h"

    def restore_custom_bindings():
        custom_folder.mkdir()
        for name, body in custom.items():
            write_new(custom_folder / name, body)

    for target, data in changed:
        target.write_bytes(data)
    # Overlay writes above preserve the image layout. Rebuild only the four changed translation units.
    for target in sorted(path for path, _ in changed if path.suffix == ".cpp"):
        obj = target.with_suffix(".cpp.o")
        obj.unlink()
        buildOneFile({"threading": SINGLE}, str(target))
        require(obj.stat().st_size > 0, f"Missing compilation output: {obj.name}")

    require(min(shutil.disk_usage(out).free, shutil.disk_usage(IMAGE).free) >= 5 * 1024**3,
            "At least 5 GiB free on both output and container filesystems is required before linking")
    build_input = {"image": PINS["image"], "imageFiles": PINS["imageFiles"], "emcc": version,
                   "occtVersionHeader": facts(header), "configuration": facts(configuration),
                   "builder": facts(patched), "bindings": {
                       Path(item["imagePath"]).name: {"before": item["before"], "after": item["after"]}
                       for item in PINS["bindings"]},
                   "customBindings": {name: facts(data) for name, data in custom.items()}, "freetype": staging,
                   "rapidjson": rapidjson,
                   "linkFreeBytes": {"output": shutil.disk_usage(out).free, "container": shutil.disk_usage(IMAGE).free},
                   "linkFlags": flags, "threading": SINGLE, "emccCores": 1}
    write_new(out / "build-inputs.json", (json.dumps(build_input, indent=2) + "\n").encode())
    multiprocessing.cpu_count = lambda: 1
    os.chdir(out)
    sys.argv = [str(builder), str(config)]
    runpy.run_path(str(builder), init_globals={"restore_custom_bindings": restore_custom_bindings}, run_name="__main__")
    files = [out / f"opencascade.closed.{suffix}" for suffix in ("js", "wasm", "d.ts")]
    outputs = {path.name: facts(path.read_bytes()) for path in files}
    require(all(row["bytes"] for row in outputs.values()), "Empty build output")
    write_new(out / "build-outputs.json", (json.dumps(outputs, indent=2) + "\n").encode())


if __name__ == "__main__":
    main(Path(sys.argv[1]).resolve(), Path(sys.argv[2]).resolve())
