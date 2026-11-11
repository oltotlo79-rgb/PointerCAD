import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';

import { describe, expect, it } from 'vitest';

import {
  decompressAndVerifyOcctAsset,
  parseOcctAssetManifest,
  type DownloadedOcctAssetPart,
  type OcctAssetManifest,
} from './occtAssetManifest.js';

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copied = new Uint8Array(bytes.byteLength);
  copied.set(bytes);
  return copied.buffer;
}

function fixture(): {
  readonly manifest: OcctAssetManifest;
  readonly downloaded: readonly DownloadedOcctAssetPart[];
  readonly expected: Uint8Array;
} {
  const first = new TextEncoder().encode('PointerCAD OCCT asset: first part.');
  const second = new TextEncoder().encode('And the second part.');
  const expected = new Uint8Array(first.byteLength + second.byteLength);
  expected.set(first, 0);
  expected.set(second, first.byteLength);
  const compressed = [gzipSync(first), gzipSync(second)].map(toArrayBuffer);
  const manifest: OcctAssetManifest = {
    byteLength: expected.byteLength,
    sha256: createHash('sha256').update(expected).digest('hex'),
    compression: 'gzip',
    parts: compressed.map((data, order) => ({
      order,
      file: `part-${order}.bin`,
      byteLength: data.byteLength,
    })),
  };
  return {
    manifest,
    downloaded: compressed.map((data, order) => ({ order, data })),
    expected,
  };
}

describe('OCCT 圧縮資産の復元と検証', () => {
  it('旧 manifest と hash64 の stream 付き manifest を読み分ける', () => {
    const data = fixture();
    expect(parseOcctAssetManifest(data.manifest).stream).toBeUndefined();
    const first = data.manifest.parts[0];
    if (first === undefined) throw new Error('検査用の片がありません。');
    const singlePartManifest = { ...data.manifest, parts: [first] };
    const stream = {
      file: `stream/opencascade.full-${data.manifest.sha256}.wasm`,
      compression: 'gzip',
      transportByteLength: data.downloaded[0]?.data.byteLength ?? 0,
      transportSha256: 'a'.repeat(64),
      decodedByteLength: data.manifest.byteLength,
      decodedSha256: data.manifest.sha256,
    };
    expect(parseOcctAssetManifest({ ...singlePartManifest, stream }).stream).toEqual(stream);
    for (const file of [
      `stream/opencascade.full-${data.manifest.sha256}.wasm?x=1`,
      `stream/%6fpencascade.full-${data.manifest.sha256}.wasm`,
      `stream/../opencascade.full-${data.manifest.sha256}.wasm`,
      `https://elsewhere.example/stream/opencascade.full-${data.manifest.sha256}.wasm`,
      `stream/opencascade.full-${'0'.repeat(64)}.wasm`,
    ]) {
      expect(() => parseOcctAssetManifest({ ...singlePartManifest, stream: { ...stream, file } })).toThrow('stream');
    }
    expect(() => parseOcctAssetManifest({ ...singlePartManifest, stream: {
      ...stream, decodedByteLength: 64 * 1024 * 1024 + 1,
    } })).toThrow('stream');
    expect(() => parseOcctAssetManifest({ ...singlePartManifest, stream: {
      ...stream, decodedSha256: '0'.repeat(64),
    } })).toThrow('stream');
    expect(() => parseOcctAssetManifest({
      ...singlePartManifest,
      parts: [{ ...first, byteLength: 25 * 1024 * 1024 + 1 }],
      stream: { ...stream, transportByteLength: 25 * 1024 * 1024 + 1 },
    })).toThrow('stream');
  });

  it('manifest 順に gzip の片を連結して元のバイト列を返す', async () => {
    const data = fixture();
    const restored = await decompressAndVerifyOcctAsset(data.manifest, data.downloaded);
    expect(new Uint8Array(restored)).toEqual(data.expected);
  });

  it('順序が違う片を拒む', async () => {
    const data = fixture();
    await expect(
      decompressAndVerifyOcctAsset(data.manifest, [data.downloaded[1], data.downloaded[0]]),
    ).rejects.toThrow('順序');
  });

  it('欠けた片を拒む', async () => {
    const data = fixture();
    await expect(decompressAndVerifyOcctAsset(data.manifest, [data.downloaded[0]])).rejects.toThrow(
      '足りません',
    );
  });

  it('SHA-256 が一致しない復元結果を拒む', async () => {
    const data = fixture();
    const manifest: OcctAssetManifest = { ...data.manifest, sha256: '0'.repeat(64) };
    await expect(decompressAndVerifyOcctAsset(manifest, data.downloaded)).rejects.toThrow('SHA-256');
  });

  it('stream 付き manifest の旧 bin でも圧縮輸送 SHA-256 を照合する', async () => {
    const bytes = new TextEncoder().encode('same decoded bytes');
    const compressed = toArrayBuffer(gzipSync(bytes));
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const manifest = parseOcctAssetManifest({
      byteLength: bytes.byteLength,
      sha256,
      compression: 'gzip',
      parts: [{ order: 0, file: 'asset.bin', byteLength: compressed.byteLength }],
      stream: {
        file: `stream/opencascade.full-${sha256}.wasm`,
        compression: 'gzip',
        transportByteLength: compressed.byteLength,
        transportSha256: '0'.repeat(64),
        decodedByteLength: bytes.byteLength,
        decodedSha256: sha256,
      },
    });
    await expect(decompressAndVerifyOcctAsset(manifest, [{ order: 0, data: compressed }]))
      .rejects.toThrow('圧縮輸送 SHA-256');
  });

  it('復元後の byteLength が一致しない結果を拒む', async () => {
    const data = fixture();
    const manifest: OcctAssetManifest = {
      ...data.manifest,
      byteLength: data.manifest.byteLength + 1,
    };
    await expect(decompressAndVerifyOcctAsset(manifest, data.downloaded)).rejects.toThrow(
      '復元後 byteLength',
    );
  });

  it('旧 gzip でも復号途中に宣言長を超えたら拒む', async () => {
    const data = fixture();
    const manifest: OcctAssetManifest = { ...data.manifest, byteLength: data.manifest.byteLength - 1 };
    await expect(decompressAndVerifyOcctAsset(manifest, data.downloaded)).rejects.toThrow('上限');
    expect(() => parseOcctAssetManifest({
      ...data.manifest, byteLength: 64 * 1024 * 1024 + 1,
    })).toThrow('byteLength');
  });

  it('圧縮した片の byteLength が一致しない結果を拒む', async () => {
    const data = fixture();
    const first = data.manifest.parts[0];
    const second = data.manifest.parts[1];
    if (first === undefined || second === undefined) {
      throw new Error('検査用の片がありません。');
    }
    const manifest: OcctAssetManifest = {
      ...data.manifest,
      parts: [{ ...first, byteLength: first.byteLength + 1 }, second],
    };
    await expect(decompressAndVerifyOcctAsset(manifest, data.downloaded)).rejects.toThrow(
      'byteLength',
    );
  });

  it('連続していない manifest の順序を読み込み時に拒む', () => {
    const data = fixture();
    expect(() =>
      parseOcctAssetManifest({
        ...data.manifest,
        parts: data.manifest.parts.map((part) => ({ ...part, order: part.order + 1 })),
      }),
    ).toThrow('順序');
  });
});
