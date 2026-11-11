import { expect, type ElectronApplication, type Page, type TestInfo } from '@playwright/test';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open as openFile, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { crc32, deflateSync, inflateSync } from 'node:zlib';
import { readArchive, readPcadFile, writePcadFile } from '../../packages/io/src/index.js';
import { addImage, canvasRow, open, samplePng, save } from './canvasAssetLifetimeFlow.js';
import { chooseToolMenuItem } from './assemblyTestSupport.js';
import { observeSavePointNetwork, writeSavePointEvidence } from './namedSavePointsFlow.js';
import { waitForStartupReady } from './startupHealth.js';
import { fileAction } from './fileCaptureSupport.js';
import { waitForSettledRecompute } from './recompute.js';

const LIMIT = 512 * 1024 * 1024;
const hash = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

async function openCapacityInput(page: Page, name: string, bytes: Buffer,
  expectedNames: readonly string[], info: TestInfo, app?: ElectronApplication): Promise<void> {
  if (app !== undefined) {
    await open(page, name, bytes, info, app);
  } else {
    const path = info.outputPath(name);
    const file = await openFile(path, 'wx');
    try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
    const actual = await readFile(path);
    expect(actual.length).toBe(bytes.length);
    expect(hash(actual)).toBe(hash(bytes));
    await info.attach(name, { path, contentType: 'application/octet-stream' });
    const choosing = page.waitForEvent('filechooser');
    await fileAction(page, '開く').click();
    await (await choosing).setFiles(path);
  }
  // The old document can still be idle while the incoming file is being read.
  // Confirm the actual new document before opening its save-points dialog.
  await expect(page).toHaveTitle(`${name} - PointerCAD`);
  for (const imageName of expectedNames) await expect(canvasRow(page, imageName)).toBeVisible();
  await waitForSettledRecompute(page);
}
function pngChunk(name: string, data: Buffer): Buffer {
  const chunk = Buffer.alloc(data.length + 12);
  chunk.writeUInt32BE(data.length, 0); chunk.write(name, 4, 4, 'ascii'); data.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(chunk.subarray(4, -4)), chunk.length - 4);
  return chunk;
}

/** Real RGBA pixels in valid PNG scanlines; no padding, fake lengths or shelf writes. */
function capacityPng(index: number): Buffer {
  const width = 2048, height = 1000, stride = width * 4 + 1;
  const pixels = Buffer.alloc(stride * height);
  const pattern = Buffer.alloc(256 * 4);
  for (let x = 0; x < 256; x += 1) {
    pattern[x * 4] = index; pattern[x * 4 + 1] = x; pattern[x * 4 + 3] = 255;
  }
  for (let y = 0; y < Math.min(256, height); y += 1) {
    for (let x = 0; x < 256; x += 1) pattern[x * 4 + 2] = y;
    pixels.fill(pattern, y * stride + 1, (y + 1) * stride);
  }
  // The original x & 255 and y & 255 pixels repeat every 256 columns/rows.
  // Copy complete scanlines, including their unchanged zero PNG filter byte.
  for (let y = 256; y < height; y += 1) {
    const from = (y & 255) * stride;
    pixels.copy(pixels, y * stride, from, from + stride);
  }
  const compressed = deflateSync(pixels, { level: 0 });
  expect(Buffer.compare(inflateSync(compressed), pixels)).toBe(0);
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6;
  const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', ihdr), pngChunk('IDAT', compressed), pngChunk('IEND', Buffer.alloc(0))]);
  expect(png.length).toBeLessThan(8 * 1024 * 1024);
  return png;
}

