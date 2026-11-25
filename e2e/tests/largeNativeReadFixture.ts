import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdtemp, open, rename, rm, rmdir, stat, writeFile, type FileHandle } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, join, resolve } from 'node:path';
import process from 'node:process';
import { crc32, deflateSync } from 'node:zlib';
import { serializeDocument } from '@pointercad/io';
import { createEmptyPartDocument } from '@pointercad/model';

const CHUNK_BYTES = 1024 * 1024;
const PADDING_BYTES = 260 * CHUNK_BYTES;
const DESCRIPTOR_FLAG = 8;

interface StoredMember {
  readonly name: Buffer;
  readonly offset: number;
  readonly flags: number;
  readonly size: number;
  readonly crc: number;
}

function storedHeader(member: StoredMember, central: boolean): Buffer {
  const header = Buffer.alloc((central ? 46 : 30) + member.name.length);
  header.writeUInt32LE(central ? 0x02014b50 : 0x04034b50);
  const fields = central ? 2 : 0;
  header.writeUInt16LE(20, 4);
  header.writeUInt16LE(20, 4 + fields);
  header.writeUInt16LE(member.flags, 6 + fields);
  header.writeUInt16LE(33, 12 + fields); // DOS date for 1980-01-01.
  header.writeUInt32LE(member.crc, 14 + fields);
  header.writeUInt32LE(member.size, 18 + fields);
  header.writeUInt32LE(member.size, 22 + fields);
  header.writeUInt16LE(member.name.length, 26 + fields);
  if (central) header.writeUInt32LE(member.offset, 42);
  member.name.copy(header, central ? 46 : 30);
  return header;
}

function pngChunk(kind: string, data: Uint8Array): Buffer {
  const chunk = Buffer.alloc(12 + data.length);
  chunk.writeUInt32BE(data.length);
  chunk.write(kind, 4, 4, 'ascii');
  chunk.set(data, 8);
  chunk.writeUInt32BE(crc32(chunk.subarray(4, 8 + data.length)), 8 + data.length);
  return chunk;
}

/** A real one-pixel RGB PNG with a legal private ancillary chunk. Reuse a single MiB of padding. */
function* pngPieces(): Generator<Buffer> {
  yield Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const imageHeader = Buffer.alloc(13);
  imageHeader.writeUInt32BE(1);
  imageHeader.writeUInt32BE(1, 4);
  imageHeader[8] = 8;
  imageHeader[9] = 2;
  yield pngChunk('IHDR', imageHeader);
  yield pngChunk('IDAT', deflateSync(Uint8Array.of(0, 76, 128, 192)));
  const privateHeader = Buffer.alloc(8);
  privateHeader.writeUInt32BE(PADDING_BYTES);
  privateHeader.write('npAd', 4, 4, 'ascii');
  yield privateHeader;
  const padding = Buffer.alloc(CHUNK_BYTES);
  for (let index = 0; index < padding.length; index++) padding[index] = index & 255;
  let checksum = crc32(privateHeader.subarray(4));
  for (let offset = 0; offset < PADDING_BYTES; offset += padding.length) {
    checksum = crc32(padding, checksum);
    yield padding;
  }
  const tail = Buffer.alloc(4);
  tail.writeUInt32BE(checksum);
  yield tail;
  yield pngChunk('IEND', new Uint8Array());
}

type WriteFixtureBytes = (bytes: Buffer) => Promise<void>;

async function writeCanvas(write: WriteFixtureBytes, offset: number) {
  const member = { name: Buffer.from('canvases/orphan.png'), offset, flags: DESCRIPTOR_FLAG, size: 0, crc: 0 };
  const header = storedHeader(member, false);
  const digest = createHash('sha256');
  await write(header);
  for (const chunk of pngPieces()) {
    member.crc = crc32(chunk, member.crc);
    member.size += chunk.length;
    digest.update(chunk);
    await write(chunk);
  }
  const descriptor = Buffer.alloc(16);
  descriptor.writeUInt32LE(0x08074b50);
  descriptor.writeUInt32LE(member.crc, 4);
  descriptor.writeUInt32LE(member.size, 8);
  descriptor.writeUInt32LE(member.size, 12);
  await write(descriptor);
  return { member, end: offset + header.length + member.size + descriptor.length, sha256: digest.digest('hex') };
}

async function writeArchive(file: FileHandle) {
  const digest = createHash('sha256');
  const write = async (bytes: Buffer): Promise<void> => {
    await file.writeFile(bytes);
    digest.update(bytes);
  };
  const document = Buffer.from(serializeDocument(createEmptyPartDocument(), { savedAt: '2026-10-25T00:00:00.000Z' }));
  const member = { name: Buffer.from('document.json'), offset: 0, flags: 0, size: document.length, crc: crc32(document) };
  const header = storedHeader(member, false);
  await write(header);
  await write(document);
  const canvas = await writeCanvas(write, header.length + document.length);
  const directory = Buffer.concat([storedHeader(member, true), storedHeader(canvas.member, true)]);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(2, 8);
  end.writeUInt16LE(2, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(canvas.end, 16);
  await write(directory);
  await write(end);
  return {
    sourceBytes: canvas.end + directory.length + end.length,
    attachmentBytes: canvas.member.size,
    attachmentSha256: canvas.sha256,
    sourceSha256: digest.digest('hex'),
  };
}

/** One Playwright case owns both editions and publishes its fixture after close and the on-disk size check. */
export async function prepareLargeNativeReadFixture() {
  const external = process.env.PCAD_A14_FIXTURE;
  if (external) {
    const path = resolve(external);
    if (extname(path).toLowerCase() !== '.pcad') throw new Error('A-14 needs a native part archive');
    const digest = createHash('sha256');
    for await (const bytes of createReadStream(path)) digest.update(bytes);
    return { path, sourceSha256: digest.digest('hex'), async dispose() {} };
  }
  const work = await mkdtemp(join(tmpdir(), 'pcad-a14-'));
  const path = join(work, 'large-native.pcad'), staging = join(work, 'archive.partial');
  const oracle = path + '.oracle.json';
  const dispose = async (): Promise<void> => {
    for (const file of [path, staging, oracle]) await rm(file, { force: true });
    await rmdir(work);
  };
  try {
    const file = await open(staging, 'wx');
    const expected = await writeArchive(file).finally(() => file.close());
    const diskSize = (await stat(staging)).size;
    if (diskSize !== expected.sourceBytes || diskSize <= PADDING_BYTES) throw new Error('Unexpected large native fixture length');
    await writeFile(oracle, JSON.stringify(expected) + '\n', { flag: 'wx' });
    await rename(staging, path);
    return { path, sourceSha256: expected.sourceSha256, dispose };
  } catch (error) {
    await dispose();
    throw error;
  }
}
