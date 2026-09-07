export interface OcctAssetManifestPart {
  readonly order: number;
  readonly file: string;
  readonly byteLength: number;
}

export interface OcctAssetManifest {
  readonly byteLength: number;
  readonly sha256: string;
  readonly compression: 'gzip';
  readonly parts: readonly OcctAssetManifestPart[];
}

export interface DownloadedOcctAssetPart {
  readonly order: number;
  readonly data: ArrayBuffer;
}

function positiveSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function parsePart(value: unknown, index: number): OcctAssetManifestPart {
  if (typeof value !== 'object' || value === null) {
    throw new Error(`OCCT 資産 manifest の parts[${index}] が物ではありません。`);
  }
  if (
    !('order' in value) ||
    typeof value.order !== 'number' ||
    !Number.isSafeInteger(value.order) ||
    value.order < 0
  ) {
    throw new Error(`OCCT 資産 manifest の parts[${index}].order が不正です。`);
  }
  if (
    !('file' in value) ||
    typeof value.file !== 'string' ||
    !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(value.file)
  ) {
    throw new Error(`OCCT 資産 manifest の parts[${index}].file が不正です。`);
  }
  if (!('byteLength' in value) || !positiveSafeInteger(value.byteLength)) {
    throw new Error(`OCCT 資産 manifest の parts[${index}].byteLength が不正です。`);
  }
  return { order: value.order, file: value.file, byteLength: value.byteLength };
}

/** fetch した JSON を検査し、連続した順序を持つ manifest だけを返す。 */
export function parseOcctAssetManifest(value: unknown): OcctAssetManifest {
  if (typeof value !== 'object' || value === null) {
    throw new Error('OCCT 資産 manifest が物ではありません。');
  }
  if (!('byteLength' in value) || !positiveSafeInteger(value.byteLength)) {
    throw new Error('OCCT 資産 manifest の byteLength が不正です。');
  }
  if (
    !('sha256' in value) ||
    typeof value.sha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(value.sha256)
  ) {
    throw new Error('OCCT 資産 manifest の SHA-256 が不正です。');
  }
  if (!('compression' in value) || value.compression !== 'gzip') {
    throw new Error('OCCT 資産 manifest の圧縮方式が gzip ではありません。');
  }
  if (!('parts' in value) || !Array.isArray(value.parts) || value.parts.length === 0) {
    throw new Error('OCCT 資産 manifest の parts が空です。');
  }

  const parts = value.parts.map(parsePart);
  for (let index = 0; index < parts.length; index += 1) {
    if (parts[index]?.order !== index) {
      throw new Error(`OCCT 資産 manifest の片の順序が不正です(index ${index})。`);
    }
  }

  return {
    byteLength: value.byteLength,
    sha256: value.sha256,
    compression: value.compression,
    parts,
  };
}

async function gunzip(data: ArrayBuffer, order: number): Promise<ArrayBuffer> {
  try {
    const compressed = new ReadableStream<BufferSource>({
      start(controller) {
        controller.enqueue(new Uint8Array(data));
        controller.close();
      },
    });
    const decompressed = compressed.pipeThrough(new DecompressionStream('gzip'));
    return await new Response(decompressed).arrayBuffer();
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`OCCT 資産の片 ${order} を gzip 展開できませんでした: ${reason}`, {
      cause: error,
    });
  }
}

async function sha256Hex(data: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** 順序・各片の圧縮長・復元長・SHA-256 を照合してから、Emscripten 用のバイト列を返す。 */
export async function decompressAndVerifyOcctAsset(
  manifest: OcctAssetManifest,
  downloadedParts: readonly DownloadedOcctAssetPart[],
): Promise<ArrayBuffer> {
  if (downloadedParts.length !== manifest.parts.length) {
    throw new Error(
      `OCCT 資産の片が足りません(expected ${manifest.parts.length}, actual ${downloadedParts.length})。`,
    );
  }

  const decompressedParts: ArrayBuffer[] = [];
  let byteLength = 0;
  for (let index = 0; index < manifest.parts.length; index += 1) {
    const expected = manifest.parts[index];
    const downloaded = downloadedParts[index];
    if (expected === undefined || downloaded === undefined || downloaded.order !== expected.order) {
      throw new Error(`OCCT 資産の片の順序が不正です(index ${index})。`);
    }
    if (downloaded.data.byteLength !== expected.byteLength) {
      throw new Error(
        `OCCT 資産の片 ${expected.order} の byteLength が一致しません(expected ${expected.byteLength}, actual ${downloaded.data.byteLength})。`,
      );
    }
    const decompressed = await gunzip(downloaded.data, expected.order);
    decompressedParts.push(decompressed);
    byteLength += decompressed.byteLength;
  }

  if (byteLength !== manifest.byteLength) {
    throw new Error(
      `OCCT 資産の復元後 byteLength が一致しません(expected ${manifest.byteLength}, actual ${byteLength})。`,
    );
  }

  let joined: ArrayBuffer;
  const onlyPart = decompressedParts.length === 1 ? decompressedParts[0] : undefined;
  if (onlyPart !== undefined) {
    joined = onlyPart;
  } else {
    const joinedBytes = new Uint8Array(byteLength);
    let offset = 0;
    for (const part of decompressedParts) {
      joinedBytes.set(new Uint8Array(part), offset);
      offset += part.byteLength;
    }
    joined = joinedBytes.buffer;
  }

  const actualSha256 = await sha256Hex(joined);
  if (actualSha256 !== manifest.sha256) {
    throw new Error(
      `OCCT 資産の SHA-256 が一致しません(expected ${manifest.sha256}, actual ${actualSha256})。`,
    );
  }
  return joined;
}
