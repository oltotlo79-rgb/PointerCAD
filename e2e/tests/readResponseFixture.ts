import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { deflateRawSync } from 'node:zlib';
import { expect } from '@playwright/test';
import { readPcadFile, serializeDocument } from '../../packages/io/src/index.js';
import { createEmptyPartDocument } from '../../packages/model/src/index.js';

export function independentZip(entries: readonly { name: string; bytes: Uint8Array; declared?: number; corruptCrc?: boolean }[]): Uint8Array {
  const table = Uint32Array.from({ length: 256 }, (_, value) => {
    for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    return value >>> 0;
  });
  const local: Uint8Array[] = [], central: Uint8Array[] = [];
  let offset = 0;
  for (const entry of entries) {
    let checksum = 0xffffffff;
    for (const byte of entry.bytes) checksum = table[(checksum ^ byte) & 255] ^ (checksum >>> 8);
    checksum = ((checksum ^ 0xffffffff) + (entry.corruptCrc === true ? 1 : 0)) >>> 0;
    const name = Buffer.from(entry.name), compressed = deflateRawSync(entry.bytes);
    const header = Buffer.alloc(30), directory = Buffer.alloc(46);
    header.writeUInt32LE(0x04034b50, 0); header.writeUInt16LE(20, 4); header.writeUInt16LE(0x800, 6);
    header.writeUInt16LE(8, 8); header.writeUInt32LE(checksum, 14); header.writeUInt32LE(compressed.length, 18);
    header.writeUInt32LE(entry.declared ?? entry.bytes.length, 22); header.writeUInt16LE(name.length, 26);
    directory.writeUInt32LE(0x02014b50, 0); directory.writeUInt16LE(20, 4); directory.writeUInt16LE(20, 6);
    directory.writeUInt16LE(0x800, 8); directory.writeUInt16LE(8, 10); directory.writeUInt32LE(checksum, 16);
    directory.writeUInt32LE(compressed.length, 20); directory.writeUInt32LE(entry.declared ?? entry.bytes.length, 24);
    directory.writeUInt16LE(name.length, 28); directory.writeUInt32LE(offset, 42);
    local.push(header, name, compressed); central.push(directory, name); offset += header.length + name.length + compressed.length;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...local, directory, end]));
}


const E04_IDENTITIES = {
  32: { sourceBytes: 33381, sourceSha: 'd0410a7249ae031c301875de0defd5fed3eed44ac1c52e6e0acccf03b113d321', attachmentBytes: 33554432, attachmentSha: '20f364a23762cb1a2e4f14f7036e9718ed806447caad2881a27fc4af14050415' },
  128: { sourceBytes: 131224, sourceSha: 'd298c0eac37deeb2eac3816b40916fd272a9793016307caa9faaa5a94897efb3', attachmentBytes: 134217728, attachmentSha: 'eadaaf6bbacea8cabc6b4c3def3d1e4c76577249c01c0065bd9dd78a1c5a47b5' },
} as const;

export function orphanReadFixture(mib: 32 | 128) {
  const payload = new Uint8Array(mib * 1024 * 1024).fill(65);
  const bytes = independentZip([
    { name: 'document.json', bytes: Buffer.from(serializeDocument(createEmptyPartDocument(), { savedAt: '2026-10-25T00:00:00.000Z' })) },
    { name: 'canvases/orphan.png', bytes: payload },
  ]);
  const hash = (data: Uint8Array) => createHash('sha256').update(data).digest('hex');
  const expected = { sourceBytes: bytes.byteLength, sourceSha: hash(bytes), attachmentBytes: payload.byteLength, attachmentSha: hash(payload) };
  expect(expected).toEqual(E04_IDENTITIES[mib]);
  const read = readPcadFile(bytes);
  if (!read.ok) throw new Error(JSON.stringify(read.error));
  expect(read.attachments.canvases.get('orphan')?.byteLength).toBe(expected.attachmentBytes);
  expect(hash(read.attachments.canvases.get('orphan') ?? new Uint8Array())).toBe(expected.attachmentSha);
  return { bytes, expected };
}
