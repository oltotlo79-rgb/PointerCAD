# PointerCAD OCCT 7.6.2 / OpenCascade.js b5ff984 — Windows and corresponding source

This is the Windows recipe for the native IGES-enabled kernel in PointerCAD.
The uncompressed Wasm SHA-256 is
`d98f42dd4b9b631516b391b551cbe390225dfeb8520d4d3c4d7552b3a5964c47`.
The uncompressed Wasm has 20,573,524 bytes. The npm package retains
`opencascade.js@2.0.0-beta.b5ff984`. The name of the directory in
`pnpm-workspace.yaml` starts with the prefix of the actual Wasm digest.

## Corresponding source and offline use

Find the PointerCAD release whose notes name this Wasm digest. Download
`pointercad-occt-source-d98f42dd4b9b6315.zip` and save it alongside that release,
with the archive SHA-256 published in its release notes. The release index is
[PointerCAD releases](https://github.com/oltotlo79-rgb/PointerCAD/releases).
After download, extraction, hash verification and source inspection work
offline. The root `source-manifest.json` records the archived files, sizes,
SHA-256 hashes and source origins. The retained build checkout includes the
preceding closed package and its CSP patch, which the replay uses as comparison
inputs.

- `sources/` contains the fixed OCJS, OCCT, Emscripten and FreeType source
  archives, and the exact RapidJSON headers and their licence. The OCCT
  archive includes LGPL 2.1 and the OCCT exception. The Emscripten source
  includes the permissions and notices in its system libraries. The
  FreeType port has its original licence selector and both licence texts.
- The OCJS source archive contains the original `standard_time.patch` and
  `using-statements.patch`. The build extracted the already patched files
  from the pinned OCI image. The PointerCAD CSP patch is stored alongside
  the Windows recipe. The existing materializer applies its two changes
  during packaging. pnpm installs the already materialized package.
- `generated/` contains the four amended IGES translation units, the two
  existing custom translation units, the empty additional translation unit,
  and the original emitted TypeScript declarations. The checked `bindings/`
  fragments record the four pre-change and amended bindings by hash. The
  exact old generated source comes from the archived input inventory and
  the pinned OCI layer, with its member names and hashes recorded there.
- `evidence/` contains the public OCI member inventory, Windows SDK identity,
  the relative arguments for the 7 compile and 1 link commands in actual
  order, the 5,387 OCCT objects and 248 selected bindings, 13 LTO library
  fingerprints and the materialization receipt. `native-build.json` defines
  the argument base directory as `${MATERIALS}` and the SDK root as `${SDK}`.
  Each response hash is over the recorded UTF-8 response file with LF.
  The archive includes the Emscripten and FreeType port sources.

## Rebuild from the fixed materials

Use an already available Windows x64 SDK and Python 3.12 or later. Obtain
the SDK and required OCI blobs before starting an offline session. Keep
them together with the archive and the release's full PointerCAD checkout.
The Windows SDK archive is the official Emscripten 3.1.14 release
`ade9d780ff17c88d81aa13860361743e3c1e1396`, generation
`1655697148069102`, SHA-256
`6bfec6bf6a01e483a57e91f7223340a425f6ff711cbd32a08ed78002810d7882`.
The SDK files are verified individually at generation time.
[SDK source and release mapping](https://raw.githubusercontent.com/emscripten-core/emsdk/3.1.14/emscripten-releases-tags.json).

Use the image digest in `pins.json`. Supply OCI blobs for layers 9, 11 and
18 from that image in a folder as `layer-<number>-<sha256>.tar.gz`, using
the hashes from `evidence/oci-inventory.json`. The registry groups OCI
blobs by `blobs/sha256:<digest>`. The Windows recipe reads selected members
from those fixed compressed inputs. It uses the original
`wasm32-unknown-emscripten` bitcode from the image and the fixed Windows
driver for the seven translation units and the final linkage. It keeps
the original object order as recorded by that extraction. The exact
pre-change declarations are recovered from the previous package by
removing its four added typedef aliases, then the original SHA is checked.
The public OCCT, OCJS and Emscripten source archives make those dependencies
inspectable. Reproducing the old OCI layer bitcode from a fresh host
compiler is outside the Windows replay.

From the adopted checkout, let `$source` name the extracted source ZIP,
`$blobs` the directory of pinned OCI blobs and `$sdk` the SDK's expanded
`install` directory. The output must be a fresh dedicated D: directory.
Allow at least 5 GiB of free space after material extraction. Node v25.9.0
and zlib 1.3.1-e00f703 were used to record the packaging transport hashes.

```powershell
$repo = (Get-Location).Path
$recipe = Join-Path $repo 'vendor/opencascade/iges-build'
$inventory = Join-Path $source 'evidence/oci-inventory.json'
$port = Join-Path $source 'sources/freetype-version_1.zip'
$out = 'D:/PointerCAD-IGES-rebuild-01'
$node = (Get-Command node.exe -CommandType Application).Source
python -B -X utf8 "$recipe/windows/materials.py" extract --inputs $blobs --recipe $recipe --inventory $inventory --inventory-sha256 7b6dd92bc772053b76370bf03791143de0133c1445e5adc1447f2aed12911a0f --output $out
if ($LASTEXITCODE -ne 0) { throw 'OCCT material staging failed' }
$buildArgs = @('--materials', $out, '--node', $node, '--recipe', $recipe, '--freetype', $port, '--repository', $repo, '--sdk', $sdk, '--inventory', $inventory)
python -B -X utf8 "$recipe/windows/build_windows.py" @buildArgs
if ($LASTEXITCODE -ne 0) { throw 'OCCT generation failed' }
python -B -X utf8 "$recipe/windows/build_windows.py" @buildArgs --materialize
if ($LASTEXITCODE -ne 0) { throw 'OCCT packaging failed' }
```

Compare the new raw, LTO and materialization records to `evidence/`.
Record any differences. Verify ABI and the Web/Electron exchanges in the
ordinary PointerCAD gate before accepting a replacement. The adjusted
public path arguments and extraction recipe were reviewed from the native
run's source. That run used a dedicated Windows input layout, and replay
from this public layout still needs an independent execution record.

## Prepare the release asset

Run the offline packaging command after adopting the candidate files.
Supply the coordinator's saved native result, the four predownloaded
upstream source archives and the reviewed metadata staging directory.
The command checks every input then writes and verifies a single ZIP in
an existing release staging directory.

```powershell
python -B -X utf8 "$recipe/release-source.py" build --repo $repo --native $native --upstream $upstream --metadata $metadata --output $releaseStaging
```

Retain its printed SHA-256, record it with the full Wasm SHA-256 on the
release notes, and attach the ZIP with the release. The standard
publication manifest already compares the restored Web Wasm and the raw
Desktop renderer Wasm. Check that those records give the same digest as
the source asset. Test retrieval from the actual release record as part of
publication.
