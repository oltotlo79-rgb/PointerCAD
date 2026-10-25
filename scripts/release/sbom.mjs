/**
 * Build one CycloneDX software bill of materials from the existing, already-verified
 * notice inventories (runtime npm packages incl. script-runtime WASM, mathematics fonts,
 * the exact-math/Pyodide vendor tree) instead of re-deriving license facts from scratch.
 *
 * Format choice (reported to the supervisor, not re-litigated here): CycloneDX over SPDX.
 * Every existing notice record in this repository is already a flat
 * name/version/license/notice-file/hash tuple (see runtime-notices.json, math-notices.json,
 * script-runtime-notices.json, vendor/exact-math/manifest.json, font-notices.json).
 * CycloneDX's flat `components[]` with `licenses[]`, `hashes[]`, `externalReferences[]` and
 * free-form `properties[]` maps onto that shape directly. SPDX's document/package/relationship
 * graph and mandatory SPDX license-expression IDs would force guessing an identifier for a
 * component whose bundled original text does not itself state one - something task rules
 * forbid ("ライセンスの判断が要るものは推測で埋めない"). The exact-math component
 * "liblzma from XZ 5.2.2" carries no SPDX id: its own bundled public-domain declaration is
 * recorded by name with its exact text (see EXACT_MATH_NAMED_LICENSES). SQLite's original text matches SPDX blessing. The
 * other previously-unclassified components carry a confirmed SPDX id/expression
 * confirmed against their own bundled notice text - see script-runtime-notices.json's
 * `license` fields and this file's EXACT_MATH_LICENSES table for the evidence trail. No new
 * dependency is added: this file hand-serializes plain JSON that follows the CycloneDX 1.6
 * JSON shape.
 */
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, URL } from 'node:url';
import { collectRuntimeNotices } from '../vite/runtimeNotices.mjs';
import { collectMathNotices } from '../vite/mathNotices.mjs';
import { collectExactMathAssets } from '../vite/exactMathAssets.mjs';
import { assertFemApplicationBuildInputs, collectFemRuntimeAssets } from '../vite/femRuntimeAssets.mjs';

const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url));
const EXACT_MATH_SOURCE_PART_BYTES = 16 * 1024 * 1024; // Mirrors scripts/vite/exactMathAssets.mjs; files above this are split for Pages.
const HASH_PATTERN = /^[a-f0-9]{64}$/u;
const COMMIT_PATTERN = /^[a-f0-9]{40}$/u;
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u;
const COMPONENT_TYPES = new Set(['library', 'file']);

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));
const property = (name, value) => ({ name, value });
/** One deterministic "notice/asset actually shipped at this exact path" fact, joined for matching against a release manifest. */
const distributedFile = (path, digest) => property('pointercad:distributedFile', `${path}|${digest}`);
/**
 * One CycloneDX `licenses[]` entry for an SPDX id or expression already confirmed against the
 * component's own bundled original text (see docs/standards/licenses and vendor/exact-math
 * notices). A bare id ("MIT") never contains a space; a combination the original text itself
 * states ("A OR B", "A AND B", "A WITH B") always does, so that alone tells the two shapes apart.
 */
const licenseEntry = (expression) => (expression.includes(' ') ? { expression } : { license: { id: expression } });

function repositoryUrl(value) {
  const raw = typeof value === 'string' ? value : (value && typeof value.url === 'string' ? value.url : undefined);
  if (raw === undefined) return undefined;
  return raw.startsWith('github:') ? 'https://github.com/' + raw.slice('github:'.length) : raw;
}

function purl(name, version) {
  const segments = name.split('/').map((part) => encodeURIComponent(part));
  return `pkg:npm/${segments.join('/').replace(/^%40/u, '%40')}@${encodeURIComponent(version)}`;
}

