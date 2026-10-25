import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';
import { createRequire } from 'node:module';
import { sourceFileHash } from '../release/desktopFileInventory.mjs';
import { fileURLToPath, URL } from 'node:url';
import { build } from 'vite';

const projectRoot = fileURLToPath(new URL('../../', import.meta.url));
const sourcePartBytes = 16 * 1024 * 1024;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const record = value => typeof value === 'object' && value !== null && !Array.isArray(value);
const safePath = value => typeof value === 'string' && /^[A-Za-z0-9._+/-]+$/u.test(value)
  && !value.split('/').some(part => part === '' || part === '.' || part === '..');
const escape = value => String(value).replace(/[&<>"']/gu,
  char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);

/** No downloads or inferred replacements: every emitted byte belongs to the fixed local inventory. */
export function buildFemRuntimeAssets(manifest, files) {
  if (!record(manifest) || manifest.format !== 'pointercad-fem-distribution/1'
    || !record(manifest.files) || !Array.isArray(manifest.components) || !Array.isArray(manifest.unresolved)
    // At least oofem, numpy and the Pyodide platform component (matplotlib/pytest and their closure are not shipped).
    || manifest.components.length < 3 || manifest.components.length > 64) throw new Error('Invalid FEM distribution inventory');
  const names = Object.keys(manifest.files).sort();
  if (names.length === 0 || names.length > 1000 || names.length !== files.size
    || names.some(name => !files.has(name))) throw new Error('FEM distribution inventory changed');
  const folded = new Set();
  let total = 0;
  for (const name of names) {
    const pin = manifest.files[name], bytes = files.get(name);
    if (!safePath(name) || !/^(assets|notices|sources|evidence)\//u.test(name)
      || folded.has(name.toLowerCase()) || !record(pin) || !Buffer.isBuffer(bytes)
      || !Number.isSafeInteger(pin.bytes) || pin.bytes < 0 || (pin.bytes === 0 && !name.startsWith('notices/'))
      || pin.bytes > 320 * 1024 * 1024
      || bytes.byteLength !== pin.bytes || !/^[a-f0-9]{64}$/u.test(pin.sha256)
      || hash(bytes) !== pin.sha256) throw new Error('FEM distribution input changed: ' + name);
    folded.add(name.toLowerCase());
    total += bytes.byteLength;
    if (total > 512 * 1024 * 1024) throw new Error('FEM distribution exceeds the bounded closure');
  }
  for (const component of manifest.components) {
    if (!record(component) || typeof component.name !== 'string' || typeof component.version !== 'string'
      || !Array.isArray(component.notices) || component.notices.length === 0
      || component.notices.some(name => !safePath(name) || !name.startsWith('notices/') || !files.has(name))) {
      throw new Error('FEM component notice is absent');
    }
  }
  const assets = new Map(), distribution = {};
  for (const name of names) {
    const bytes = files.get(name);
    const output = name.startsWith('assets/') ? 'fem/' + name : 'licenses/fem/' + name;
    if (bytes.byteLength > sourcePartBytes && !name.startsWith('sources/')) {
      throw new Error('Non-source FEM asset exceeds the offline file bound: ' + name);
    }
    const parts = [];
    // An explicitly inventoried empty upstream notice is still a real shipped file.
    if (bytes.byteLength === 0) {
      assets.set(output, bytes);
      parts.push({ file: output, bytes: 0, sha256: hash(bytes) });
    }
    for (let start = 0; start < bytes.byteLength; start += sourcePartBytes) {
      const part = bytes.subarray(start, Math.min(start + sourcePartBytes, bytes.byteLength));
      const file = bytes.byteLength <= sourcePartBytes ? output : `${output}.part-${String(parts.length + 1).padStart(3, '0')}`;
      if (assets.has(file)) throw new Error('FEM output collision');
      assets.set(file, part);
      parts.push({ file, bytes: part.byteLength, sha256: hash(part) });
    }
    distribution[name] = { ...manifest.files[name], parts };
  }
  const shipped = { ...manifest, files: distribution };
  assets.set('licenses/fem/manifest.json', Buffer.from(JSON.stringify(shipped, null, 2) + '\n'));
  const componentLinks = manifest.components.map(component => '<li>' + escape(component.name + ' ' + component.version)
    + ': ' + component.notices.map(name => `<a href="./${name}">${escape(name.split('/').at(-1))}</a>`).join(' / ') + '</li>').join('\n');
  const sourceLinks = names.filter(name => !name.startsWith('assets/')).map(name => '<li>' + escape(name) + ': '
    + distribution[name].parts.map(part => `<a href="./${part.file.slice('licenses/fem/'.length)}">${escape(part.file.split('/').at(-1))}</a>`).join(' / ') + '</li>').join('\n');
  const unresolved = manifest.unresolved.map(item => '<li>' + escape(item) + '</li>').join('\n');
  assets.set('licenses/fem/index.html', Buffer.from('<!doctype html><html lang="ja"><meta charset="utf-8">'
    + '<title>はり解析の利用部品・許諾・ソース</title><h1>はり解析の利用部品・許諾・ソース</h1>'
    + '<p>使用する部品と原文を同梱しています。各部品の条件はその原文に従います。</p>'
    + `<ul>${componentLinks}</ul><h2>確認が残る配布条件</h2><ul>${unresolved}</ul>`
    + '<p>この一覧は法的な承認や、ネイティブ計算部の再構築が完了したことを示すものではありません。</p>'
    + `<h2>同梱資料とソース</h2><ul>${sourceLinks}</ul>`
    + '<p>大きなソース書庫は内容を変えずに分割しています。part-001から順にバイナリ連結すると元の書庫に戻ります。'
    + '順序・サイズ・SHA-256は<a href="./manifest.json">一覧</a>にあります。</p></html>'));
  return { assets, unresolved: [...manifest.unresolved] };
}

const APPLICATION_BUILD_INPUTS = ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml'];

/** Compare only the caller's actual build inputs; standalone foreign distributions stay independent. */
export function assertFemApplicationBuildInputs(distribution, buildInputs) {
  if (!(buildInputs instanceof Map) || buildInputs.size !== APPLICATION_BUILD_INPUTS.length
    || APPLICATION_BUILD_INPUTS.some(name => !Buffer.isBuffer(buildInputs.get(name)))) {
    throw new Error('Exactly three FEM application build inputs are required');
  }
  const manifestBytes = distribution.assets.get('licenses/fem/manifest.json');
  const manifest = JSON.parse(manifestBytes.toString('utf8'));
  const application = manifest.applicationSource;
  if (!record(application) || !safePath(application.archive) || !safePath(application.index)) {
    throw new Error('FEM application source inventory is required');
  }
  const readPinned = name => {
    const pin = manifest.files[name];
    if (!record(pin) || !Array.isArray(pin.parts) || pin.parts.length === 0) {
      throw new Error('FEM application source pin is required: ' + name);
    }
    const bytes = Buffer.concat(pin.parts.map(part => {
      const bytes = distribution.assets.get(part.file);
      if (!Buffer.isBuffer(bytes) || bytes.byteLength !== part.bytes || hash(bytes) !== part.sha256) {
        throw new Error('FEM application source part differs: ' + name);
      }
      return bytes;
    }));
    if (bytes.byteLength !== pin.bytes || hash(bytes) !== pin.sha256) {
      throw new Error('FEM application source differs: ' + name);
    }
    return bytes;
  };
  const archive = readPinned(application.archive), index = JSON.parse(readPinned(application.index).toString('utf8'));
  if (index.archiveSha256 !== hash(archive) || !record(index.files)) throw new Error('FEM application archive/index differ');
  const { unzipSync } = createRequire(new URL('../../packages/io/package.json', import.meta.url))('fflate');
  const contents = unzipSync(archive, { filter: file => APPLICATION_BUILD_INPUTS.includes(file.name) && file.originalSize <= 1024 * 1024 });
  for (const name of APPLICATION_BUILD_INPUTS) {
    const pin = index.files[name], bytes = contents[name];
    if (!record(pin) || !(bytes instanceof Uint8Array) || bytes.byteLength !== pin.bytes || hash(bytes) !== pin.sha256) {
      throw new Error('FEM application archived build input differs: ' + name);
    }
    if (sourceFileHash(bytes) !== sourceFileHash(buildInputs.get(name))) {
      throw new Error('FEM application source does not match build input: ' + name);
    }
  }
}

const STORED_PART = /\.stored-(\d{3})$/u;
const STORED_PART_MAX_BYTES = 64 * 1024 * 1024;

/**
 * Repository storage only: a source file too large for ordinary Git is kept as explicitly listed, pinned parts
 * `<name>.stored-001...` and joined back to the exact pinned original before the unchanged distribution build.
 * `storedParts` never reaches the shipped manifest; without it the inputs are returned unchanged.
 */
export function joinStoredParts(manifest, files) {
  if (!record(manifest) || !('storedParts' in manifest)) {
    for (const name of files.keys()) if (STORED_PART.test(name)) throw new Error('Unlisted stored FEM part: ' + name);
    return { manifest, files };
  }
  const { storedParts, ...rest } = manifest;
  const entries = record(storedParts) ? Object.entries(storedParts) : [];
  if (entries.length === 0 || entries.length > 4 || !record(rest.files)) throw new Error('Invalid stored FEM parts');
  const joined = new Map(files), listed = new Set();
  for (const [name, parts] of entries) {
    const pin = rest.files[name];
    if (!safePath(name) || !name.startsWith('sources/') || STORED_PART.test(name) || !record(pin)
      || !Array.isArray(parts) || parts.length < 2 || parts.length > 16) throw new Error('Invalid stored FEM parts: ' + name);
    if (files.has(name)) throw new Error('Stored FEM parts mixed with the whole file: ' + name);
    const chunks = parts.map((part, index) => {
      const file = `${name}.stored-${String(index + 1).padStart(3, '0')}`, bytes = files.get(file);
      if (!record(part) || Object.keys(part).sort().join(',') !== 'bytes,file,sha256' || part.file !== file
        || !Number.isSafeInteger(part.bytes) || part.bytes < 1 || part.bytes > STORED_PART_MAX_BYTES
        || !/^[a-f0-9]{64}$/u.test(part.sha256) || !Buffer.isBuffer(bytes)
        || bytes.byteLength !== part.bytes || hash(bytes) !== part.sha256) throw new Error('Stored FEM part changed: ' + file);
      listed.add(file);
      joined.delete(file);
      return bytes;
    });
    const whole = Buffer.concat(chunks);
    if (whole.byteLength !== pin.bytes || hash(whole) !== pin.sha256) throw new Error('Stored FEM parts do not rebuild the original: ' + name);
    joined.set(name, whole);
  }
  for (const name of files.keys()) {
    if (STORED_PART.test(name) && !listed.has(name)) throw new Error('Unlisted stored FEM part: ' + name);
  }
  return { manifest: rest, files: joined };
}

export function assertFemDistributionPublishable(distribution) {
  if (distribution.unresolved.length !== 0) throw new Error('Unresolved FEM distribution: ' + distribution.unresolved.join('; '));
}

const NATIVE_EVIDENCE = 'sources/native-rebuild/replacement-evidence.json';
const NATIVE_PROVENANCE = 'sources/native-rebuild/build-provenance.json';
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);

