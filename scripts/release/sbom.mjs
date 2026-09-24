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
 * forbid ("ライセンスの判断が要るものは推測で埋めない"). Two exact-math components
 * ("liblzma from XZ 5.2.2", "SQLite 3.39.0") are exactly that case and stay
 * `licenseStatus: 'unclassified'` below (see EXACT_MATH_LICENSES' doc comment for why). The
 * other 32 previously-unclassified components (P13-6b) now carry an SPDX id/expression
 * confirmed against their own bundled notice text - see script-runtime-notices.json's
 * `license` fields and this file's EXACT_MATH_LICENSES table for the evidence trail. No new
 * dependency is added: this file hand-serializes plain JSON that follows the CycloneDX 1.6
 * JSON shape.
 */
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, URL } from 'node:url';
import { collectRuntimeNotices } from '../vite/runtimeNotices.mjs';
import { collectMathNotices } from '../vite/mathNotices.mjs';
import { collectExactMathAssets } from '../vite/exactMathAssets.mjs';

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
 * standard SPDX text they match - never guessed. Two groups are deliberately absent and stay
 * `unclassified` because their bundled original text does not reproduce a standard license:
 * "liblzma from XZ 5.2.2" (its COPYING.txt gives its own prose summary - "liblzma is in the
 * public domain" - not the CC0-1.0 or Unlicense legal text), and "SQLite 3.39.0" (its
 * LICENSE.txt is SQLite's well-known public-domain "blessing" dedication, but that short text
 * names no license and there is no other bundled or already-approved-in-repo copy to confirm
 * the exact SPDX id against without network access).
 */
const EXACT_MATH_LICENSES = {
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
  // exactly, and the manifest already calls this group "Expat in CPython 3.14.2" itself.
  'Expat in CPython 3.14.2': 'Expat',
  'StackFrame and ErrorStackParser in Pyodide 314.0.6': 'MIT', // Eric Wendelin stackframe LICENSE, standard MIT text.
  // LICENSE.txt.txt (latex2sympy) is MIT; LICENSE.txt (SymPy/Diofant/multipledispatch) is BSD-3-Clause.
  'sympy 1.14.0': 'BSD-3-Clause AND MIT',
  'mpmath 1.3.0': 'BSD-3-Clause', // a/b/c 3-clause conditions, "Neither the name of the copyright holder...".
};

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
    const properties = license ? [] : [property('pointercad:licenseStatus', 'unclassified')];
    for (const file of noticeFiles) {
      const name = `notices/${file}`;
      groupedNoticeFiles.add(name);
      const pin = manifest.files[name];
      if (!pin) throw new Error(`Exact-math component notice is not pinned: ${name}`);
      const path = distributedPath(name, pin.bytes);
      if (path) properties.push(distributedFile(path, pin.sha256));
    }
    components.push({ type: 'library', name: componentName, licenses: license ? [licenseEntry(license)] : undefined, properties });
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
 * Collect every component this SBOM tracks, reusing the existing per-system collectors for
 * hash/inventory verification. Never throws for a *documented* gap (an unresolved runtime
 * notice, or a component with no recorded SPDX id) - those are returned for the caller to
 * list, not hidden by a crash. It still throws for tampering: a hash that does not match its
 * recorded value, a missing pinned file, or an inconsistent inventory.
 */
export function collectSbomComponents(root = repositoryRoot) {
  const { components: runtime, unresolved } = runtimeLibraryComponents(root);
  const components = [
    ...runtime.values(),
    ...mathComponents(root, runtime),
    ...scriptRuntimeComponents(root),
    ...exactMathComponents(root),
    ...screenFontComponents(root),
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
