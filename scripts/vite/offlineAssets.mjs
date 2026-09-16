/** Build-time inventory for a complete offline edition. No cache or deployment is changed here. */
import { createHash } from 'node:crypto';
import { lstat, readFile, readdir, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import {
  OFFLINE_ASSET_FORMAT, OFFLINE_CONTROL_FILES, OFFLINE_DEPLOYMENT_FILES,
  OFFLINE_MAX_FILES, OFFLINE_MAX_FILE_BYTES, OFFLINE_MAX_TOTAL_BYTES, OFFLINE_MAX_MANIFEST_BYTES,
  offlineAssetUrl, offlineAssetRoute, offlineManifestBody,
} from './offlineProtocol.mjs';
export {
  OFFLINE_ASSET_FORMAT, OFFLINE_CONTROL_FILES, OFFLINE_DEPLOYMENT_FILES,
  OFFLINE_MAX_FILES, OFFLINE_MAX_FILE_BYTES, OFFLINE_MAX_TOTAL_BYTES, offlineAssetUrl,
} from './offlineProtocol.mjs';
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const compare = (left, right) => left < right ? -1 : left > right ? 1 : 0;

/** Inventory the final emitted bytes, including nested Workers, fonts, and all manual volumes. */
export function createOfflineAssetManifest(files, requiredPaths) {
  if (!Array.isArray(files) || files.length === 0 || files.length > OFFLINE_MAX_FILES) {
    throw new Error('Invalid offline asset count');
  }
  if (!Array.isArray(requiredPaths) || requiredPaths.length === 0 || requiredPaths.length > OFFLINE_MAX_FILES) {
    throw new Error('Missing or excessive required offline assets');
  }
  const used = new Set(), folded = new Set(), routes = new Set(), records = [];
  let totalBytes = 0;
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
    totalBytes += file.bytes.byteLength;
    if (!Number.isSafeInteger(totalBytes) || totalBytes > OFFLINE_MAX_TOTAL_BYTES) throw new Error('Offline edition is too large');
    records.push(Object.freeze({ url, byteLength: file.bytes.byteLength, sha256: sha256(file.bytes) }));
  }
  records.sort((left, right) => compare(left.url, right.url));
  const required = requiredPaths.map(offlineAssetUrl).sort(compare);
  if (new Set(required).size !== required.length) throw new Error('Duplicate required offline asset');
  for (const url of required) if (!used.has(url)) throw new Error('Missing required offline asset: ' + url);
  if (!required.includes('index.html')) throw new Error('Offline entry HTML must be required');
  const body = { format: OFFLINE_ASSET_FORMAT, entry: 'index.html', totalBytes, required,
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
