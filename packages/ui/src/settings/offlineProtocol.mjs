/** Shared by the build inventory and its browser reader; no Node or filesystem imports. */
export const OFFLINE_ASSET_FORMAT = 'pointercad-offline-assets/1';
export const OFFLINE_ASSET_FORMAT_V2 = 'pointercad-offline-assets/2';
export const OFFLINE_CONTROL_FILES = Object.freeze(['offline-assets.json', 'service-worker.js']);
export const OFFLINE_DEPLOYMENT_FILES = Object.freeze(['_headers', '_redirects']);
export const OFFLINE_MAX_FILES = 20_000;
export const OFFLINE_MAX_V2_FILES = 1_000;
export const OFFLINE_MAX_FILE_BYTES = 26_214_400;
export const OFFLINE_MAX_STREAM_BYTES = 67_108_864;
export const OFFLINE_MAX_TOTAL_BYTES = 1_073_741_824;
export const OFFLINE_MAX_MANIFEST_BYTES = 8_388_608;
export const OFFLINE_MANUAL_NAVIGATION = 'pointercad-offline-navigation/1';
export const OFFLINE_MANUAL_EDITION_QUERY = 'pcad-offline-edition';
export function isPreparedOfflineCacheName(value) {
  return typeof value === 'string' && /^pointercad-offline-edition-v1-[a-f0-9]{64}-[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(value);
}
const hashPattern = /^[a-f0-9]{64}$/u;
const compare = (left, right) => left < right ? -1 : left > right ? 1 : 0;
const record = value => typeof value === 'object' && value !== null && !Array.isArray(value);
const onlyKeys = (value, keys) => Object.keys(value).length === keys.length
  && keys.every(key => Object.hasOwn(value, key));

/** A canonical same-origin path, before URL encoding. */
export function offlineAssetUrl(path) {
  if (typeof path !== 'string' || path.length === 0 || path.length > 2048
    || /[\\%?#:]/u.test(path)
    || [...path].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) {
    throw new Error('Invalid offline asset path');
  }
  const parts = path.split('/');
  if (parts.some(part => part === '' || part === '.' || part === '..' || part.endsWith('.') || part.endsWith(' '))) {
    throw new Error('Ambiguous offline asset path: ' + path);
  }
  return parts.map(part => encodeURIComponent(part)).join('/');
}

/** Canonical route on the selected Cloudflare Pages host; the physical file name stays in the inventory. */
export function offlineAssetRoute(url) {
  if (typeof url !== 'string' || offlineAssetUrl(decodeURIComponent(url)) !== url) throw new Error('Noncanonical offline asset URL');
  return url.replace(/(^|\/)index\.html$/u, '$1').replace(/\.html$/u, '');
}

/** Make the exact hash input without timestamps, self-hashes, or object property-order dependence. */
export function offlineManifestBody(manifest) {
  return {
    format: manifest.format, entry: manifest.entry, totalBytes: manifest.totalBytes,
    required: [...manifest.required],
    assets: manifest.assets.map(asset => ({ url: asset.url, byteLength: asset.byteLength, sha256: asset.sha256,
      ...(manifest.format === OFFLINE_ASSET_FORMAT_V2 && asset.transport !== undefined
        ? { transport: { encoding: asset.transport.encoding, byteLength: asset.transport.byteLength,
          sha256: asset.transport.sha256 } } : {}) })),
  };
}

export function isOfflineStreamAsset(asset) {
  return record(asset) && typeof asset.url === 'string' && typeof asset.sha256 === 'string'
    && asset.url === `occt/stream/opencascade.full-${asset.sha256}.wasm`;
}

function canonicalApplicationUrl(url) {
  if (typeof url !== 'string') throw new Error('Invalid offline asset URL');
  const path = decodeURIComponent(url);
  if (offlineAssetUrl(path) !== url) throw new Error('Noncanonical offline asset URL');
  if (OFFLINE_CONTROL_FILES.includes(path.toLowerCase()) || OFFLINE_DEPLOYMENT_FILES.includes(path.toLowerCase())) {
    throw new Error('Control or deployment file supplied as an application asset: ' + path);
  }
  return path;
}

/** Validate unknown network data before allocating or downloading any listed asset. */
export async function readOfflineAssetManifest(value) {
  const v2 = record(value) && value.format === OFFLINE_ASSET_FORMAT_V2;
  if (!record(value) || (!v2 && value.format !== OFFLINE_ASSET_FORMAT)
    || (v2 && !onlyKeys(value, ['format', 'entry', 'totalBytes', 'required', 'assets', 'buildId']))
    || value.entry !== 'index.html'
    || !Number.isSafeInteger(value.totalBytes) || value.totalBytes <= 0 || value.totalBytes > OFFLINE_MAX_TOTAL_BYTES
    || typeof value.buildId !== 'string' || !hashPattern.test(value.buildId)
    || !Array.isArray(value.assets) || value.assets.length === 0 || value.assets.length > (v2 ? OFFLINE_MAX_V2_FILES : OFFLINE_MAX_FILES)
    || !Array.isArray(value.required) || value.required.length === 0 || value.required.length > (v2 ? OFFLINE_MAX_V2_FILES : OFFLINE_MAX_FILES)) {
    throw new Error('Invalid offline edition inventory');
  }
  const assets = [], used = new Set(), folded = new Set(), routes = new Set();
  let totalBytes = 0, transportTotalBytes = 0, previous = '';
  for (const asset of value.assets) {
    const stream = v2 && isOfflineStreamAsset(asset);
    if (!record(asset) || !Number.isSafeInteger(asset.byteLength) || asset.byteLength <= 0
      || asset.byteLength > (stream ? OFFLINE_MAX_STREAM_BYTES : OFFLINE_MAX_FILE_BYTES)
      || typeof asset.sha256 !== 'string' || !hashPattern.test(asset.sha256)
      || (v2 && !onlyKeys(asset, stream
        ? ['url', 'byteLength', 'sha256', 'transport'] : ['url', 'byteLength', 'sha256']))
      || (v2 && 'transport' in asset && (!stream || !record(asset.transport)
        || !onlyKeys(asset.transport, ['encoding', 'byteLength', 'sha256'])
        || asset.transport.encoding !== 'gzip' || !Number.isSafeInteger(asset.transport.byteLength)
        || asset.transport.byteLength <= 0 || asset.transport.byteLength > OFFLINE_MAX_FILE_BYTES
        || typeof asset.transport.sha256 !== 'string' || !hashPattern.test(asset.transport.sha256)))
      || (stream && !('transport' in asset))
      || (v2 && !stream && typeof asset.url === 'string' && asset.url.startsWith('occt/stream/'))) {
      throw new Error('Invalid offline asset record');
    }
    const path = canonicalApplicationUrl(asset.url);
    const route = offlineAssetRoute(asset.url);
    if (compare(previous, asset.url) >= 0 || used.has(asset.url) || folded.has(path.toLowerCase()) || routes.has(route)) {
      throw new Error('Duplicate or unordered offline asset');
    }
    previous = asset.url; used.add(asset.url); folded.add(path.toLowerCase()); routes.add(route);
    totalBytes += asset.byteLength;
    transportTotalBytes += stream ? asset.transport.byteLength : asset.byteLength;
    if (!Number.isSafeInteger(totalBytes) || totalBytes > OFFLINE_MAX_TOTAL_BYTES) throw new Error('Offline edition is too large');
    if (!Number.isSafeInteger(transportTotalBytes) || transportTotalBytes > OFFLINE_MAX_TOTAL_BYTES) {
      throw new Error('Offline transport is too large');
    }
    assets.push(Object.freeze({ url: asset.url, byteLength: asset.byteLength, sha256: asset.sha256,
      ...(stream ? { transport: Object.freeze({ encoding: 'gzip', byteLength: asset.transport.byteLength,
        sha256: asset.transport.sha256 }) } : {}) }));
  }
  if (totalBytes !== value.totalBytes) throw new Error('Offline inventory total does not match its assets');
  const required = []; previous = '';
  for (const url of value.required) {
    canonicalApplicationUrl(url);
    if (compare(previous, url) >= 0 || !used.has(url)) throw new Error('Missing, duplicate or unordered required offline asset');
    previous = url; required.push(url);
  }
  if (!required.includes('index.html')) throw new Error('Offline entry HTML must be required');
  const manifest = Object.freeze({ format: value.format, entry: 'index.html', totalBytes,
    required: Object.freeze(required), assets: Object.freeze(assets), buildId: value.buildId });
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new globalThis.TextEncoder().encode(JSON.stringify(offlineManifestBody(manifest))));
  const actual = [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
  if (actual !== manifest.buildId) throw new Error('Offline inventory content does not match its edition');
  return manifest;
}
