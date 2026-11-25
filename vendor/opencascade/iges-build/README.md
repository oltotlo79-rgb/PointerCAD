# Reproduce the PointerCAD IGES kernel

The dedicated **Reproduce OCCT IGES kernel** workflow builds the four IGES bindings using the same OpenCascade.js, OCCT and Emscripten versions as the existing kernel. It uses one standard GitHub-hosted Ubuntu 24.04 x64 runner. The recipe requires the exact image digest in [pins.json](pins.json) and uses its precompiled OCCT objects and bindings.

| Component | Source |
| --- | --- |
| OpenCascade.js 2.0.0-beta.b5ff984 | [b5ff9847200016dce0d92fe747fc38a945771dc5](https://github.com/donalffons/opencascade.js/tree/b5ff9847200016dce0d92fe747fc38a945771dc5) |
| Open CASCADE Technology 7.6.2 | [bb368e271e24f63078129283148ce83db6b9670a](https://github.com/Open-Cascade-SAS/OCCT/tree/bb368e271e24f63078129283148ce83db6b9670a) |
| Emscripten 3.1.14 | [4343cbec72b7db283ea3bda1adc6cb1811ae9a73](https://github.com/emscripten-core/emscripten/tree/4343cbec72b7db283ea3bda1adc6cb1811ae9a73) |
| Linux amd64 image | [sha256:3069f4c2e3ab62bb82d81843bad2c0f8552ee92373208f8f655ef9bf71c0524d](https://hub.docker.com/layers/donalffons/opencascade.js/2.0.0-beta.b5ff984/images/sha256-3069f4c2e3ab62bb82d81843bad2c0f8552ee92373208f8f655ef9bf71c0524d) |
| FreeType port | [version_1.zip](https://github.com/emscripten-ports/FreeType/archive/version_1.zip) with pinned byte length, SHA-256 and SHA-512 |

## Build and recover

1. Review and select the source commit containing this recipe and its [workflow template](occt-iges-kernel.yml.in). After the repository's separate definition-only delivery is authorized, add the exact committed template bytes as the sole added file at `.github/workflows/occt-iges-kernel.yml`, in a commit with that source commit as its sole parent. The dedicated ref is `refs/heads/build/occt-iges-<full-source-commit>`. Record the expected parent, build commit and tree, full ref and template SHA-256 before sending. Reserve the ref once. A new, non-forced ref creation starts the first attempt on standard GitHub-hosted Linux. Ordinary CI and release use their existing triggers. Keep the build ref for recovery and do not recreate it or rerun the job for recovery.
2. Before sending, confirm the repository-specific authorized delivery route, standard runner availability and absence of additional charges. The ordinary product delivery cannot carry an active workflow and a plain new-ref push is subject to the repository's installed hooks. An ambiguous send is resolved by looking up the ref and run and downloading from the recorded attempt. The hosted preflight checks the event, sole parent, one-definition delta, matching template and every tracked build input. Its receipt includes the full workflow SHA-256, source inputs and build signature. The hosted builder uses Node.js 22.23.3 and a single CPU in an offline container with the read-only recipe and a fresh output directory. It checks 5 GiB of available disk before and after image acquisition and before linking, and 5 GiB of available RAM before starting the container.
3. Use the successful **iges-kernel** job of that same run and attempt. Download `occt-iges-<run>-<attempt>` from the run's artifacts and extract it to a fresh directory. A failed attempt has diagnostic logs and capacity data when available. An attempt with a failed, cancelled or incomplete job has no eligible outputs. Read the existing run and attempt again to recover results. Artifacts are retained for 14 days.
4. From the checkout of the build commit, verify the extracted artifact against the commit and tree recorded independently from the run. The receipt inventories the complete contents, including the paired raw build and materialized outputs and corresponding source. Verification also compares every member of the recipe archive with the Git objects from that commit. Preserve the receipt with the new vendor triple.

```sh
git --no-optional-locks rev-parse HEAD 'HEAD^{tree}'
python3 -B vendor/opencascade/iges-build/hosted.py verify downloaded-artifact \
  --repository "$EXPECTED_REPOSITORY" \
  --commit "$EXPECTED_COMMIT" --tree "$EXPECTED_TREE" --parent "$EXPECTED_PARENT" \
  --run "$EXPECTED_RUN_ID" --attempt "$EXPECTED_ATTEMPT"
```

The generated `raw/opencascade.closed.js`, `raw/opencascade.closed.wasm` and `raw/opencascade.closed.d.ts` are one build. The matching `vendor/opencascade.full.js`, `vendor/opencascade.full.wasm` and `vendor/opencascade.full.d.ts` are its PointerCAD inputs. The materializer applies the existing vendor CSP patch by matching both complete function bodies. The existing vendor JS and DTS provide byte-for-byte comparison for the two patched functions and four existing typedef aliases. The existing vendor directory is pinned in the recipe. Its wasm is only a baseline for comparison.

When installing the verified triple in the vendored npm package's `dist/` directory, retain its matching `vendor/materialization.json` as `materialization.json` beside the package's `package.json`. The installed-glue compatibility test reads its full digest from this file. Preserve the exact bytes of the new package on both operating systems. Leave the old pinned inputs available at the recipe's build commit.

The 244 retained registrations and existing linker settings come from `opencascade.base.yml`. Four additions yield 248 registrations and six new exports, including the two CAF default constructors. The underlying IGES unit and scale are exposed to the importer. The writer exposes the current output unit and B-rep mode for the caller to set and restore. PointerCAD's internal length is in millimetres. Runtime checks for MM/INCH and both topology paths are part of adoption.

The receipt and materialization report use bytes for sizes. A disk headroom of 5 GiB is required before linking. Workspace and Docker storage, RAM and CPUs are recorded at each phase and during the build. A link failure or missing source or license stops materialization. Web gzip uses level 9 and Desktop gzip uses the default level. Both are decoded and checked against the same uncompressed SHA-256. Web and Desktop distribution subsequently create their normal fallback and streaming assets, and the release manifest verifies the restored wasm.

## Corresponding source and notices

The artifact's `sources/` and `licenses/` contain the four upstream source archives, the image's RapidJSON headers and their notice, the PointerCAD recipe including its binding changes, CSP patch, and runtime notice manifest, and the OpenCascade.js, OCCT and FreeType notices. The public image and source tree supply the common generated binding prefix. The four retained custom binding inputs are rebuilt from that prefix and the supplied fragments. The complete workflow source records the input and output mapping.

OpenCascade.js carries LGPL-2.1-only. OCCT's exact source archive carries the library terms and OCCT exception; the runtime notices also carry the existing exception text. FreeType's license selector, FreeType License and GPLv2 text travel with the artifact and are wired through the existing PointerCAD runtime notice and SBOM paths. RapidJSON's license accompanies the headers in its source archive. Original upstream licensing applies to upstream material. PointerCAD's new build scripts and recipe carry the repository's Apache-2.0 license. The supplied binding fragments retain the source attribution above and are distributed with the corresponding library source.

After the successful run is verified, prepare a durable release asset from the same extracted artifact and build commit. This command performs the recovery checks and writes one `.tar.gz` to a new destination directory. The name includes the run, attempt and WASM digest prefix. The archive contains the full receipt and materialization record.

```sh
python3 -B vendor/opencascade/iges-build/hosted.py release-source downloaded-artifact source-release \
  --repository "$EXPECTED_REPOSITORY" \
  --commit "$EXPECTED_COMMIT" --tree "$EXPECTED_TREE" --parent "$EXPECTED_PARENT" \
  --run "$EXPECTED_RUN_ID" --attempt "$EXPECTED_ATTEMPT"
```

Adoption requires the approved build attempt and successful runtime IGES/STEP checks using its exact triple. For the GitHub Release that carries that kernel, attach the source archive and link it in the release notes. Record the archive SHA-256 and compare its receipt's full WASM SHA-256 with the publication manifest's restored Web and installed Desktop kernels before publication. Reopen the release link to confirm the same archive remains downloadable independently of the 14-day Actions artifact. Preserve the build commit in the release record, since its existing vendor directory supplies the pinned comparison files used by this recipe.

## Native Windows build

See [the offline recipe and corresponding-source instructions](WINDOWS.md).