/**
 * A true nativeRebuildExecuted flag counts only with pinned technical evidence that ties the shipped oofem wheel's
 * source, patches and module to a passed modified rebuild and the product-loader replacement. Never a legal clearance.
 */
export function nativeRebuildEvidenceGaps(manifest, files) {
  const pinned = name => {
    const pin = record(manifest) && record(manifest.files) ? manifest.files[name] : undefined, bytes = files.get(name);
    if (!record(pin) || !Buffer.isBuffer(bytes) || bytes.byteLength !== pin.bytes || hash(bytes) !== pin.sha256) return undefined;
    try { return JSON.parse(bytes.toString('utf8')); } catch { return undefined; }
  };
  const evidence = pinned(NATIVE_EVIDENCE), provenance = pinned(NATIVE_PROVENANCE);
  if (!record(evidence) || evidence.format !== 'pointercad-oofem-native-replacement-evidence/1') {
    return ['FEM: native rebuild evidence is absent or not pinned'];
  }
  if (!record(provenance) || !record(provenance.originalSource) || !record(provenance.output) || !Array.isArray(provenance.patches)) {
    return ['FEM: native build provenance is absent or not pinned'];
  }
  const gaps = [], fail = reason => { gaps.push('FEM: native rebuild evidence ' + reason); };
  const fileSha = name => (record(manifest.files[name]) ? manifest.files[name].sha256 : undefined);
  const only = pattern => {
    const names = Object.keys(manifest.files).filter(name => pattern.test(name));
    return names.length === 1 ? fileSha(names[0]) : undefined;
  };
  const { inputs, rebuild, replacement } = evidence, commit = manifest.oofemSourceCommit;
  const shipped = only(/^assets\/oofem-[^/]+\.whl$/u), pybind11 = only(/^sources\/026-pybind11-[a-f0-9]{40}\.tar\.gz$/u);
  if ('legalClearance' in evidence) fail('must not carry a legal clearance');
  if (!record(inputs) || !record(rebuild) || !record(replacement) || !Array.isArray(inputs.patches) || !Array.isArray(replacement.cases)) {
    fail('is incomplete');
    return gaps;
  }
  if (typeof commit !== 'string' || inputs.oofemCommit !== commit || provenance.originalSource.commit !== commit
    || !digest(inputs.oofemSourceSha256) || inputs.oofemSourceSha256 !== fileSha(`sources/051-oofem-${commit}.tar.gz`)
    || inputs.oofemSourceSha256 !== provenance.originalSource.oofemTarballSha256) fail('does not use the shipped OOFEM source');
  if (!digest(inputs.pybind11SourceSha256) || inputs.pybind11SourceSha256 !== pybind11
    || inputs.pybind11SourceSha256 !== provenance.originalSource.pybind11TarballSha256) fail('does not use the shipped pybind11 source');
  const pairs = list => JSON.stringify(list.map(patch => (record(patch) ? [patch.file, patch.sha256] : null)));
  if (inputs.patches.length === 0 || pairs(inputs.patches) !== pairs(provenance.patches)
    || inputs.patches.some(patch => !record(patch) || !safePath(patch.file) || !digest(patch.sha256)
      || fileSha('sources/native-rebuild/' + patch.file) !== patch.sha256)) fail('does not apply exactly the shipped patches');
  if (!digest(shipped) || evidence.shippedWheelSha256 !== shipped || provenance.output.wheelSha256 !== shipped
    || !digest(evidence.shippedModuleSha256) || evidence.shippedModuleSha256 !== provenance.output.moduleSha256) {
    fail('is not bound to the shipped oofem wheel');
  }
  if (rebuild.passed !== true || !digest(rebuild.wheelSha256) || !digest(rebuild.moduleSha256) || !digest(rebuild.receiptSha256)
    || rebuild.wheelSha256 === shipped || rebuild.moduleSha256 === evidence.shippedModuleSha256 || rebuild.memberNamesIdentical !== true) {
    fail('does not record a passed modified rebuild');
  }
  const passed = id => {
    const matching = replacement.cases.filter(item => record(item) && item.id === id);
    return matching.length === 1 && matching[0].passed === true;
  };
  if (replacement.wheelSha256 !== rebuild.wheelSha256 || replacement.moduleSha256 !== rebuild.moduleSha256
    || !digest(replacement.receiptSha256) || !['modified-accepted', 'original-refused', 'same-size-refused'].every(passed)) {
    fail('does not record the product-loader replacement');
  }
  return gaps;
}