/** ISO-shaped UUID derived only from `seed`, so the same repository state always yields the same serial number. */
export function deterministicUuid(seed) {
  const hex = createHash('sha256').update(seed).digest('hex').slice(0, 32).split('');
  hex[12] = '4';
  hex[16] = '89ab'[parseInt(hex[16], 16) % 4];
  const value = hex.join('');
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20, 32)}`;
}

/** Runtime npm packages (incl. OCCT's WASM wrapper); reuses collectRuntimeNotices' own hash/inventory verification. */
function runtimeLibraryComponents(root) {
  const distribution = collectRuntimeNotices(root); // Throws on any hash mismatch, missing file, or undeclared dependency.
  const manifest = readJson(join(root, 'docs/standards/licenses/runtime-notices.json'));
  const components = new Map();
  for (const item of manifest.packages) {
    const properties = [];
    const origin = repositoryUrl(item.repository);
    for (const notice of item.notices ?? []) {
      properties.push(distributedFile(`licenses/runtime/${notice.file}`, notice.sha256));
    }
    if (item.status === 'unresolved') properties.push(property('pointercad:licenseStatus', 'unresolved'));
    components.set(item.name, {
      type: 'library', name: item.name, version: item.version, purl: purl(item.name, item.version),
      licenses: item.status === 'unresolved' ? undefined : [{ license: { id: item.license } }],
      externalReferences: origin ? [{ type: 'vcs', url: origin }] : undefined,
      properties,
    });
  }
  // Extra per-package notices beyond the base license text (currently: OCCT's LGPL-2.1 static-
  // linking exception, which opencascade.js's own npm package does not bundle). Wired here so
  // the exception ships alongside the package's own notice, without becoming a second license id.
  for (const extra of distribution.additionalNotices) {
    const component = components.get(extra.appliesTo);
    if (!component) throw new Error('Additional runtime notice applies to an unknown component: ' + extra.appliesTo);
    component.properties.push(distributedFile(`licenses/runtime/${extra.file}`, extra.sha256));
  }
  return { components, unresolved: distribution.unresolved };
}

/** KaTeX math fonts (real font-file hashes) and the two additional OFL notice texts; cross-links onto the runtime npm entries. */
function mathComponents(root, runtimeComponents) {
  collectMathNotices(root); // Throws on any hash mismatch or font-inventory drift.
  const manifest = readJson(join(root, 'docs/standards/licenses/math-notices.json'));
  const components = [];
  for (const record of manifest.packages) {
    const runtime = runtimeComponents.get(record.name);
    if (!runtime || runtime.version !== record.version) {
      throw new Error(`Mathematics notice package is not a tracked runtime dependency: ${record.name}`);
    }
    runtime.properties.push(distributedFile(`licenses/${record.notice}`, record.sha256));
  }
  for (const record of manifest.additionalNotices) {
    components.push({ type: 'file', name: record.notice, licenses: [{ license: { id: 'OFL-1.1' } }],
      properties: [distributedFile(`licenses/${record.notice}`, record.sha256)] });
  }
  for (const record of manifest.fonts) {
    components.push({ type: 'file', name: record.file, licenses: [{ license: { id: 'OFL-1.1' } }],
      hashes: [{ alg: 'SHA-256', content: record.sha256 }],
      properties: [property('pointercad:distributionNote', 'Vite content-hashes this filename on build; matched by hash only')] });
  }
  return components;
}

const SCRIPT_RUNTIME_ORIGIN_HINTS = [
  [/\/quickjs-ng\/quickjs\//u, 'quickjs-ng'],
  [/\/WebAssembly\/wasi-libc\//u, 'wasi-libc'],
  [/\/llvm\/llvm-project\//u, 'llvm-project (compiler-rt)'],
  [/\/emscripten-core\/emscripten\//u, 'emscripten'],
];
function scriptRuntimeOrigin(url) {
  for (const [pattern, name] of SCRIPT_RUNTIME_ORIGIN_HINTS) if (pattern.test(url)) return name;
  throw new Error('Unknown script runtime notice origin: ' + url);
}
function scriptRuntimeRevision(url) {
  const match = /^https:\/\/raw\.githubusercontent\.com\/[^/]+\/[^/]+\/([^/]+)\//u.exec(url);
  if (!match) throw new Error('Unsupported script runtime notice URL: ' + url);
  return match[1];
}

/** The 12 vendored C-library notices for the auto-drafting QuickJS-ng runtime, plus the compiled bridge WASM itself. */
function scriptRuntimeComponents(root) {
  // collectRuntimeNotices() (called by the caller) already verifies these via collectScriptRuntimeNotices;
  // read the small manifests directly rather than re-run that (heavier) verification a second time.
  const manifest = readJson(join(root, 'docs/standards/licenses/script-runtime-notices.json'));
  const components = manifest.notices.map((notice) => ({
    type: 'file', name: `${scriptRuntimeOrigin(notice.url)} (${notice.file})`, version: scriptRuntimeRevision(notice.url),
    externalReferences: [{ type: 'vcs', url: notice.url }],
    licenses: notice.license ? [licenseEntry(notice.license)] : undefined,
    properties: [distributedFile(`licenses/script-runtime/${notice.file}`, notice.sha256),
      ...(notice.license ? [] : [property('pointercad:licenseStatus', 'unclassified')])],
  }));
  const vendor = readJson(join(root, 'packages/model/src/vendor/script-runtime/manifest.json'));
  // The compiled binary is built from this exact pinned quickjs-ng commit (matched below), so it
  // carries that notice's already-confirmed license instead of being reported unclassified again.
  const quickjsSource = manifest.notices.find((notice) => scriptRuntimeOrigin(notice.url) === 'quickjs-ng');
  const wasmLicense = quickjsSource && scriptRuntimeRevision(quickjsSource.url) === vendor.sourceRevision ? quickjsSource.license : undefined;
  components.push({ type: 'file', name: 'quickjs-pcad.wasm', version: vendor.sourceRevision,
    hashes: [{ alg: 'SHA-256', content: vendor.sha256 }],
    externalReferences: [{ type: 'vcs', url: 'https://github.com/quickjs-ng/quickjs' }],
    licenses: wasmLicense ? [licenseEntry(wasmLicense)] : undefined,
    properties: [...(wasmLicense ? [] : [property('pointercad:licenseStatus', 'unclassified')]), property('pointercad:bridgeAbi', String(vendor.bridgeAbi))] });
  return components;
}

/**
 * SPDX id/expression for each vendor/exact-math/manifest.json `components` group, confirmed by
 * reading that group's own bundled notice file(s) (vendor/exact-math/notices) against the
 * standard SPDX text they match - never guessed. "liblzma from XZ 5.2.2" has no SPDX id:
 * COPYING.txt gives its own public-domain summary, not the CC0-1.0 or Unlicense text, so it is
 * recorded by name in EXACT_MATH_NAMED_LICENSES below instead. SQLite's complete bundled LICENSE.txt matches the official
 * https://spdx.org/licenses/blessing.html text after whitespace and bullet formatting
 * are normalized; its original notice remains bundled and hash-verified.
 */
const EXACT_MATH_LICENSES = {
  'SQLite 3.39.0': 'blessing',
  // "Mozilla Public License Version 2.0" full text (numbered Definitions 1.1-1.7 etc.), verbatim.
  'Pyodide 314.0.6': 'MPL-2.0',
  'Hiwire 6a1e67280a15d929ebeceee54a6358c9c8d5f697': 'MPL-2.0', // byte-identical to the Pyodide MPL-2.0 file above.
  // LICENSE.txt and Doc-license.rst both contain "PYTHON SOFTWARE FOUNDATION LICENSE VERSION 2".
  'CPython 3.14.2': 'PSF-2.0',
  // "Emscripten is available under 2 licenses, the MIT license and the University of Illinois/
  // NCSA Open Source License." - byte-identical to docs/standards/licenses/script-emscripten-license.txt.
  'Emscripten 5.0.3': 'MIT OR NCSA',
  'libffi f08493d249d2067c8b3207ba46693dd858f95db3': 'MIT', // Standard MIT operative paragraph (typographic ``quotes'').
  'zlib 1.3.1': 'Zlib', // Gailly/Adler zlib notice, the 3-restriction text SPDX's Zlib id matches.
  'bzip2 1.0.6': 'bzip2-1.0.6', // Text names itself: "bzip2/libbzip2 version 1.0.6 of 6 September 2010".
  'zstd 1.5.7': 'BSD-3-Clause', // "BSD License" 3-clause text; the bundled file says nothing about the GPLv2 alternative, so no OR-GPL.
  // "The compiler_rt/libc++/libc++abi library is dual licensed under both the University of
  // Illinois 'BSD-Like' license and the MIT license. As a user of this code you may choose..."
  'musl in Emscripten 5.0.3': 'MIT', // "musl as a whole is licensed under the following standard MIT license:".
  'libc++ in Emscripten 5.0.3': 'NCSA OR MIT',
  'libc++abi in Emscripten 5.0.3': 'NCSA OR MIT',
  'compiler-rt in Emscripten 5.0.3': 'NCSA OR MIT',
  'MiniLZ4 in Emscripten 5.0.3': 'MIT', // node-lz4 (Pierre Curto) header is the standard MIT text.
  'HACL in CPython 3.14.2': 'MIT', // Hacl_Hash_SHA2.c header is the standard MIT text (C-comment wrapped).
  'libmpdec in CPython 3.14.2': 'BSD-2-Clause', // Stefan Krah header: 2 numbered conditions, no endorsement clause.
  // Copyright line names "Expat maintainers"; operative text matches the MIT-family paragraph
  // exactly. The manifest calls this group "Expat in CPython 3.14.2" (the license's common
  // name), but SPDX's own license list (docs/standards/licenses/cyclonedx-spdx.schema.json)
  // has no id spelled "Expat" - it assigns id 'MIT' to the "Expat License" text (confirmed by
  // the CycloneDX 1.6 schema validation in apps/desktop/src/main/sbom.test.ts; P13-6c fixed a
  // gap the P13-6b schema check found, see cyclonedx-schema-verification.json).
  'Expat in CPython 3.14.2': 'MIT',
  'StackFrame and ErrorStackParser in Pyodide 314.0.6': 'MIT', // Eric Wendelin stackframe LICENSE, standard MIT text.
  // LICENSE.txt.txt (latex2sympy) is MIT; LICENSE.txt (SymPy/Diofant/multipledispatch) is BSD-3-Clause.
  'sympy 1.14.0': 'BSD-3-Clause AND MIT',
  'mpmath 1.3.0': 'BSD-3-Clause', // a/b/c 3-clause conditions, "Neither the name of the copyright holder...".
};

/**
 * A complete grant in the component's own pinned notice that equals no SPDX License List text is recorded as a
 * CycloneDX non-SPDX named licence carrying that exact text (`pointercad:licenseStatus` = `named-non-spdx`). This is
 * a valid named licence, distinct from `unclassified` (grant not yet confirmed). XZ Utils' COPYING.txt says
 * "liblzma is in the public domain." and "If you find public domain legally problematic, take the previous sentence
 * as a license grant." - neither CC0-1.0 nor Unlicense, which are never substituted. Not a legal determination.
 */
const EXACT_MATH_NAMED_LICENSES = {
  'liblzma from XZ 5.2.2': { notice: 'notices/xz-5.2.2-COPYING.txt', name: 'XZ Utils public domain declaration (liblzma)' },
};
/** The named entry, only when its notice belongs to the component and its bytes equal the vendor pin. */
function namedLicenseEntry(vendorRoot, manifest, componentName, noticeFiles) {
  const named = EXACT_MATH_NAMED_LICENSES[componentName];
  if (!named) return undefined;
  const pin = manifest.files[named.notice];
  if (!noticeFiles.map((file) => `notices/${file}`).includes(named.notice) || !pin) {
    throw new Error('Named licence notice is not this component\'s pinned notice: ' + componentName);
  }
  const bytes = readFileSync(join(vendorRoot, named.notice));
  if (bytes.byteLength !== pin.bytes || sha256(bytes) !== pin.sha256) throw new Error('Named licence text changed: ' + named.notice);
  return { license: { name: named.name, text: { contentType: 'text/plain', content: bytes.toString('utf8') } } };
}

/** Pyodide/SymPy/mpmath and the ~20 C libraries they are built from; validated by the existing, heavier collector. */
function exactMathComponents(root) {
  // collectExactMathAssets() has no root parameter of its own (unlike the other collectors): it
  // always resolves vendor/exact-math from its own module location. Call it with no argument -
  // it still throws on any tampered/missing/undeclared vendor file; the (large) byte map is discarded.
  collectExactMathAssets();
  const vendorRoot = join(root, 'vendor/exact-math');
  const manifest = readJson(join(vendorRoot, 'manifest.json'));
  const distributedPath = (name, bytes) => {
    if (bytes > EXACT_MATH_SOURCE_PART_BYTES) return undefined; // Split into .part-NNN files; no single path to match.
    return name.startsWith('runtime/') ? `exact-math/${name}` : `licenses/exact-math/${name}`;
  };
  const components = [];
  const groupedNoticeFiles = new Set();
  for (const [componentName, noticeFiles] of Object.entries(manifest.components)) {
    const license = EXACT_MATH_LICENSES[componentName];
    const named = license ? undefined : namedLicenseEntry(vendorRoot, manifest, componentName, noticeFiles);
    const properties = license ? [] : [property('pointercad:licenseStatus', named ? 'named-non-spdx' : 'unclassified')];
    for (const file of noticeFiles) {
      const name = `notices/${file}`;
      groupedNoticeFiles.add(name);
      const pin = manifest.files[name];
      if (!pin) throw new Error(`Exact-math component notice is not pinned: ${name}`);
      const path = distributedPath(name, pin.bytes);
      if (path) properties.push(distributedFile(path, pin.sha256));
    }
    components.push({ type: 'library', name: componentName, licenses: license ? [licenseEntry(license)] : named ? [named] : undefined, properties });
  }
  for (const [name, pin] of Object.entries(manifest.files)) {
    if (groupedNoticeFiles.has(name)) continue;
    const path = distributedPath(name, pin.bytes);
    components.push({ type: 'file', name: name.split('/').at(-1), hashes: [{ alg: 'SHA-256', content: pin.sha256 }],
      properties: [property('pointercad:vendorPath', `vendor/exact-math/${name}`), property('pointercad:licenseStatus', 'see-related-components'),
        ...(path ? [distributedFile(path, pin.sha256)] : [])] });
  }
  return components;
}

/** The screen/drawing font is a plain, un-hashed Vite `public/` asset; verify Web and Desktop still ship the identical bytes. */
export function verifyFontAssetParity(root) {
  const web = join(root, 'apps/web/public/fonts'), desktop = join(root, 'apps/desktop/resources/fonts');
  const names = readdirSync(web).sort();
  if (JSON.stringify(names) !== JSON.stringify(readdirSync(desktop).sort())) throw new Error('Web and desktop font folders differ');
  const files = new Map();
  for (const name of names) {
    const webBytes = readFileSync(join(web, name)), desktopBytes = readFileSync(join(desktop, name));
    if (!webBytes.equals(desktopBytes)) throw new Error(`Web and desktop font asset differs: ${name}`);
    files.set(name, sha256(webBytes));
  }
  return files;
}

/** name/version/license/hash record for the currently-shipped screen font (font-notices.json), so a silently-swapped font is caught even outside the dedicated fontNotices test. */
function screenFontComponents(root) {
  const files = verifyFontAssetParity(root);
  const noticeSha256 = files.get('LICENSES.txt');
  if (!noticeSha256) throw new Error('Missing screen font notice file: LICENSES.txt');
  const fontNotices = readJson(join(root, 'docs/standards/licenses/font-notices.json'));
  const recorded = new Map(fontNotices.fonts.map((item) => [item.file, item]));
  return [...files].filter(([name]) => name !== 'LICENSES.txt').map(([name, digest]) => {
    const record = recorded.get(name);
    if (!record || record.sha256 !== digest) throw new Error('Screen font notice is missing or stale: ' + name);
    return {
      type: 'file', name, version: record.version, licenses: [licenseEntry(record.license)], hashes: [{ alg: 'SHA-256', content: digest }],
      properties: [distributedFile('fonts/LICENSES.txt', noticeSha256)],
    };
  });
}

/**
 * Fonts embedded only in the generated manual (scripts/manual/generate.mjs base64-embeds them into
 * manual.css and the printed PDFs); never copied as a standalone application asset, so there is no
 * fixed release-manifest path to match (the manual's own output folder name varies per build) - the
 * KaTeX math fonts above are the same "matched by hash only" shape. Recorded separately from
 * docs/standards/licenses/font-notices.json (the screen/drawing font) because these two are outside
 * the application input digest (scripts/manual/captureRegistry.mjs applicationInputDigest) by design.
 */
function manualFontComponents(root) {
  const manifest = readJson(join(root, 'scripts/manual/fonts/font-notices.json'));
  if (manifest.format !== 'pointercad-font-notices/1' || !Array.isArray(manifest.fonts) || manifest.fonts.length === 0
    || !Array.isArray(manifest.notices)) throw new Error('Manual font notices are incomplete');
  const noticesByFile = new Map(manifest.notices.map((notice) => [notice.file, notice]));
  return manifest.fonts.map((font) => {
    const bytes = readFileSync(join(root, 'scripts/manual/fonts', font.file));
    if (sha256(bytes) !== font.sha256) throw new Error('Manual font changed: ' + font.file);
    const notice = noticesByFile.get(font.notice);
    if (!notice) throw new Error('Manual font notice is missing: ' + font.file);
    const noticeBytes = readFileSync(join(root, 'scripts/manual/fonts', notice.file));
    if (sha256(noticeBytes) !== notice.sha256) throw new Error('Manual font notice changed: ' + notice.file);
    return {
      type: 'file', name: font.file, version: font.version, licenses: [{ license: { id: font.license } }],
      hashes: [{ alg: 'SHA-256', content: font.sha256 }],
      properties: [property('pointercad:distributionNote',
        'Embedded (base64) only in the generated manual (scripts/manual/generate.mjs); matched by hash only, no fixed release-manifest path')],
    };
  });
}

/**
 * SPDX id for a FEM wheel component, only when every shipped notice was compared word by word with the SPDX License
 * List text and template and the wheel's own METADATA declares the same licence. Bound to the exact version, the
 * source-index wheel file, the shipped wheel SHA-256 and every notice SHA-256; anything else stays `unclassified`.
 * The runtime ships only oofem, numpy and Pyodide (the numerical drivers need only numpy). The 19 entries recorded
 * for the former matplotlib/pytest dependency closure were removed together with those wheels; their evidence stays
 * outside the distribution. oofem, numpy and Pyodide stay `unclassified`: numpy's custom BSD-style variants do not
 * match the SPDX templates and its compiled-in component notices are not yet proved complete, so neither an SPDX id
 * nor a named licence is recorded. This is an SBOM licence-id record only: source correspondence, native rebuild and
 * legal review stay unresolved.
 */
const FEM_LICENSES = new Map();
/** The confirmed SPDX id only when every bound fact of the recorded evidence equals the distributed inventory. */
function femLicense(item, source, files) {
  const confirmed = FEM_LICENSES.get(item.name);
  if (!confirmed || !source || confirmed.version !== item.version || source.version !== item.version || source.file !== confirmed.wheel) return undefined;
  if (files['assets/' + source.file]?.sha256 !== confirmed.wheelSha256) return undefined;
  const notices = [...item.notices].sort();
  if (notices.length !== confirmed.notices.length || notices.some((name, at) => name !== confirmed.notices[at])) return undefined;
  return confirmed.notices.every((name) => files[name]?.sha256 === name.slice('notices/'.length, -'.txt'.length)) ? confirmed.license : undefined;
}

/**
 * Code compiled into the oofem native module from a separately versioned upstream source, as its own component.
 * Only source-index facts are used: the recorded pybind11 gitlink, the single source archive at that commit and the
 * notice texts recorded from that archive, which oofem already ships. Nothing here classifies a licence.
 */
function femEmbeddedComponents(manifest, sourceIndex, facts) {
  const oofem = manifest.components.find(item => item.name === 'oofem');
  if (!oofem) return [];
  const commit = sourceIndex.buildEvidence?.pybind11Gitlink;
  const materials = (sourceIndex.materials ?? []).filter(item => (item.components ?? []).includes('pybind11')
    && String(item.url).endsWith('/' + commit));
  if (!COMMIT_PATTERN.test(commit ?? '') || materials.length !== 1 || !String(materials[0].url).endsWith('/' + commit)
    || !HASH_PATTERN.test(materials[0].sha256 ?? '') || typeof materials[0].bundlePath !== 'string') {
    throw new Error('FEM embedded component source missing: pybind11');
  }
  const [material] = materials;
  const notices = (sourceIndex.noticeEntries ?? []).filter(entry => entry.source === material.path).map(entry => entry.bundlePath);
  if (notices.length === 0 || notices.some(name => !oofem.notices.includes(name))) {
    throw new Error('FEM embedded component notice missing: pybind11');
  }
  return [{ type: 'library', name: 'FEM: pybind11', version: commit,
    properties: [property('pointercad:licenseStatus', 'unclassified'),
      property('pointercad:femEmbeddedIn', 'FEM: oofem'),
      property('pointercad:femSourceEvidence', 'licenses/fem/evidence/source-index.json'),
      property('pointercad:femSourceArchive', material.bundlePath + '|' + material.sha256),
      ...notices.flatMap(facts)] }];
}

/** Exact retained Netgen dependency records; unresolved rights remain unclassified. */
function netgenEmbeddedComponents(manifest, readMetadata, facts) {
  const mapPath = 'evidence/netgen-build-source-map.json';
  const map = readMetadata(mapPath);
  const wheelName = 'assets/netgen_mesher-6.2.2606.post5.dev0-cp313-cp313-pyodide_2025_0_wasm32.whl';
  const wheel = manifest.files[wheelName];
  const members = ['libngcore.so', 'libnglib.so', 'netgen/libngpy.so', 'pyngcore/pyngcore.so'];
  const names = ['FEM: Netgen pybind11', 'FEM: Netgen zlib', 'FEM: Netgen concurrentqueue', 'FEM: Netgen gzstream', 'FEM: Netgen mpi4py header'];
  if (map.schema !== 'pcad-netgen-shipped-source-map/2' || !wheel
    || map.wheel?.sha256 !== wheel.sha256 || map.wheel?.bytes !== wheel.bytes
    || !Array.isArray(map.modules) || map.modules.length !== members.length
    || members.some(name => map.modules.filter(row => row.member === name).length !== 1)
    || map.modules.some(row => !HASH_PATTERN.test(row.sha256 ?? '') || !Number.isSafeInteger(row.bytes) || row.bytes <= 0
      || !Array.isArray(row.needed) || row.needed.some(name => !members.some(member => member.split('/').at(-1) === name)))
    || !Array.isArray(map.embeddedDependencies) || map.embeddedDependencies.length !== names.length
    || names.some(name => map.embeddedDependencies.filter(row => row.name === name).length !== 1)
    || map.legalClearance !== false || map.sourceReplacementExecuted !== false) {
    throw new Error('FEM Netgen retained module/dependency evidence differs');
  }
  return map.embeddedDependencies.map(item => {
    const source = item.source, pin = manifest.files[source?.path];
    const header = item.type === 'file';
    if (!pin || source.sha256 !== pin.sha256 || source.bytes !== pin.bytes
      || !['library', 'file'].includes(item.type) || !Array.isArray(item.notices)
      || (!header && item.notices.length === 0) || typeof item.relationship !== 'string'
      || (item.version !== undefined && typeof item.version !== 'string')) {
      throw new Error('FEM Netgen dependency source/notice evidence differs');
    }
    if (item.sourceMember && (!HASH_PATTERN.test(item.sourceMember.sha256 ?? '')
      || item.sourceMember.byteIdentical !== true
      || !map.headerSourceCorrespondence?.some(row => JSON.stringify(row) === JSON.stringify(item.sourceMember)))) {
      throw new Error('FEM Netgen shipped header/source evidence differs');
    }
    if (header) {
      const proof = item.sourceMember?.permissionEvidence;
      const expected = {"referenceTag": "4.0.0", "referenceIsUniqueOriginVersion": false, "headerUrl": "https://raw.githubusercontent.com/mpi4py/mpi4py/4.0.0/src/mpi4py/include/mpi4py/pycapi.h", "licenseUrl": "https://raw.githubusercontent.com/mpi4py/mpi4py/4.0.0/LICENSE.rst", "observedOn": "2026-10-24", "method": "UTF-8 splitlines; discard blank lines; strip leading/trailing whitespace only; retain order and every other character", "nonemptyLines": 208, "normalizedSha256": "1316b5a0642ce6ed627cb7d5d42f14a3c9a31c541bc8dfbbbfd59024ab220e70", "localHeaderSha256": "022ec87d2a2dc2bcf0bc1961560477f3d532eff33df6ba2f8edd48f4abf39cb8", "licenseExpression": "BSD-3-Clause", "notice": "notices/915b533dea3bff17c3fca634928176a4d831c69ce99257809637beebc88596b6.txt", "noticeSha256": "915b533dea3bff17c3fca634928176a4d831c69ce99257809637beebc88596b6", "limit": "Complete normalized source correspondence to the named upstream reference, not raw upstream byte equality or proof of the original build version. No MPI runtime inclusion claim."};
      if (item.name !== 'FEM: Netgen mpi4py header'
        || item.sourceMember.sha256 !== expected.localHeaderSha256
        || item.sourceMember.permissionStatus !== "Complete normalized header correspondence to mpi4py 4.0.0 reference; BSD-3-Clause notice retained; unique original version not asserted."
        || JSON.stringify(proof) !== JSON.stringify(expected)
        || item.notices.length !== 1 || item.notices[0] !== expected.notice
        || manifest.files[expected.notice]?.sha256 !== expected.noticeSha256) {
        throw new Error('FEM Netgen mpi4py permission correspondence differs');
      }
    }
    return { type: item.type, name: item.name, ...(item.version === undefined ? {} : { version: item.version }),
      ...(header ? { licenses: [{ license: { id: 'BSD-3-Clause' } }] } : {}),
      ...(item.sourceMember ? { hashes: [{ alg: 'SHA-256', content: item.sourceMember.sha256 }] } : {}),
      properties: [property('pointercad:licenseStatus', header ? 'classified' : 'unclassified'),
        property('pointercad:femEmbeddedIn', 'FEM: netgen-mesher'),
        property('pointercad:femDependencyEvidence', mapPath),
        property('pointercad:femDependencyRelationship', item.relationship),
        ...(item.sourceMember ? [property('pointercad:femSourceMember', JSON.stringify(item.sourceMember))] : []),
        ...facts(mapPath), ...facts(source.path), ...item.notices.flatMap(facts)] };
  });
}


/** Map the existing verified FEM distribution, without inventing SPDX or native source qualification. */
export function femComponentsFromDistribution(distribution) {
  const assets = distribution.assets;
  const manifestPath = 'licenses/fem/manifest.json';
  const manifest = JSON.parse(assets.get(manifestPath).toString('utf8'));
  const sourceIndex = JSON.parse(assets.get('licenses/fem/evidence/source-index.json').toString('utf8'));
  const components = [];
  const facts = (name) => {
    const file = manifest.files[name];
    if (!file || !Array.isArray(file.parts) || file.parts.length === 0) throw new Error('FEM SBOM file mapping missing: ' + name);
    return file.parts.map(part => {
      const bytes = assets.get(part.file);
      if (!bytes || bytes.byteLength !== part.bytes || sha256(bytes) !== part.sha256) throw new Error('FEM SBOM distributed bytes differ: ' + name);
      return distributedFile(part.file, part.sha256);
    });
  };
  // The platform is not a wheel source-index record. Bind its displayed tuple to the actual pinned metadata,
  // and keep the package-index label separate: it can predate the JavaScript runtime without being its version.
  const readMetadata = name => {
    facts(name);
    const pin = manifest.files[name], bytes = Buffer.concat(pin.parts.map(part => assets.get(part.file)));
    if (bytes.byteLength !== pin.bytes || sha256(bytes) !== pin.sha256) throw new Error('FEM SBOM distributed bytes differ: ' + name);
    return JSON.parse(bytes.toString('utf8'));
  };
  const platform = manifest.components.filter(item => item.name === 'Pyodide');
  if (platform.length !== 1) throw new Error('FEM platform component mapping missing: Pyodide');
  const metadata = readMetadata('assets/package.json'), info = readMetadata('assets/pyodide-lock.json')?.info;
  const emscripten = /^emscripten_(\d+)_(\d+)_(\d+)$/u.exec(info?.platform ?? '');
  if (metadata?.name !== 'pyodide' || typeof metadata.version !== 'string' || !VERSION_PATTERN.test(metadata.version)
    || typeof info?.python !== 'string' || !/^\d+\.\d+\.\d+$/u.test(info.python) || !emscripten
    || typeof info.version !== 'string' || info.version.length === 0) throw new Error('FEM platform metadata mapping missing: Pyodide');
  const expectedPlatform = `${metadata.version} / CPython ${info.python} / Emscripten ${emscripten.slice(1).join('.')}`;
  if (platform[0].version !== expectedPlatform) throw new Error('FEM platform version differs from shipped metadata: Pyodide');
  const platformProperties = [property('pointercad:femPlatformVersion', metadata.version),
    property('pointercad:femPythonVersion', info.python),
    property('pointercad:femEmscriptenVersion', emscripten.slice(1).join('.')),
    property('pointercad:femPackageIndexVersion', info.version),
    ...['assets/package.json', 'assets/pyodide-lock.json', 'assets/pyodide.mjs', 'assets/pyodide.asm.js',
      'assets/pyodide.asm.wasm', 'assets/python_stdlib.zip'].flatMap(facts)];
  for (const item of manifest.components) {
    const source = sourceIndex.components.find(record => record.name === item.name);
    if (item.name !== 'Pyodide' && (!source || source.version !== item.version || !manifest.files['assets/' + source.file])) {
      throw new Error('FEM SBOM component/source mapping missing: ' + item.name);
    }
    const license = femLicense(item, source, manifest.files);
    components.push({ type: 'library', name: 'FEM: ' + item.name, version: item.version,
      licenses: license ? [licenseEntry(license)] : undefined,
      properties: [...(license ? [] : [property('pointercad:licenseStatus', 'unclassified')]),
        ...(item.name === 'Pyodide' ? platformProperties : []),
        property('pointercad:femManifest', manifestPath),
        property('pointercad:femSourceEvidence', 'licenses/fem/evidence/source-index.json'),
        ...(source ? [property('pointercad:femSourceRecord', JSON.stringify(source)), ...facts('assets/' + source.file)] : []),
        ...item.notices.flatMap(facts)] });
  }
  components.push(...femEmbeddedComponents(manifest, sourceIndex, facts));
  components.push(...netgenEmbeddedComponents(manifest, readMetadata, facts));
  // Every distributed wheel needs a visible component and its exact source-index identity.
  for (const name of Object.keys(manifest.files).filter(path => path.startsWith('assets/') && path.endsWith('.whl'))) {
    const sources = sourceIndex.components.filter(item => 'assets/' + item.file === name);
    if (sources.length !== 1 || manifest.components.filter(item => item.name === sources[0].name && item.version === sources[0].version).length !== 1) {
      throw new Error('FEM wheel component/source mapping missing: ' + name);
    }
  }
  for (const [name, pin] of Object.entries(manifest.files)) {
    components.push({ type: 'file', name: 'FEM file: ' + name,
      hashes: [{ alg: 'SHA-256', content: pin.sha256 }],
      properties: [property('pointercad:licenseStatus', 'see-related-components'),
        property('pointercad:femRuntimePath', 'packages/fem/runtime/' + name), ...facts(name)] });
  }
  for (const name of [manifestPath, 'licenses/fem/index.html']) {
    const bytes = assets.get(name);
    if (!bytes) throw new Error('FEM SBOM generated mapping absent: ' + name);
    components.push({ type: 'file', name: 'FEM distribution: ' + name,
      hashes: [{ alg: 'SHA-256', content: sha256(bytes) }],
      properties: [property('pointercad:licenseStatus', 'see-related-components'), distributedFile(name, sha256(bytes))] });
  }
  return components;
}

/**
 * Collect every component this SBOM tracks, reusing the existing per-system collectors for
 * hash/inventory verification. Never throws for a *documented* gap (an unresolved runtime
 * notice, or a component with no recorded SPDX id) - those are returned for the caller to
 * list, not hidden by a crash. It still throws for tampering: a hash that does not match its
 * recorded value, a missing pinned file, or an inconsistent inventory.
 */
export function collectSbomComponents(root = repositoryRoot) {
  const { components: runtime, unresolved } = runtimeLibraryComponents(root);
  const fem = collectFemRuntimeAssets(join(root, 'packages/fem/runtime'));
  assertFemApplicationBuildInputs(fem, new Map(['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml']
    .map(name => [name, readFileSync(join(root, name))])));
  const components = [
    ...runtime.values(),
    ...mathComponents(root, runtime),
    ...scriptRuntimeComponents(root),
    ...exactMathComponents(root),
    ...screenFontComponents(root),
    ...manualFontComponents(root),
    ...femComponentsFromDistribution(fem),
  ];
  const seen = new Set();
  for (const component of components) {
    const key = `${component.type}:${component.name}:${component.version ?? ''}`;
    if (seen.has(key)) throw new Error('Duplicate SBOM component: ' + key);
    seen.add(key);
  }
  return { components, unresolvedNotices: unresolved };
}

function validateComponent(component) {
  if (!COMPONENT_TYPES.has(component.type)) throw new Error('Invalid SBOM component type: ' + component.type);
  if (typeof component.name !== 'string' || component.name.length === 0) throw new Error('Invalid SBOM component name');
  for (const entry of component.hashes ?? []) {
    if (entry.alg !== 'SHA-256' || !HASH_PATTERN.test(entry.content)) throw new Error('Invalid SBOM component hash: ' + component.name);
  }
  for (const entry of component.properties ?? []) {
    if (entry.name === 'pointercad:distributedFile') {
      const [path, digest] = String(entry.value).split('|');
      if (!path || !HASH_PATTERN.test(digest ?? '')) throw new Error('Invalid distributed-file property: ' + entry.value);
    }
  }
}

/**
 * Assemble the CycloneDX document from an already-collected component list. Pure function
 * (no filesystem access) so malformed-input rejection can be tested without a repository.
 */
export function assembleSbomDocument({ components, unresolvedNotices = [] }, { rootPackageVersion, sourceCommit, generatedAt } = {}) {
  if (!Array.isArray(components) || components.length === 0) throw new Error('SBOM has no components');
  if (typeof rootPackageVersion !== 'string' || !VERSION_PATTERN.test(rootPackageVersion)) throw new Error('Invalid SBOM root package version');
  if (sourceCommit !== undefined && !COMMIT_PATTERN.test(sourceCommit)) throw new Error('Invalid SBOM source commit');
  const seen = new Set();
  for (const component of components) {
    validateComponent(component);
    const key = `${component.type}:${component.name}:${component.version ?? ''}`;
    if (seen.has(key)) throw new Error('Duplicate SBOM component: ' + key);
    seen.add(key);
  }
  const metadataProperties = [property('pointercad:runtimeUnresolvedCount', String(unresolvedNotices.length)),
    ...unresolvedNotices.map((name) => property('pointercad:unresolvedNotice', name))];
  if (sourceCommit !== undefined) metadataProperties.push(property('pointercad:sourceCommit', sourceCommit));
  return {
    bomFormat: 'CycloneDX', specVersion: '1.6',
    serialNumber: `urn:uuid:${deterministicUuid(sourceCommit ?? rootPackageVersion)}`,
    version: 1,
    metadata: { timestamp: generatedAt, component: { type: 'application', name: 'PointerCAD', version: rootPackageVersion },
      properties: metadataProperties },
    components,
  };
}

/** Read the repository and build its SBOM in one step; see assembleSbomDocument for the pure/testable half. */
export function buildSbom(root = repositoryRoot, options = {}) {
  const rootPackageVersion = readJson(join(root, 'package.json')).version;
  return assembleSbomDocument(collectSbomComponents(root), { rootPackageVersion, ...options });
}

/**
 * Non-throwing gap report: components whose original license text is missing entirely
 * (`unresolved`, mirrors NOTICE's own wording) versus components whose text is present and
 * hash-verified but not yet tagged with a machine-readable SPDX id (`unclassified`) - the
 * former is a real compliance gap, the latter a lower-risk documentation gap. Neither is
 * guessed here; both are only ever read back from records this file already collected.
 */
export function findSbomGaps(sbom) {
  if (typeof sbom !== 'object' || sbom === null || !Array.isArray(sbom.components)) throw new Error('Invalid SBOM document');
  const unresolvedNotices = (sbom.metadata?.properties ?? [])
    .filter((entry) => entry.name === 'pointercad:unresolvedNotice').map((entry) => entry.value);
  const unclassifiedLicenses = sbom.components
    .filter((component) => (component.properties ?? []).some((entry) => entry.name === 'pointercad:licenseStatus' && entry.value === 'unclassified'))
    .map((component) => component.name);
  const noLicenseInformation = sbom.components
    .filter((component) => !component.licenses && !(component.properties ?? []).some((entry) => entry.name === 'pointercad:licenseStatus'))
    .map((component) => component.name);
  return { unresolvedNotices, unclassifiedLicenses, noLicenseInformation };
}

/** Hard-fails only on a genuine compliance gap (missing original text); unclassified SPDX ids are advisory. */
export function assertSbomPublishable(sbom) {
  const gaps = findSbomGaps(sbom);
  if (gaps.unresolvedNotices.length > 0) throw new Error('Unresolved SBOM notices: ' + gaps.unresolvedNotices.join(', '));
  if (gaps.noLicenseInformation.length > 0) throw new Error('SBOM components with no license information: ' + gaps.noLicenseInformation.join(', '));
}

/**
 * Reconcile every deterministic `pointercad:distributedFile` fact this SBOM recorded against
 * a release manifest's (P13-1, `release-manifest.json`) `web.files` list. Scoped to license
 * and notice text - the actual compliance deliverable - plus any other small, un-hashed-path
 * asset; build-hashed or split (>16MB) assets are intentionally out of scope (see module
 * comment) and never appear as a `pointercad:distributedFile` property to begin with.
 */
export function matchSbomToReleaseManifest(sbom, releaseManifest) {
  if (typeof sbom !== 'object' || sbom === null || !Array.isArray(sbom.components)) throw new Error('Invalid SBOM document');
  if (typeof releaseManifest !== 'object' || releaseManifest === null || !Array.isArray(releaseManifest.web?.files)) {
    throw new Error('Invalid release manifest');
  }
  const files = new Map();
  for (const file of releaseManifest.web.files) {
    if (typeof file.path !== 'string' || !HASH_PATTERN.test(file.sha256)) throw new Error('Invalid release manifest file entry');
    files.set(file.path, file.sha256);
  }
  const missing = [], mismatched = [];
  let checked = 0;
  for (const component of sbom.components) {
    for (const entry of component.properties ?? []) {
      if (entry.name !== 'pointercad:distributedFile') continue;
      const [path, expected] = String(entry.value).split('|');
      checked += 1;
      const actual = files.get(path);
      if (actual === undefined) missing.push({ path, component: component.name });
      else if (actual !== expected) mismatched.push({ path, component: component.name, expected, actual });
    }
  }
  return { checked, missing, mismatched };
}

/** Throwing counterpart, for a future release-gate script; never silently passes on a missing or tampered file. */
export function assertSbomMatchesReleaseManifest(sbom, releaseManifest) {
  const result = matchSbomToReleaseManifest(sbom, releaseManifest);
  if (result.missing.length > 0) throw new Error('Release manifest is missing SBOM files: ' + result.missing.map((item) => item.path).join(', '));
  if (result.mismatched.length > 0) throw new Error('Release manifest file hash differs from SBOM: ' + result.mismatched.map((item) => item.path).join(', '));
}