async function shelfMetadata(page: Page) {
  return page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const r = indexedDB.open('pointercad-save-points');
      r.onupgradeneeded = () => { r.transaction?.abort(); reject(new Error('Expected existing shelf')); };
      r.onerror = () => reject(r.error); r.onsuccess = () => resolve(r.result);
    });
    try {
      return await new Promise<{ points: string; blobs: string; keys: string[] }>((resolve, reject) => {
        const tx = db.transaction(['points', 'blobs', 'chunks'], 'readonly');
        const points = tx.objectStore('points').getAll(), blobs = tx.objectStore('blobs').getAll();
        const keys = tx.objectStore('chunks').getAllKeys();
        tx.onerror = () => reject(tx.error); tx.onabort = () => reject(new Error('Shelf read aborted'));
        tx.oncomplete = () => resolve({ points: JSON.stringify(points.result), blobs: JSON.stringify(blobs.result),
          keys: keys.result.map(key => { if (typeof key !== 'string') throw new Error('Invalid chunk key'); return key; }) });
      });
    } finally { db.close(); }
  });
}

/** Only small manifests cross evaluate IPC; raw evidence uses streamed downloads. */
async function createCapacityOracle(page: Page, baseline: Awaited<ReturnType<typeof shelfMetadata>>, nativeTransport: boolean) {
  const databaseName = `pointercad-capacity-oracle:${randomUUID()}`;
  return page.evaluateHandle(async ({ databaseName, baseline, nativeTransport }) => {
    if (Object.hasOwn(globalThis, databaseName)) throw new Error('Oracle transport nonce collision');
    const chunkSize = 1024 * 1024;
    // This fixture's real PNGs and document entries are each below 8 MiB.
    // Reject an unexpected descriptor before allocating; never assemble the shelf.
    const maximumBlobBytes = 8 * chunkSize;
    const rows: unknown = JSON.parse(baseline.blobs);
    if (!Array.isArray(rows)) throw new Error('Missing blob descriptors');
    const descriptors = rows.map((row: unknown) => {
      if (typeof row !== 'object' || row === null || !('version' in row) || row.version !== 1
        || !('sha256' in row) || typeof row.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(row.sha256)
        || !('byteLength' in row) || typeof row.byteLength !== 'number' || !Number.isSafeInteger(row.byteLength)
        || row.byteLength < 0 || row.byteLength >= maximumBlobBytes
        || !('chunkCount' in row) || typeof row.chunkCount !== 'number'
        || row.chunkCount !== Math.max(1, Math.ceil(row.byteLength / chunkSize))) {
        throw new Error('Invalid or unexpectedly large fixture blob descriptor');
      }
      return { sha256: row.sha256, byteLength: row.byteLength, chunkCount: row.chunkCount };
    });
    const expectedKeys = descriptors.flatMap(row => Array.from({ length: row.chunkCount }, (_, index) => `${row.sha256}:${index}`));
    if (new Set(descriptors.map(row => row.sha256)).size !== descriptors.length
      || JSON.stringify([...expectedKeys].sort()) !== JSON.stringify([...baseline.keys].sort())) {
      throw new Error('Descriptor and chunk inventories differ');
    }
    const source = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('pointercad-save-points');
      request.onupgradeneeded = () => { request.transaction?.abort(); reject(new Error('Expected existing shelf')); };
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result);
    });
    let owned = false;
    const removeOwnedDatabase = async (): Promise<void> => {
      if (!owned) return;
      await new Promise<void>((resolve, reject) => {
        const request = indexedDB.deleteDatabase(databaseName);
        request.onerror = () => reject(request.error);
        request.onblocked = () => reject(new Error('Owned oracle cleanup blocked'));
        request.onsuccess = () => { owned = false; resolve(); };
      });
    };
    let oracle: IDBDatabase;
    try {
      oracle = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open(databaseName, 1);
        request.onupgradeneeded = event => {
          if (event.oldVersion !== 0) { request.transaction?.abort(); return; }
          owned = true;
          request.result.createObjectStore('chunks');
        };
        request.onerror = () => reject(request.error);
        request.onblocked = () => reject(new Error('Oracle creation blocked'));
        request.onsuccess = () => {
          if (!owned) { request.result.close(); reject(new Error('Oracle nonce collision')); return; }
          resolve(request.result);
        };
      });
    } catch (error) {
      source.close();
      try { await removeOwnedDatabase(); } catch (cleanupError) { throw new AggregateError([error, cleanupError], 'Oracle initialization and cleanup failed', { cause: cleanupError }); }
      throw error;
    }
    const readChunks = async (db: IDBDatabase, batch: readonly string[]): Promise<Uint8Array[]> => {
      if (batch.length < 1 || batch.length > 4) throw new Error('Chunk read batch out of bounds');
      const rows = await new Promise<unknown[]>((resolve, reject) => {
        const tx = db.transaction('chunks', 'readonly');
        const requests = batch.map(key => tx.objectStore('chunks').get(key));
        tx.onabort = () => reject(tx.error ?? new Error('Chunk read aborted'));
        tx.onerror = () => reject(tx.error);
        tx.oncomplete = () => resolve(requests.map(request => request.result));
      });
      return rows.map((row, index) => {
        const key = batch[index];
        if (typeof row !== 'object' || row === null || !('key' in row) || row.key !== key || !('bytes' in row)
          || !(row.bytes instanceof Uint8Array) || row.bytes.length > chunkSize) throw new Error(`Invalid chunk ${key}`);
        return row.bytes;
      });
    };
    const readChunk = async (db: IDBDatabase, key: string): Promise<Uint8Array> => {
      const [bytes] = await readChunks(db, [key]);
      if (bytes === undefined) throw new Error(`Missing chunk ${key}`);
      return bytes;
    };
    const keys = async (): Promise<string[]> => {
      const result = await new Promise<IDBValidKey[]>((resolve, reject) => {
        const tx = oracle.transaction('chunks', 'readonly'), request = tx.objectStore('chunks').getAllKeys();
        tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error ?? new Error('Oracle inventory aborted'));
        tx.oncomplete = () => resolve(request.result);
      });
      return result.map(key => { if (typeof key !== 'string') throw new Error('Invalid oracle key'); return key; });
    };
    const equalBytes = (actual: Uint8Array, expected: Uint8Array, key: string): void => {
      if (actual.length !== expected.length) throw new Error(`Chunk length changed: ${key}`);
      const left = new DataView(actual.buffer, actual.byteOffset, actual.byteLength);
      const right = new DataView(expected.buffer, expected.byteOffset, expected.byteLength);
      let index = 0;
      // Compare every bit directly in groups of four bytes, then all tail bytes.
      // DataView also handles buffers whose byteOffset is not word-aligned.
      for (; index + 4 <= actual.length; index += 4) {
        if (left.getUint32(index) !== right.getUint32(index)) throw new Error(`Chunk bytes changed: ${key}:${index}`);
      }
      for (; index < actual.length; index += 1) {
        if (actual[index] !== expected[index]) throw new Error(`Chunk byte changed: ${key}:${index}`);
      }
    };
    let sealed = false, capturedBytes = 0, capturedChunks = 0;
    const captured = new Set<string>(), urls = new Set<string>();
    let nativeBlob: Blob | undefined;
    const clearNativeBlob = (): void => {
      if (!nativeTransport || nativeBlob === undefined) return;
      if (Reflect.get(globalThis, databaseName) !== nativeBlob
        || !Reflect.deleteProperty(globalThis, databaseName)) throw new Error('Oracle transport ownership changed');
      nativeBlob = undefined;
    };
    return {
      describe: () => ({ databaseName, descriptors, maximumBlobBytes }),
      capture: async (digest: string) => {
        if (sealed || urls.size !== 0 || captured.has(digest)) throw new Error('Invalid oracle capture order');
        const descriptor = descriptors.find(row => row.sha256 === digest);
        if (descriptor === undefined) throw new Error('Unknown blob');
        const bytes = new Uint8Array(descriptor.byteLength);
        const chunks: { key: string; offset: number; length: number }[] = [];
        for (let index = 0; index < descriptor.chunkCount; index += 1) {
          const key = `${digest}:${index}`, offset = index * chunkSize;
          const actual = await readChunk(source, key);
          if (actual.length !== Math.min(chunkSize, descriptor.byteLength - offset)) throw new Error(`Invalid chunk length: ${key}`);
          await new Promise<void>((resolve, reject) => {
            const tx = oracle.transaction('chunks', 'readwrite');
            tx.onabort = () => reject(tx.error ?? new Error('Oracle copy aborted'));
            tx.onerror = () => reject(tx.error); tx.oncomplete = () => resolve();
            tx.objectStore('chunks').add({ key, bytes: actual.slice() }, key);
          });
          equalBytes(await readChunk(oracle, key), actual, key);
          bytes.set(actual, offset); chunks.push({ key, offset, length: actual.length });
          capturedBytes += actual.length; capturedChunks += 1;
        }
        const digestBytes = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
        const actualHash = [...digestBytes].map(byte => byte.toString(16).padStart(2, '0')).join('');
        if (actualHash !== digest) throw new Error(`Actual blob SHA mismatch: ${digest}`);
        const blob = new Blob([bytes], { type: 'application/octet-stream' });
        const url = URL.createObjectURL(blob);
        urls.add(url); captured.add(digest);
        // One nonce-owned read-only Blob at a time, never product state or a network URL fetch.
        if (nativeTransport) {
          Object.defineProperty(globalThis, databaseName,
            { value: blob, writable: false, enumerable: false, configurable: true });
          nativeBlob = blob;
        }
        return { sha256: actualHash, byteLength: bytes.length, chunks, url, nativeBlobKey: databaseName };
      },
      download: ({ url, filename }: { url: string; filename: string }) => {
        if (!urls.has(url)) throw new Error('Unowned evidence URL');
        const anchor = document.createElement('a'); anchor.href = url; anchor.download = filename;
        document.body.append(anchor);
        try { anchor.click(); } finally { anchor.remove(); }
      },
      release: (url: string) => {
        if (!urls.delete(url)) throw new Error('Unowned evidence URL');
        URL.revokeObjectURL(url);
        clearNativeBlob();
      },
      seal: async () => {
        if (sealed || urls.size !== 0 || captured.size !== descriptors.length
          || JSON.stringify(await keys()) !== JSON.stringify([...baseline.keys].sort())) throw new Error('Incomplete oracle');
        sealed = true;
        return { databaseName, capturedBytes, capturedChunks, capturedBlobs: captured.size };
      },
      compare: async () => {
        if (!sealed || JSON.stringify(await keys()) !== JSON.stringify([...baseline.keys].sort())) throw new Error('Invalid sealed oracle');
        let comparedBytes = 0, comparedChunks = 0;
        for (let offset = 0; offset < baseline.keys.length; offset += 4) {
          const batch = baseline.keys.slice(offset, offset + 4);
          // Two readonly transactions, at most four 1 MiB chunks per database.
          // Release this batch before requesting the next; never read the whole shelf.
          const [actual, original] = await Promise.all([readChunks(source, batch), readChunks(oracle, batch)]);
          for (let index = 0; index < batch.length; index += 1) {
            equalBytes(actual[index], original[index], batch[index]);
            comparedBytes += actual[index].length; comparedChunks += 1;
          }
        }
        return { comparedBytes, comparedChunks };
      },
      dispose: async () => {
        for (const url of urls) URL.revokeObjectURL(url);
        urls.clear(); source.close(); oracle.close(); await removeOwnedDatabase();
        clearNativeBlob();
      },
    };
  }, { databaseName, baseline, nativeTransport });
}

