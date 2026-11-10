"""Root-only: stage the Netgen modified-source replacement into an ISOLATED copy (never the product tree).

    python -I -B stage_replacement.py --copy ABS_ISOLATED_COPY --modified-wheel ABS_WHEEL \
        --provenance ABS_OUT/rebuild-provenance.json --receipt ABS_NEW_RECEIPT.json

Five rows, each an exact single change verified against the copy's parent bytes and re-verified after writing:
  packages/fem/runtime/assets/<NETGEN wheel>   shipped 3f0d507e... -> modified wheel (from the modified rebuild)
  packages/fem/runtime/manifest.json           only files[<wheel>] bytes/sha256 change (JSON compared otherwise equal)
  packages/fem/src/assets.ts                   only the NETGEN_ASSETS wheel bytes/sha256 change
  e2e/tests/fem-netgen-replacement.spec.ts     new; byte copy of the pinned spec next to this script
  packages/test-utils/src/browserProjectCoverage.json  copy only: one allClassifications row for the new spec
      (category numerical-worker-representative, LF-normalized text SHA-256), so the copy's
      browserProjectCoverage.test.ts does not stop on an unclassified new spec. Playwright itself does not read it.
Refusals (before any write): --copy is the repository this script belongs to, a parent differs, the provenance is not a
passed modified rebuild of exactly this wheel with marker count 1, the spec target exists, the copy already
classifies the spec, or the receipt exists.
The source map, application-source index and SBOM are not touched: this copy is a qualification copy, not a
distribution candidate (sbom/application-source checks are expected to differ there and are not run by this stage).
"""
import argparse
import hashlib
import json
import os
import pathlib
import re

HERE = pathlib.Path(__file__).resolve().parent
PINS = json.loads((HERE / "pins.json").read_text(encoding="utf-8"))
WHEEL = PINS["wheelName"]
SHIPPED = PINS["shippedWheel"]
SPEC_SHA = "95568112418183f62aa3629258b24984e90580c047f903435335ea7f5535a053"
sha = lambda data: hashlib.sha256(data).hexdigest()


def fail(message):
    raise SystemExit("stage_replacement: " + message)


def replace_once(data, pattern, replacement, label):
    found = list(re.finditer(pattern, data))
    if len(found) != 1:
        fail(f"{label}: expected exactly one parent occurrence, found {len(found)}")
    m = found[0]
    return data[:m.start()] + replacement(m) + data[m.end():]


SPEC_NAME = "fem-netgen-replacement.spec.ts"
COVERAGE_ROW = {"file": SPEC_NAME, "category": "numerical-worker-representative",
                "reason": "copy-only Root qualification staged by stage_replacement.py: same FemClient and real "
                          "fem/worker.js bridge as Firefox-selected solid-finite-worker; checks Netgen wheel "
                          "acceptance/refusal by the product loader, not Firefox success"}


def text_sha256(data):
    """browserProjectCoverage.test.ts textSha256: SHA-256 of the UTF-8 text with CRLF normalized to LF."""
    return sha(data.decode("utf-8").replace("\r\n", "\n").encode("utf-8"))


def insert_classification(parent, spec_bytes):
    """Adds exactly one allClassifications row for SPEC_NAME before the first row whose file sorts after it.

    Text insertion keeps every other byte; the result must parse to the parent with exactly that row inserted.
    """
    doc = json.loads(parent)
    rows = doc.get("allClassifications")
    if not isinstance(rows, list) or any(row.get("file") == SPEC_NAME for row in rows):
        fail("coverage: allClassifications is missing or already classifies " + SPEC_NAME)
    later = sorted(row["file"] for row in rows if row["file"] > SPEC_NAME)
    if not later:
        fail("coverage: no row sorts after " + SPEC_NAME)
    nl = b"\r\n" if b"\r\n" in parent else b"\n"
    anchor = nl + b"    {" + nl + b'      "file": ' + json.dumps(later[0]).encode("utf-8") + b","
    if parent.count(anchor) != 1:
        fail("coverage: expected exactly one anchor row for " + later[0])
    row = {**COVERAGE_ROW, "sha256": text_sha256(spec_bytes)}
    lines = [b"    {"] + [f"      {json.dumps(k)}: {json.dumps(v, ensure_ascii=False)}{',' if i < len(row) - 1 else ''}"
                          .encode("utf-8") for i, (k, v) in enumerate(row.items())] + [b"    },"]
    at = parent.index(anchor) + len(nl)
    result = parent[:at] + nl.join(lines) + nl + parent[at:]
    expected = json.loads(parent)
    index = next(i for i, r in enumerate(expected["allClassifications"]) if r["file"] == later[0])
    expected["allClassifications"].insert(index, row)
    if json.loads(result) != expected:
        fail("coverage: change is not exactly the one new row")
    return result


