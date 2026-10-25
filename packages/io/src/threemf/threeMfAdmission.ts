import type { ThreeMfMeshInput } from './writeThreeMf.js';

export const THREE_MF_EXPORT_TRIANGLE_LIMIT = 1_000_000;
export const THREE_MF_EXPORT_BYTE_LIMIT = 512 * 1024 * 1024;
export const THREE_MF_EXPORT_TIME_LIMIT_MS = 25_000;

const LIMIT = BigInt(THREE_MF_EXPORT_BYTE_LIMIT);
const MAX_NAME_UNITS = 64 * 1024;

export class ThreeMfExportLimitError extends Error {
  constructor(readonly reason: 'triangles' | 'bytes' | 'deadline') {
    super(reason === 'triangles' ? '3MFの三角形は100万枚までです。'
      : reason === 'bytes' ? '3MF書き出しの追加メモリは512MiBまでです。'
        : '3MF書き出しの計算時間は25秒までです。');
    this.name = 'ThreeMfExportLimitError';
  }
}

export interface ThreeMfAdmission {
  readonly triangleCount: number;
  readonly vertexCount: number;
  /** Conservative simultaneous JS allocation, including the requested owned copy. */
  readonly estimatedLiveBytes: number;
}

export interface ThreeMfAdmissionOptions {
  readonly withColors?: boolean;
  /** The renderer owns exactly one new copy before transferring it to the Worker. */
  readonly ownedCopyCount?: 0 | 1;
}

function count(value: number): bigint {
  if (!Number.isSafeInteger(value) || value < 0) throw new ThreeMfExportLimitError('bytes');
  return BigInt(value);
}

function within(value: bigint): bigint {
  if (value > LIMIT) throw new ThreeMfExportLimitError('bytes');
  return value;
}

function arrayBytes(value: ArrayLike<number>, elementCount: bigint): bigint {
  // Plain JS arrays need substantially more than a typed element's four bytes.
  if (ArrayBuffer.isView(value)) return count(value.byteLength);
  return elementCount * 32n;
}

/**
 * Reject before copying a mesh or constructing XML rows. This deliberately overestimates
 * string/array/Map/UTF-8/zip coexistence; a successful estimate alone is not a PID peak proof.
 */
export function admitThreeMf(
  parts: readonly ThreeMfMeshInput[],
  options: ThreeMfAdmissionOptions = {},
): ThreeMfAdmission {
  const withColors = options.withColors ?? true;
  const ownedCopies = options.ownedCopyCount ?? 0;
  if (ownedCopies !== 0 && ownedCopies !== 1) throw new ThreeMfExportLimitError('bytes');
  let triangles = 0n, vertices = 0n, inputBytes = 0n, xmlChars = 8192n, rowCount = 0n;
  let materialEntries = 0n, materialAssignments = 0n;
  for (const part of parts) {
    const positionsLength = count(part.positions.length);
    const indicesLength = count(part.indices.length);
    // Keep malformed triples for the writer's existing precise error message.
    const vertexCount = (positionsLength + 2n) / 3n;
    const triangleCount = (indicesLength + 2n) / 3n;
    triangles += triangleCount;
    if (triangles > BigInt(THREE_MF_EXPORT_TRIANGLE_LIMIT)) throw new ThreeMfExportLimitError('triangles');
    vertices += vertexCount;
    inputBytes = within(inputBytes + arrayBytes(part.positions, positionsLength)
      + arrayBytes(part.indices, indicesLength));
    const nameUnits = part.name?.length ?? 0;
    if (nameUnits > MAX_NAME_UNITS) throw new ThreeMfExportLimitError('bytes');
    // Attribute escaping can expand one UTF-16 unit to a numeric entity; account for
    // both the object name and material name, plus the intermediate original string.
    const nameChars = count(nameUnits) * 16n + 256n;
    xmlChars = within(xmlChars + vertexCount * 160n + triangleCount * 128n + nameChars);
    rowCount = within(rowCount + vertexCount + triangleCount + 32n);
    inputBytes = within(inputBytes + count(nameUnits) * 2n + 256n);
    const faceColors = part.faceColors;
    const faceRanges = part.faceRanges;
    if (faceColors !== undefined) {
      const colorCount = count(faceColors.size);
      inputBytes = within(inputBytes + colorCount * 128n);
      if (withColors && faceRanges !== undefined) {
        materialEntries = within(materialEntries + colorCount);
        let assignments = 0n;
        for (const face of faceColors.keys()) {
          // The writer has always ignored colors for absent/invalid face rows.
          if (!Number.isInteger(face) || face < 0 || face >= faceRanges.length) continue;
          const range = faceRanges[face];
          if (range === undefined || !Number.isInteger(range.triangleOffset)
            || range.triangleOffset < 0 || !Number.isInteger(range.triangleCount)
            || range.triangleCount <= 0) continue;
          const last = count(range.triangleOffset) + count(range.triangleCount);
          // A malformed range could make buildBaseMaterials loop billions of
          // times before it constructs a tiny one-triangle XML file.
          if (last > triangleCount) throw new ThreeMfExportLimitError('bytes');
          assignments += count(range.triangleCount);
          if (assignments > triangleCount) throw new ThreeMfExportLimitError('bytes');
        }
        materialAssignments = within(materialAssignments + assignments);
        xmlChars = within(xmlChars + colorCount * (nameChars + 160n));
        rowCount = within(rowCount + colorCount);
      }
    }
    if (faceRanges !== undefined) inputBytes = within(inputBytes + count(faceRanges.length) * 64n);
  }
  // JS line strings + references, joined UTF-16 string, UTF-8 buffer, zip input and
  // output, plus compressor workspace. The constants intentionally dominate normal
  // small meshes and reject uncertain large allocations before any new bulk array.
  const live = inputBytes * BigInt(1 + ownedCopies)
    + xmlChars * 8n + rowCount * 96n + materialEntries * 144n
    + materialAssignments * 96n
    + count(parts.length) * 512n + 4n * 1024n * 1024n;
  within(live);
  return {
    triangleCount: Number(triangles), vertexCount: Number(vertices), estimatedLiveBytes: Number(live),
  };
}

export function threeMfDeadline(remainingMs: number): number {
  if (!Number.isFinite(remainingMs) || remainingMs <= 0) throw new ThreeMfExportLimitError('deadline');
  return performance.now() + Math.min(remainingMs, THREE_MF_EXPORT_TIME_LIMIT_MS);
}

export function checkThreeMfDeadline(deadlineAt: number): void {
  if (performance.now() >= deadlineAt) throw new ThreeMfExportLimitError('deadline');
}