export async function namedSavePointCapacityFlow(page: Page, info: TestInfo, app?: ElectronApplication): Promise<void> {
  const network = observeSavePointNetwork(page.context(), info, 'r16-capacity-network');
  let oracle: Awaited<ReturnType<typeof createCapacityOracle>> | undefined;
  let failure: { error: unknown } | undefined;
  try {
    await waitForStartupReady(page);
    await addImage(page, '容量雛型.png', await samplePng(page, '#357abc', 64));
    const seed = readPcadFile(await save(page, info, 'capacity-seed.pcad', app));
    if (!seed.ok || seed.document.canvases.length !== 1) throw new Error('Real UI seed missing');
    const template = seed.document.canvases[0];
    let candidate = Buffer.alloc(0);
    let candidateNames: readonly string[] = [];
    for (const [batch, count] of [32, 32, 2].entries()) {
      const images = new Map<string, Uint8Array>();
      const canvases = Array.from({ length: count }, (_, offset) => {
        const id = batch * 32 + offset + 1, imageId = `capacity-image-${id}`;
        images.set(imageId, capacityPng(id));
        return { ...template, id: `canvas-${id + 100}`, imageId, name: `容量画像${id}`, visible: false };
      });
      const bytes = Buffer.from(writePcadFile({ ...seed.document, canvases }, {
        attachments: { ...seed.attachments, canvases: images }, savedAt: '2026-10-09T00:00:00.000Z' }));
      expect(bytes.length).toBeLessThan(256 * 1024 * 1024);
      const parsed = readPcadFile(bytes), archive = readArchive(bytes, { shouldExtract: () => true });
      if (!parsed.ok || !archive.ok) throw new Error('Generated capacity PCAD is not valid');
      expect(parsed.attachments.canvases.size).toBe(count);
      for (const [id, image] of images) expect(Buffer.compare(Buffer.from(parsed.attachments.canvases.get(id) ?? []), Buffer.from(image))).toBe(0);
      const firstImage = images.values().next().value;
      if (firstImage === undefined) throw new Error('Missing generated PNG');
      expect(await page.evaluate(async encoded => {
        const bytes = Uint8Array.from(atob(encoded), character => character.charCodeAt(0));
        const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
        const dimensions = [bitmap.width, bitmap.height]; bitmap.close(); return dimensions;
      }, Buffer.from(firstImage).toString('base64'))).toEqual([2048, 1000]);
      if (batch === 2) { candidate = bytes; candidateNames = canvases.map(canvas => canvas.name); }
      if (batch === 2) break;
      await openCapacityInput(page, `capacity-input-${batch}.pcad`, bytes, canvases.map(canvas => canvas.name), info, app);
      await chooseToolMenuItem(page, 'ファイルのほかの操作', '名前付き保存点');
      const dialog = page.getByRole('dialog', { name: '名前付き保存点', exact: true });
      await dialog.getByLabel('保存点の名前', { exact: true }).fill(`容量保存${batch}`);
      await dialog.getByRole('button', { name: 'いまの文書を保存点に残す', exact: true }).click();
      await expect(dialog.getByRole('radio', { name: `容量保存${batch} (部品)`, exact: true })).toBeVisible();
      await dialog.getByRole('button', { name: '閉じる', exact: true }).click();
    }
    await openCapacityInput(page, 'capacity-refused-input.pcad', candidate, candidateNames, info, app);
    const beforeEdit = readPcadFile(await save(page, info, 'capacity-before-edit.pcad', app));
    if (!beforeEdit.ok) throw new Error('Current capacity document unavailable');
    const name = beforeEdit.document.canvases[0].name;
    await canvasRow(page, name).getByRole('button', { name: `${name} の表示を切り替える`, exact: true }).click();
    const currentBytes = await save(page, info, 'capacity-current.pcad', app);
    const current = readPcadFile(currentBytes);
    if (!current.ok) throw new Error('Edited capacity document unavailable');
    const before = await shelfMetadata(page), directory = info.outputPath('capacity-shelf-bytes');
    await mkdir(directory, { recursive: true });
    oracle = await createCapacityOracle(page, before, app !== undefined);
    const baselineOracle = oracle;
    const description = await baselineOracle.evaluate(value => value.describe());
    const blobTotals = new Map<string, number>();
    const rawArtifacts: { sha256: string; byteLength: number; path: string;
      chunks: { key: string; offset: number; length: number }[] }[] = [];
    for (const descriptor of description.descriptors) {
      const captured = await baselineOracle.evaluate((value, digest) => value.capture(digest), descriptor.sha256);
      const filename = `${descriptor.sha256}.raw`, path = join(directory, filename);
      if (app !== undefined) {
        // The real desktop denies all browser downloads. Read only this owned,
        // bounded Blob in its renderer, returning binary directly to main.
        // No raw shelf bytes cross Playwright IPC and no security listener changes.
        const window = await app.browserWindow(page);
        const webContentsId = await window.evaluate((value: import('electron').BrowserWindow) => value.webContents.id);
        await window.dispose();
        const transported = await app.evaluate(async ({ webContents }, request) => {
          const owner = webContents.fromId(request.webContentsId);
          if (owner === undefined || owner.isDestroyed()) throw new Error('Oracle window unavailable');
          if (!request.url.startsWith('blob:') || !/^pointercad-capacity-oracle:[a-f0-9-]{36}$/.test(request.nativeBlobKey)
            || request.byteLength < 0 || request.byteLength >= 8 * 1024 * 1024) throw new Error('Invalid bounded oracle Blob');
          // Read the exact retained Blob, without fetch or any CSP exception.
          const buffer: unknown = await owner.executeJavaScript(`(async () => {
            const blob = Reflect.get(globalThis, ${JSON.stringify(request.nativeBlobKey)});
            if (!(blob instanceof Blob) || blob.size !== ${request.byteLength} || blob.size >= 8 * 1024 * 1024)
              throw new Error('Owned oracle Blob size changed');
            let timer;
            try {
              return await Promise.race([blob.arrayBuffer(), new Promise((_, reject) => {
                timer = setTimeout(() => reject(new Error('Owned oracle Blob read timed out')), 25_000);
              })]);
            } finally { clearTimeout(timer); }
          })()`);
          if (!(buffer instanceof ArrayBuffer)) throw new Error('Native oracle transport did not return binary');
          const bytes = Buffer.from(buffer);
          if (bytes.length !== request.byteLength) throw new Error('Native oracle Blob length changed');
          const { open } = process.getBuiltinModule('fs/promises');
          const file = await open(request.path, 'wx');
          try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
          return { byteLength: bytes.length, webContentsId: owner.id };
        }, { webContentsId, url: captured.url, nativeBlobKey: captured.nativeBlobKey, byteLength: descriptor.byteLength, path });
        expect(transported).toEqual({ byteLength: descriptor.byteLength, webContentsId });
      } else {
        // Subscribe before clicking; exactly one owned URL/download is active at a time.
        const [download] = await Promise.all([
          page.waitForEvent('download'),
          baselineOracle.evaluate((value, request) => value.download(request), { url: captured.url, filename }),
        ]);
        expect(download.url()).toBe(captured.url);
        expect(download.suggestedFilename()).toBe(filename);
        const reserved = await openFile(path, 'wx'); await reserved.close();
        await download.saveAs(path);
        expect(await download.failure()).toBeNull();
      }
      const actual = await readFile(path);
      expect(actual.length).toBe(descriptor.byteLength); expect(hash(actual)).toBe(descriptor.sha256);
      expect(captured.byteLength).toBe(actual.length); expect(captured.sha256).toBe(descriptor.sha256);
      rawArtifacts.push({ sha256: descriptor.sha256, byteLength: actual.length, path, chunks: captured.chunks });
      blobTotals.set(descriptor.sha256, actual.length);
      await baselineOracle.evaluate((value, url) => value.release(url), captured.url);
    }
    expect(await shelfMetadata(page)).toEqual(before);
    const captureCounts = await baselineOracle.evaluate(value => value.seal());
    await writeFile(join(directory, 'manifest.json'), JSON.stringify({ format: 'raw-blob-with-chunk-offsets',
      before, description, captureCounts, rawArtifacts }, null, 2), { flag: 'wx' });
    const actualBytes = [...blobTotals.values()].reduce((sum, length) => sum + length, 0);
    expect(captureCounts.capturedBytes).toBe(actualBytes);
    expect(captureCounts.capturedChunks).toBe(before.keys.length);
    expect(captureCounts.capturedBlobs).toBe(blobTotals.size);
    expect(actualBytes).toBeLessThanOrEqual(LIMIT);
    expect(actualBytes).toBeGreaterThan(500 * 1024 * 1024);
    const proposed = readArchive(currentBytes, { shouldExtract: () => true });
    if (!proposed.ok) throw new Error('Candidate archive unavailable');
    const extra = new Map<string, number>();
    for (const payload of proposed.entries.values()) if (!blobTotals.has(hash(payload))) extra.set(hash(payload), payload.length);
    expect(actualBytes + [...extra.values()].reduce((sum, length) => sum + length, 0)).toBeGreaterThan(LIMIT);
    const comparisons: { comparedBytes: number; comparedChunks: number }[] = [];
    const unchanged = async (includePoints: boolean): Promise<void> => {
      const after = await shelfMetadata(page);
      if (includePoints) expect(after.points).toBe(before.points);
      else {
        const oldRows: unknown = JSON.parse(before.points), newRows: unknown = JSON.parse(after.points);
        if (!Array.isArray(oldRows) || !Array.isArray(newRows)) throw new Error('Missing point rows');
        const retained = newRows.map((row: unknown) => JSON.stringify(row));
        for (const row of oldRows as unknown[]) {
          if (typeof row !== 'object' || row === null || !('id' in row)) throw new Error('Invalid point row');
          if (row.id !== '__meta__') expect(retained).toContain(JSON.stringify(row));
        }
      }
      expect(after.blobs).toBe(before.blobs); expect(after.keys).toEqual(before.keys);
      const comparison = await baselineOracle.evaluate(value => value.compare());
      expect(comparison.comparedBytes).toBe(actualBytes);
      expect(comparison.comparedChunks).toBe(before.keys.length);
      expect(await shelfMetadata(page)).toEqual(after);
      comparisons.push(comparison);
    };
    await chooseToolMenuItem(page, 'ファイルのほかの操作', '名前付き保存点');
    const dialog = page.getByRole('dialog', { name: '名前付き保存点', exact: true });
    await expect(dialog.getByRole('radio')).toHaveCount(2);
    await dialog.getByLabel('保存点の名前', { exact: true }).fill('容量拒否');
    await dialog.getByRole('button', { name: 'いまの文書を保存点に残す', exact: true }).click();
    await expect(dialog.getByRole('alert')).toHaveText('保存点の実体は合計512MiBまでです。');
    await expect(dialog.getByRole('radio')).toHaveCount(2); await unchanged(true);
    await dialog.getByRole('radio', { name: '容量保存0 (部品)', exact: true }).check();
    await dialog.getByLabel('保存点の名前', { exact: true }).fill('追加実体0複製');
    await dialog.getByRole('button', { name: '選んだ保存点を複製', exact: true }).click();
    await expect(dialog.getByRole('radio', { name: '追加実体0複製 (部品)', exact: true })).toBeVisible();
    await expect(dialog.getByRole('radio')).toHaveCount(3); await unchanged(false);
    await dialog.getByRole('button', { name: '閉じる', exact: true }).click();
    const assertCurrent = async (expected: typeof current, suffix: string): Promise<void> => {
      const actual = readPcadFile(await save(page, info, `capacity-${suffix}.pcad`, app));
      if (!actual.ok || !expected.ok) throw new Error('Actual current PCAD decode failed');
      expect(actual.document).toEqual(expected.document);
      const compareBytes = (left: Uint8Array | Float32Array | Uint32Array,
        right: Uint8Array | Float32Array | Uint32Array, location: string): void => {
        const a = Buffer.from(left.buffer, left.byteOffset, left.byteLength);
        const b = Buffer.from(right.buffer, right.byteOffset, right.byteLength);
        if (a.length !== b.length) throw new Error(`${suffix}:${location}: byteLength ${a.length} != ${b.length}`);
        if (Buffer.compare(a, b) === 0) return;
        let offset = 0;
        while (offset < a.length && a[offset] === b[offset]) offset += 1;
        throw new Error(`${suffix}:${location}: byte ${offset}: actual ${a[offset]}, expected ${b[offset]}`);
      };
      const byteMaps: readonly ('shapes' | 'canvases')[] = ['shapes', 'canvases'];
      for (const kind of byteMaps) {
        const left = actual.attachments[kind], right = expected.attachments[kind];
        expect([...left.keys()].sort(), `${suffix}:${kind}: all keys`).toEqual([...right.keys()].sort());
        for (const [key, bytes] of right) {
          const value = left.get(key);
          if (value === undefined) throw new Error(`${suffix}:${kind}:${key}: missing attachment`);
          compareBytes(value, bytes, `${kind}:${key}`);
        }
      }
      expect([...actual.attachments.meshes.keys()].sort(), `${suffix}:meshes: all keys`)
        .toEqual([...expected.attachments.meshes.keys()].sort());
      for (const [key, mesh] of expected.attachments.meshes) {
        const value = actual.attachments.meshes.get(key);
        if (value === undefined) throw new Error(`${suffix}:meshes:${key}: missing attachment`);
        compareBytes(value.positions, mesh.positions, `meshes:${key}:positions`);
        compareBytes(value.normals, mesh.normals, `meshes:${key}:normals`);
        compareBytes(value.indices, mesh.indices, `meshes:${key}:indices`);
      }
      // Node checks every property/map/value/type (including shapeDigests and all
      // typed-array contents); only its scalar result enters Playwright's matcher.
      expect(isDeepStrictEqual(actual.attachments, expected.attachments),
        `${suffix}: complete attachment structure/metadata/types differ; see saved actual PCAD and baseline PCAD`).toBe(true);
    };
    await assertCurrent(current, 'after-refusal');
    await page.locator('canvas.pcad-viewport__canvas').focus(); await page.keyboard.press('Control+z');
    await assertCurrent(beforeEdit, 'undo');
    await page.keyboard.press('Control+Shift+z'); await assertCurrent(current, 'redo');
    await writeSavePointEvidence(info, 'r16-capacity-proof', { actualBytes, limit: LIMIT,
      proposedAdditionalUniqueBytes: [...extra.values()].reduce((sum, length) => sum + length, 0),
      chunkCount: before.keys.length, before, wholeBlobFiles: directory,
      baselineArtifactFormat: 'raw-blob-with-chunk-offsets', captureCounts, comparisons, rawArtifacts,
      createRefusedWithoutShelfMutation: true, cloneAdditionalBytes: 0, fullDocumentAttachmentsAndUndoRetained: true });
  } catch (error) {
    failure = { error };
  }
  const cleanupErrors: unknown[] = [];
  if (oracle !== undefined) {
    try { await oracle.evaluate(value => value.dispose()); } catch (error) { cleanupErrors.push(error); }
    try { await oracle.dispose(); } catch (error) { cleanupErrors.push(error); }
  }
  try { await network.finish(); } catch (error) { cleanupErrors.push(error); }
  if (cleanupErrors.length > 0) {
    throw new AggregateError(failure === undefined ? cleanupErrors : [failure.error, ...cleanupErrors],
      'Capacity cleanup failed; original failure retained', { cause: cleanupErrors[0] });
  }
  if (failure !== undefined) throw failure.error;
}
