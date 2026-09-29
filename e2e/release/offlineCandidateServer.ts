import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { readFile, lstat } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { offlineAssetRoute, offlineAssetUrl, readOfflineAssetManifest } from '../../scripts/vite/offlineProtocol.mjs';
import { captureWebBuildSources } from '../../scripts/vite/webBuildSources.mjs';
import { sourceFileHash } from '../../scripts/release/desktopFileInventory.mjs';

export interface OfflineCandidateFaults {
  /** Asset path whose served preparation bytes differ in one byte. */
  readonly corrupt?: string;
  /** Number of preparation asset responses that complete before the connection drops. */
  readonly disconnectAfterAssets?: number;
}

/** Serve the exact assembled bytes and deployment headers, without a dev server or diagnostic product build. */
export async function serveOfflineCandidate() {
  const root = fileURLToPath(new URL('../..', import.meta.url)), name = process.env.PCAD_OFFLINE_CANDIDATE;
  assert(name !== undefined && /^[a-z0-9][a-z0-9-]*$/u.test(name), 'Specify an existing candidate name under dist/.');
  const folder = resolve(root, 'dist', name);
  for (const path of [join(root, 'dist'), folder]) assert(!(await lstat(path)).isSymbolicLink());
  const manifest = await readOfflineAssetManifest(JSON.parse(await readFile(join(folder, 'offline-assets.json'), 'utf8')));
  const build = JSON.parse(await readFile(join(folder, 'web-build.json'), 'utf8')) as { inputs: Record<string, string> };
  assert.deepEqual(await captureWebBuildSources(root), build.inputs, 'Candidate sources changed; build and assemble a fresh candidate.');
  const manual = JSON.parse(await readFile(join(folder, 'manual/manifest.json'), 'utf8')) as { inputs: Record<string, string> };
  for (const [name, expected] of Object.entries(manual.inputs)) {
    offlineAssetUrl(name);
    let path = root;
    for (const component of name.split('/')) {
      path = join(path, component); assert(!(await lstat(path)).isSymbolicLink());
    }
    assert.equal(sourceFileHash(await readFile(path)), expected, 'Manual source changed: ' + name);
  }
  const files = new Map<string, { bytes: Buffer; file: string }>();
  for (const asset of [...manifest.assets, { url: 'offline-assets.json' }, { url: 'service-worker.js' }]) {
    const file = decodeURIComponent(asset.url), bytes = await readFile(join(folder, file));
    if ('sha256' in asset) assert.equal(createHash('sha256').update(bytes).digest('hex'), asset.sha256, file);
    const value = { bytes, file };
    files.set('/' + asset.url, value); files.set('/' + offlineAssetRoute(asset.url), value);
  }
  // Match the host's checked-in header rules; do not invent headers that could hide a deployment omission.
  const rules: { pattern: RegExp; headers: Record<string, string> }[] = [];
  for (const line of (await readFile(join(folder, '_headers'), 'utf8')).split(/\r?\n/u)) {
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue;
    if (line.startsWith('/')) {
      const escaped = line.trim().replace(/[.+?^${}()|[\]\\]/gu, '\\$&').replaceAll('*', '.*').replace(/:[a-z]+/gu, '[^/]+');
      rules.push({ pattern: new RegExp('^' + escaped + '$', 'u'), headers: {} });
    } else {
      const colon = line.indexOf(':'); assert(colon > 0 && rules.length > 0);
      rules[rules.length - 1].headers[line.slice(0, colon).trim()] = line.slice(colon + 1).trim();
    }
  }
  const mime: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript',
    '.css': 'text/css', '.json': 'application/json', '.wasm': 'application/wasm', '.pdf': 'application/pdf',
    '.png': 'image/png', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8' };
  const offlineRequests: { path: string; destination: string; serviceWorker: string; status: number }[] = [];
  let disconnected = false;
  // Fault injection applies only to the product's preparation downloads (its own request marker),
  // never to ordinary page loads, so an injected failure cannot be mistaken for a broken page.
  let faults: OfflineCandidateFaults = {}, preparedAssets = 0;
  const injected: { path: string; fault: 'corrupt' | 'disconnect' }[] = [];
  const server = createServer((request, response) => {
    if (disconnected) {
      const detail = { path: request.url ?? '/', destination: String(request.headers['sec-fetch-dest'] ?? ''),
        serviceWorker: String(request.headers['service-worker'] ?? ''), status: 503 };
      offlineRequests.push(detail); console.log('[切断後の要求]', JSON.stringify(detail));
      response.writeHead(503); response.end('Network disconnected'); return;
    }
    const pathname = new URL(request.url ?? '/', 'http://localhost').pathname, file = files.get(pathname);
    const headers: Record<string, string> = { 'Content-Type': mime[extname(file?.file ?? '')] ?? 'application/octet-stream',
      'Cache-Control': 'no-store' };
    for (const rule of rules) if (rule.pattern.test(pathname)) Object.assign(headers, rule.headers);
    let bytes = file?.bytes;
    if (file !== undefined && bytes !== undefined && request.headers['x-pointercad-offline-prepare'] === '1'
      && file.file !== 'offline-assets.json') {
      preparedAssets += 1;
      if (faults.disconnectAfterAssets !== undefined && preparedAssets > faults.disconnectAfterAssets) {
        // Send part of the body, then drop the connection as a lost network would.
        injected.push({ path: file.file, fault: 'disconnect' });
        response.writeHead(200, headers); response.write(bytes.subarray(0, Math.floor(bytes.byteLength / 2)));
        request.socket.destroy(); return;
      }
      if (faults.corrupt === file.file) {
        // Same length, one different byte: only the content fingerprint can detect it.
        injected.push({ path: file.file, fault: 'corrupt' });
        bytes = Buffer.from(bytes); bytes[0] ^= 0x20;
      }
    }
    response.writeHead(file === undefined ? 404 : 200, headers); response.end(bytes ?? 'Missing candidate asset');
  });
  await new Promise<void>((accept, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { server.removeListener('error', reject); accept(); });
  });
  const address = server.address(); assert(address !== null && typeof address !== 'string');
  return { url: `http://127.0.0.1:${address.port}/`, manifest, folder,
    disconnect: () => { disconnected = true; }, networkRequestsAfterDisconnect: () => [...offlineRequests],
    /** Replace the preparation faults; the asset count restarts so each attempt is independent. */
    inject: (next: OfflineCandidateFaults) => {
      if (next.corrupt !== undefined) assert(manifest.assets.some(asset => decodeURIComponent(asset.url) === next.corrupt));
      faults = { ...next }; preparedAssets = 0;
    },
    injectedFaults: () => [...injected],
    close: () => new Promise<void>((accept, reject) => {
      server.close(error => { if (error !== undefined) reject(error); else accept(); }); server.closeAllConnections();
    }) };
}