/** Publication metadata is shared with the existing release guard; bundling verifies all bytes separately. */
export function readFemDistributionGaps(folder = join(projectRoot, 'packages/fem/runtime')) {
  const manifest = JSON.parse(readFileSync(join(folder, 'manifest.json'), 'utf8'));
  if (!record(manifest) || manifest.format !== 'pointercad-fem-distribution/1'
    || !Array.isArray(manifest.unresolved) || manifest.unresolved.length > 32
    || manifest.unresolved.some(value => typeof value !== 'string' || value.length === 0 || value.length > 2048)) {
    throw new Error('Invalid FEM publication metadata');
  }
  const gaps = manifest.unresolved.map(value => 'FEM: ' + value);
  if (manifest.correspondingSourceComplete !== true) gaps.push('FEM: corresponding source closure is incomplete');
  if (manifest.nativeRebuildExecuted !== true) gaps.push('FEM: native rebuild and replacement remain unqualified');
  else {
    const files = new Map();
    for (const name of [NATIVE_EVIDENCE, NATIVE_PROVENANCE]) {
      const path = join(folder, ...name.split('/'));
      if (existsSync(path) && lstatSync(path).isFile()) files.set(name, readFileSync(path));
    }
    gaps.push(...nativeRebuildEvidenceGaps(manifest, files));
  }
  return gaps;
}