def main():
    p = argparse.ArgumentParser()
    for name in ("copy", "modified-wheel", "provenance", "receipt"):
        p.add_argument("--" + name, required=True)
    a = p.parse_args()
    copy = pathlib.Path(a.copy)
    if not copy.is_absolute() or not copy.is_dir() or copy.is_symlink():
        fail("--copy must be an existing real absolute directory")
    product = HERE.parents[4]
    if copy.resolve() == product.resolve():
        fail("--copy is the product repository; refusing")
    receipt = pathlib.Path(a.receipt)
    if not receipt.is_absolute() or receipt.exists():
        fail("--receipt must be absolute and must not exist")
    spec_src = HERE / "fem-netgen-replacement.spec.ts"
    spec_bytes = spec_src.read_bytes()
    if sha(spec_bytes) != SPEC_SHA:
        fail("spec bytes differ from the pinned spec")
    modified = pathlib.Path(a.modified_wheel).read_bytes()
    prov = json.loads(pathlib.Path(a.provenance).read_text(encoding="utf-8"))
    w = prov.get("wheel", {})
    if (prov.get("schema") != "pointercad-netgen-portable-rebuild/1" or w.get("variant") != "modified"
            or w.get("wheel") != WHEEL or w.get("wheelSha256") != sha(modified) or w.get("wheelBytes") != len(modified)
            or sum(w.get("markerCounts", {}).values()) != 1):
        fail("provenance is not a passed modified rebuild of this exact wheel with one marker")
    if sha(modified) == SHIPPED["sha256"]:
        fail("modified wheel equals the shipped wheel")
    paths = {"wheel": copy / "packages/fem/runtime/assets" / WHEEL, "manifest": copy / "packages/fem/runtime/manifest.json",
             "assets": copy / "packages/fem/src/assets.ts", "spec": copy / "e2e/tests/fem-netgen-replacement.spec.ts",
             "coverage": copy / "packages/test-utils/src/browserProjectCoverage.json"}
    if paths["spec"].exists():
        fail("spec target already exists in the copy")
    before = {k: paths[k].read_bytes() for k in ("wheel", "manifest", "assets", "coverage")}
    if sha(before["wheel"]) != SHIPPED["sha256"] or len(before["wheel"]) != SHIPPED["bytes"]:
        fail("copy wheel is not the shipped parent")
    old_sha, old_bytes = SHIPPED["sha256"].encode(), str(SHIPPED["bytes"]).encode()
    new_sha, new_bytes = sha(modified).encode(), str(len(modified)).encode()
    key = re.escape(f'"assets/{WHEEL}"'.encode())
    manifest = replace_once(before["manifest"],
                            key + rb': \{(\r?\n)(\s+)"bytes": ' + old_bytes + rb',(\r?\n)(\s+)"sha256": "' + old_sha + rb'"',
                            lambda m: f'"assets/{WHEEL}": {{'.encode() + m.group(1) + m.group(2) + b'"bytes": ' + new_bytes
                            + b',' + m.group(3) + m.group(4) + b'"sha256": "' + new_sha + b'"', "manifest row")
    parent_json, new_json = json.loads(before["manifest"]), json.loads(manifest)
    expected = json.loads(before["manifest"])
    expected["files"]["assets/" + WHEEL] = {**parent_json["files"]["assets/" + WHEEL], "bytes": len(modified), "sha256": sha(modified)}
    if new_json != expected:
        fail("manifest change is not exactly the wheel row")
    assets = replace_once(before["assets"],
                          rb'("file":\s+"' + re.escape(WHEEL.encode()) + rb'",\s+"bytes":\s+)' + old_bytes
                          + rb'(,\s+"sha256":\s+")' + old_sha + rb'"',
                          lambda m: m.group(1) + new_bytes + m.group(2) + new_sha + b'"', "NETGEN_ASSETS row")
    if assets.replace(new_bytes, old_bytes, 1).replace(new_sha, old_sha, 1) != before["assets"]:
        fail("assets.ts change does not reverse to the parent")
    coverage = insert_classification(before["coverage"], spec_bytes)
    writes = {"wheel": modified, "manifest": manifest, "assets": assets, "spec": spec_bytes, "coverage": coverage}
    for k, data in writes.items():
        if k == "spec":
            with open(paths[k], "xb") as f:
                f.write(data); f.flush(); os.fsync(f.fileno())
        else:
            paths[k].write_bytes(data)
        if sha(paths[k].read_bytes()) != sha(data):
            fail("write did not read back: " + k)
    record = {"schema": "pcad-netgen-replacement-stage/1", "copy": str(copy),
              "rows": {k: {"path": str(paths[k].relative_to(copy)).replace(os.sep, "/"),
                           "before": sha(before[k]) if k in before else None, "after": sha(writes[k])} for k in writes},
              "modifiedWheel": {"bytes": len(modified), "sha256": sha(modified)}, "shippedWheel": SHIPPED,
              "provenanceSha256": sha(pathlib.Path(a.provenance).read_bytes()), "adoptionCandidate": False,
              "env": {"PCAD_NETGEN_ORIGINAL_WHEEL": "<product>/packages/fem/runtime/assets/" + WHEEL}}
    with open(receipt, "xb") as f:
        f.write((json.dumps(record, indent=2) + "\n").encode("utf-8")); f.flush(); os.fsync(f.fileno())
    print(json.dumps(record, indent=2))


if __name__ == "__main__":
    main()
