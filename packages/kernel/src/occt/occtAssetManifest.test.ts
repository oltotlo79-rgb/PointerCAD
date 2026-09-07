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
