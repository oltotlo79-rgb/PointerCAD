/**
 * ファイル読み込みで確保してよい大きさの上限(NFR-RE-1、NFR-SE-1)。
 *
 * 数値はここだけを正本にする。ZIP とメッシュと DXF の読み手は、この表を参照して
 * 入力を大きな配列へ展開する前に断る。
 */
export interface IoLimits {
  /** ZIP など圧縮済み入力そのものの総バイト数。 */
  readonly archiveCompressedBytes: number;
  /** ZIP に含めてよいエントリ数（展開しない未知のエントリも数える）。 */
  readonly archiveEntryCount: number;
  /** ZIP の 1 エントリから実際に出力してよいバイト数。 */
  readonly archiveEntryExpandedBytes: number;
  /** ZIP から実際に出力してよい全エントリの累積バイト数。 */
  readonly archiveTotalExpandedBytes: number;
  /** 1 回の読み込みでメッシュ配列へ確保してよい総バイト数。 */
  readonly meshAllocationBytes: number;
  /** `split` の前に受け入れてよい DXF 本文の文字数。 */
  readonly dxfTextCharacters: number;
}

export const IO_LIMITS: IoLimits = Object.freeze({
  archiveCompressedBytes: 256 * 1024 * 1024,
  archiveEntryCount: 4_096,
  archiveEntryExpandedBytes: 512 * 1024 * 1024,
  archiveTotalExpandedBytes: 1024 * 1024 * 1024,
  meshAllocationBytes: 512 * 1024 * 1024,
  dxfTextCharacters: 64 * 1024 * 1024,
});

/**
 * メッシュの位置・法線・添字に要るバイト数を返す。
 *
 * 頂点 1 つは位置 3×float32 + 法線 3×float32 = 24 バイト、三角形 1 枚は
 * 添字 3×uint32 = 12 バイト。負数・非整数・安全に数えられない値は `null` にする。
 */
export function meshAllocationByteLength(vertexCount: number, triangleCount: number): number | null {
  if (
    !Number.isSafeInteger(vertexCount) ||
    vertexCount < 0 ||
    !Number.isSafeInteger(triangleCount) ||
    triangleCount < 0
  ) {
    return null;
  }
  const byteLength = 24 * vertexCount + 12 * triangleCount;
  return Number.isSafeInteger(byteLength) ? byteLength : null;
}

/** メッシュ配列を確保してよいかを、確保する前に判定する。 */
export function isMeshAllocationWithinLimit(
  vertexCount: number,
  triangleCount: number,
  maximumBytes: number = IO_LIMITS.meshAllocationBytes,
): boolean {
  const byteLength = meshAllocationByteLength(vertexCount, triangleCount);
  return byteLength !== null && byteLength <= maximumBytes;
}
