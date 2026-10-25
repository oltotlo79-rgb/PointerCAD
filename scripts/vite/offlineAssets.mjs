/** Build-time inventory for a complete offline edition. No cache or deployment is changed here. */
import { createHash } from 'node:crypto';
import { lstat, readFile, readdir, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { gunzipSync } from 'node:zlib';
import {
  OFFLINE_ASSET_FORMAT, OFFLINE_ASSET_FORMAT_V2, OFFLINE_CONTROL_FILES, OFFLINE_DEPLOYMENT_FILES,
  OFFLINE_MAX_FILES, OFFLINE_MAX_V2_FILES, OFFLINE_MAX_FILE_BYTES, OFFLINE_MAX_STREAM_BYTES,
  OFFLINE_MAX_TOTAL_BYTES, OFFLINE_MAX_MANIFEST_BYTES,
  offlineAssetUrl, offlineAssetRoute, offlineManifestBody,
} from './offlineProtocol.mjs';
export {
  OFFLINE_ASSET_FORMAT, OFFLINE_CONTROL_FILES, OFFLINE_DEPLOYMENT_FILES,
  OFFLINE_MAX_FILES, OFFLINE_MAX_FILE_BYTES, OFFLINE_MAX_TOTAL_BYTES, offlineAssetUrl,
} from './offlineProtocol.mjs';
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const compare = (left, right) => left < right ? -1 : left > right ? 1 : 0;
const hashPattern = /^[a-f0-9]{64}$/u;
const record = value => typeof value === 'object' && value !== null && !Array.isArray(value);

function verifiedStream(files) {
  const byPath = new Map(files.map(file => [file.path, file.bytes]));
  const raw = byPath.get('occt/manifest.json');
  const streamFiles = files.filter(file => file.path.startsWith('occt/stream/'));
  if (raw === undefined) {
    if (streamFiles.length !== 0) throw new Error('Missing OCCT stream manifest');
    return undefined;
  }
  if (!(raw instanceof Uint8Array) || raw.byteLength > OFFLINE_MAX_MANIFEST_BYTES) {
    if (streamFiles.length !== 0) throw new Error('Invalid OCCT manifest');
    return undefined;
  }
  let manifest;
  try { manifest = JSON.parse(new globalThis.TextDecoder('utf-8', { fatal: true }).decode(raw)); }
  catch {
    if (streamFiles.length !== 0) throw new Error('Invalid OCCT manifest');
    return undefined;
  }
  if (!record(manifest) || manifest.stream === undefined) {
    if (streamFiles.length !== 0) throw new Error('Unlisted OCCT stream asset');
    return undefined;
  }
  const stream = manifest.stream;
  if (!record(stream) || !hashPattern.test(manifest.sha256) || manifest.compression !== 'gzip'
    || !Number.isSafeInteger(manifest.byteLength)
    || manifest.byteLength <= 0 || manifest.byteLength > OFFLINE_MAX_STREAM_BYTES
    || stream.file !== `stream/opencascade.full-${manifest.sha256}.wasm`
    || stream.compression !== 'gzip' || stream.decodedByteLength !== manifest.byteLength
    || stream.decodedSha256 !== manifest.sha256 || !Number.isSafeInteger(stream.transportByteLength)
    || stream.transportByteLength <= 0 || stream.transportByteLength > OFFLINE_MAX_FILE_BYTES
    || !hashPattern.test(stream.transportSha256) || !Array.isArray(manifest.parts)
    || manifest.parts.length !== 1 || !record(manifest.parts[0]) || manifest.parts[0].order !== 0
    || manifest.parts[0].byteLength !== stream.transportByteLength
    || manifest.parts[0].file !== `opencascade.full-${manifest.sha256.slice(0, 16)}.bin`) {
    throw new Error('Invalid OCCT stream manifest');
  }
  const path = `occt/${stream.file}`, compressed = byPath.get(path);
  const legacy = byPath.get(`occt/${manifest.parts[0].file}`);
  if (!(compressed instanceof Uint8Array) || compressed.byteLength !== stream.transportByteLength
    || sha256(compressed) !== stream.transportSha256 || !(legacy instanceof Uint8Array)
    || legacy.byteLength !== compressed.byteLength || sha256(legacy) !== stream.transportSha256
    || streamFiles.length !== 1) {
    throw new Error('OCCT stream transport does not match emitted gzip');
  }
  let decoded;
  try { decoded = gunzipSync(compressed, { maxOutputLength: manifest.byteLength + 1 }); }
  catch { throw new Error('OCCT stream gzip exceeds decoded bound or is invalid'); }
  if (decoded.byteLength !== manifest.byteLength || sha256(decoded) !== manifest.sha256) {
    throw new Error('OCCT stream decoded bytes do not match manifest');
  }
  return { path, byteLength: decoded.byteLength, sha256: manifest.sha256,
    transport: Object.freeze({ encoding: 'gzip', byteLength: compressed.byteLength, sha256: stream.transportSha256 }) };
}

/** Inventory the final emitted bytes, including nested Workers, fonts, and all manual volumes. */
export function createOfflineAssetManifest(files, requiredPaths) {
  if (!Array.isArray(files) || files.length === 0 || files.length > OFFLINE_MAX_FILES) {
    throw new Error('Invalid offline asset count');
  }
  const stream = verifiedStream(files);
  const maxFiles = stream === undefined ? OFFLINE_MAX_FILES : OFFLINE_MAX_V2_FILES;
  if (files.length > maxFiles) throw new Error('Invalid offline v2 asset count');
  if (!Array.isArray(requiredPaths) || requiredPaths.length === 0 || requiredPaths.length > maxFiles) {
    throw new Error('Missing or excessive required offline assets');
  }
  const used = new Set(), folded = new Set(), routes = new Set(), records = [];
  let totalBytes = 0, transportTotalBytes = 0;
  for (const file of files) {
    const url = offlineAssetUrl(file.path);
    if (OFFLINE_CONTROL_FILES.includes(file.path.toLowerCase()) || OFFLINE_DEPLOYMENT_FILES.includes(file.path.toLowerCase())) {
      throw new Error('Control or deployment file supplied as an application asset: ' + file.path);
    }
    const collisionKey = file.path.toLowerCase();
    const route = offlineAssetRoute(url);
    if (used.has(url) || folded.has(collisionKey) || routes.has(route)) throw new Error('Duplicate offline asset or public route: ' + file.path);
    if (!(file.bytes instanceof Uint8Array) || file.bytes.byteLength === 0
      || file.bytes.byteLength > OFFLINE_MAX_FILE_BYTES) throw new Error('Invalid offline asset size: ' + file.path);
    used.add(url); folded.add(collisionKey); routes.add(route);
    const streamed = file.path === stream?.path;
    totalBytes += streamed ? stream.byteLength : file.bytes.byteLength;
    transportTotalBytes += file.bytes.byteLength;
    if (!Number.isSafeInteger(totalBytes) || totalBytes > OFFLINE_MAX_TOTAL_BYTES) throw new Error('Offline edition is too large');
    if (!Number.isSafeInteger(transportTotalBytes) || transportTotalBytes > OFFLINE_MAX_TOTAL_BYTES) {
      throw new Error('Offline transport is too large');
    }
    records.push(Object.freeze(streamed
      ? { url, byteLength: stream.byteLength, sha256: stream.sha256, transport: stream.transport }
      : { url, byteLength: file.bytes.byteLength, sha256: sha256(file.bytes) }));
  }
  records.sort((left, right) => compare(left.url, right.url));
  const required = requiredPaths.map(offlineAssetUrl).sort(compare);
  if (new Set(required).size !== required.length) throw new Error('Duplicate required offline asset');
  for (const url of required) if (!used.has(url)) throw new Error('Missing required offline asset: ' + url);
  if (!required.includes('index.html')) throw new Error('Offline entry HTML must be required');
  const body = { format: stream === undefined ? OFFLINE_ASSET_FORMAT : OFFLINE_ASSET_FORMAT_V2,
    entry: 'index.html', totalBytes, required,
    assets: records };
  // Stable order and exact bytes give the same identifier on both OSes; no timestamp or self-hash.
  const buildId = sha256(JSON.stringify(offlineManifestBody(body)));
  if (new globalThis.TextEncoder().encode(JSON.stringify({ ...body, buildId })).byteLength > OFFLINE_MAX_MANIFEST_BYTES) {
    throw new Error('Offline inventory is too large');
  }
  return Object.freeze({ ...body, required: Object.freeze(required), assets: Object.freeze(records), buildId });
}

/** Read only a completed output folder within the project. Symbolic links are never traversed. */
export async function collectOfflineAssetFiles(projectRoot, outputFolder) {
  const root = await realpath(projectRoot), folder = resolve(outputFolder);
  const local = relative(root, folder);
  if (local === '' || isAbsolute(local) || local === '..' || local.startsWith('..' + sep)) {
    throw new Error('Offline output must be inside the project');
  }
  let cursor = root;
  for (const part of local.split(sep)) {
    cursor = resolve(cursor, part);
    const info = await lstat(cursor);
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('Offline output contains a link or non-directory');
  }
  const files = [], excluded = [];
  let totalBytes = 0, visitedEntries = 0;
  const walk = async (directory, depth = 0) => {
    if (depth > 32) throw new Error('Offline asset folders are too deep');
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => compare(left.name, right.name));
    for (const entry of entries) {
      visitedEntries += 1;
      if (visitedEntries > OFFLINE_MAX_FILES * 2) throw new Error('Too many offline folders or assets');
      const path = resolve(directory, entry.name);
      const name = relative(folder, path).split(sep).join('/');
      if (entry.isSymbolicLink()) throw new Error('Offline asset is a link: ' + name);
      if (entry.isDirectory()) { await walk(path, depth + 1); continue; }
      if (!entry.isFile()) throw new Error('Offline asset is not a file: ' + name);
      if (OFFLINE_CONTROL_FILES.includes(name) || OFFLINE_DEPLOYMENT_FILES.includes(name)) {
        excluded.push(name); continue;
      }
      if (files.length >= OFFLINE_MAX_FILES) throw new Error('Too many offline assets');
      const before = await lstat(path);
      if (!before.isFile() || before.isSymbolicLink() || before.size === 0 || before.size > OFFLINE_MAX_FILE_BYTES
        || totalBytes + before.size > OFFLINE_MAX_TOTAL_BYTES) throw new Error('Invalid offline asset: ' + name);
      const bytes = await readFile(path);
      const after = await lstat(path);
      if (!after.isFile() || after.isSymbolicLink() || bytes.byteLength !== before.size
        || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ino !== before.ino) {
        throw new Error('Offline asset changed while reading: ' + name);
      }
      totalBytes += bytes.byteLength;
      files.push({ path: name, bytes });
    }
  };
  await walk(folder);
  return { files, excluded };
}