/** Fixed repository directory only. Refuse links, extra bytes and a changed closure before bundling. */
export function collectFemRuntimeAssets(folder = join(projectRoot, 'packages/fem/runtime')) {
  if (lstatSync(folder).isSymbolicLink()) throw new Error('FEM runtime root is a link');
  const root = realpathSync(folder), files = new Map();
  function walk(directory, prefix, depth) {
    if (depth > 12) throw new Error('FEM runtime path is too deep');
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name), local = prefix + name, stat = lstatSync(path);
      const resolved = relative(root, realpathSync(path));
      if (stat.isSymbolicLink() || resolved === '..' || resolved.startsWith('..' + sep) || isAbsolute(resolved)) {
        throw new Error('FEM runtime path escapes its owner');
      }
      if (stat.isDirectory()) walk(path, local + '/', depth + 1);
      else if (!stat.isFile()) throw new Error('FEM runtime input is not regular');
      else if (local !== 'manifest.json' && local !== '.gitattributes') {
        if (files.size >= 1000 || stat.size > 320 * 1024 * 1024) throw new Error('FEM runtime input exceeds its bound');
        files.set(local, readFileSync(path));
      }
    }
  }
  walk(root, '', 0);
  const stored = joinStoredParts(JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8')), files);
  return buildFemRuntimeAssets(stored.manifest, stored.files);
}

/** Separate classic Worker: Pyodide importScripts never executes in the UI or a module Worker. */
export async function buildFemWorker(root = projectRoot) {
  const output = await build({
    configFile: false, root, publicDir: false, logLevel: 'error',
    resolve: { alias: { '@pointercad/model/beam-analysis': join(root, 'packages/model/src/analysis/index.ts') } },
    build: { write: false, target: 'es2022', minify: true,
      lib: { entry: join(root, 'packages/fem/src/worker.ts'), formats: ['iife'], name: 'PointerCadFemWorker', fileName: () => 'worker.js' },
      rollupOptions: { output: { inlineDynamicImports: true } },
    },
  });
  const bundles = Array.isArray(output) ? output : [output];
  const chunks = bundles.flatMap(bundle => 'output' in bundle ? bundle.output : []);
  if (chunks.length !== 1 || chunks[0].type !== 'chunk' || chunks[0].imports.length !== 0
    || chunks[0].dynamicImports.length !== 0 || chunks[0].fileName !== 'worker.js') {
    throw new Error('FEM Worker must be one local classic script');
  }
  return chunks[0].code;
}

export function femRuntimeAssets(workerContentSecurityPolicy) {
  if (typeof workerContentSecurityPolicy !== 'string' || workerContentSecurityPolicy.length === 0) {
    throw new Error('Shared FEM Worker response policy is required');
  }
  let building = true;
  return {
    name: 'pointercad-fem-runtime-assets',
    config() {
      return { resolve: { alias: { '@pointercad/fem': join(projectRoot, 'packages/fem/src/index.ts') } } };
    },
    configResolved(config) { building = config.command === 'build'; },
    async configureServer(server) {
      const { assets } = collectFemRuntimeAssets();
      assets.set('fem/worker.js', Buffer.from(await buildFemWorker()));
      server.middlewares.use((request, response, next) => {
        const url = new URL(request.url ?? '/', 'http://pointercad.invalid');
        if (!url.pathname.startsWith('/fem/') && !url.pathname.startsWith('/licenses/fem/')) { next(); return; }
        const bytes = assets.get(url.pathname === '/licenses/fem/' ? 'licenses/fem/index.html' : url.pathname.slice(1));
        if (url.search !== '' || bytes === undefined) { response.statusCode = 404; response.end(); return; }
        if (request.method !== 'GET' && request.method !== 'HEAD') { response.statusCode = 405; response.end(); return; }
        if (url.pathname === '/fem/worker.js') response.setHeader('Content-Security-Policy', workerContentSecurityPolicy);
        response.setHeader('Content-Type', /\.(?:mjs|js)$/u.test(url.pathname) ? 'text/javascript'
          : url.pathname.endsWith('.html') || url.pathname === '/licenses/fem/' ? 'text/html; charset=utf-8' : url.pathname.endsWith('.json') ? 'application/json'
            : url.pathname.endsWith('.wasm') ? 'application/wasm' : 'application/octet-stream');
        response.setHeader('Content-Length', String(bytes.byteLength));
        response.setHeader('Cache-Control', 'no-store');
        response.setHeader('X-Content-Type-Options', 'nosniff');
        response.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
        response.end(request.method === 'HEAD' ? undefined : bytes);
      });
    },
    async buildStart() {
      if (!building) return;
      const distribution = collectFemRuntimeAssets();
      assertFemApplicationBuildInputs(distribution, new Map(APPLICATION_BUILD_INPUTS.map(name => [name, readFileSync(join(projectRoot, name))])));
      const { assets } = distribution;
      for (const [fileName, source] of assets) this.emitFile({ type: 'asset', fileName, source });
      this.emitFile({ type: 'asset', fileName: 'fem/worker.js', source: await buildFemWorker() });
    },
  };
}
