/** Bounds for one export request. Native/WASM allocation during a synchronous call has its own owner. */
export const EXPORT_TRIANGLE_LIMIT = 1_000_000;
export const EXPORT_JS_BYTE_LIMIT = 512 * 1024 * 1024;
export const EXPORT_DEADLINE_MS = 25_000;

export class ExportWorkLimitError extends Error {
  override readonly name = 'ExportWorkLimitError';
}

function nonNegativeSafe(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new ExportWorkLimitError('書き出しの大きさを安全に計算できません。');
  }
  return value;
}

export function checkedExportAdd(left: number, right: number): number {
  const sum = nonNegativeSafe(left) + nonNegativeSafe(right);
  return nonNegativeSafe(sum);
}

export function checkedExportMultiply(left: number, right: number): number {
  const product = nonNegativeSafe(left) * nonNegativeSafe(right);
  return nonNegativeSafe(product);
}

/** Conservative JS-side reservation before STL/OBJ/glTF writers allocate their result. */
export function exportSerializationReserve(
  format: 'stl-binary' | 'stl-ascii' | 'obj' | 'gltf',
  triangles: number,
  bodies: number,
  metadataCodeUnits: number,
): number {
  const header = checkedExportAdd(4_096, checkedExportMultiply(bodies, 4_096));
  const names = checkedExportMultiply(metadataCodeUnits, 4);
  const perTriangle = format === 'stl-binary' ? 50 : format === 'stl-ascii' ? 1_024 : 2_048;
  return checkedExportAdd(checkedExportAdd(header, names), checkedExportMultiply(triangles, perTriangle));
}

export class ExportWorkBudget {
  private triangles = 0;
  private bytes = 0;
  private reservedOutput = 0;
  private readonly startedAt: number;
  private readonly triangleLimit: number;

  constructor(private readonly now: () => number = () => performance.now(), triangleLimit = EXPORT_TRIANGLE_LIMIT) {
    if (!Number.isSafeInteger(triangleLimit) || triangleLimit < 1 || triangleLimit > EXPORT_TRIANGLE_LIMIT) {
      throw new ExportWorkLimitError('書き出しの三角形上限が不正です。');
    }
    this.triangleLimit = triangleLimit;
    this.startedAt = now();
    if (!Number.isFinite(this.startedAt)) {
      throw new ExportWorkLimitError('書き出しの時間を測定できません。');
    }
  }

  checkDeadline(): void {
    const elapsed = this.now() - this.startedAt;
    if (!Number.isFinite(elapsed) || elapsed < 0 || elapsed >= EXPORT_DEADLINE_MS) {
      throw new ExportWorkLimitError('書き出しが時間制限を超えました。');
    }
  }

  admitMesh(triangleCount: number, positionBytes: number, normalBytes: number,
    indexBytes: number, faceRanges: number): void {
    this.checkDeadline();
    const nextTriangles = checkedExportAdd(this.triangles, triangleCount);
    if (nextTriangles > this.triangleLimit) {
      throw new ExportWorkLimitError('書き出しの三角形は合計100万枚までです。');
    }
    const arrays = checkedExportAdd(checkedExportAdd(positionBytes, normalBytes), indexBytes);
    const rangeEstimate = checkedExportMultiply(faceRanges, 64);
    const nextBytes = checkedExportAdd(this.bytes, checkedExportAdd(arrays, rangeEstimate));
    if (nextBytes > EXPORT_JS_BYTE_LIMIT) {
      throw new ExportWorkLimitError('書き出しの追加メモリは512MiBまでです。');
    }
    this.triangles = nextTriangles;
    this.bytes = nextBytes;
  }

  reserveOutput(bytes: number): void {
    this.checkDeadline();
    const next = checkedExportAdd(this.bytes, bytes);
    if (next > EXPORT_JS_BYTE_LIMIT) {
      throw new ExportWorkLimitError('書き出しの追加メモリは512MiBまでです。');
    }
    this.bytes = next;
    this.reservedOutput = bytes;
  }

  /** STEP/BREP size is unknown until the native writer returns; no partial result escapes. */
  admitNativeOutput(bytes: number): void {
    this.checkDeadline();
    const next = checkedExportAdd(this.bytes, bytes);
    if (next > EXPORT_JS_BYTE_LIMIT) {
      throw new ExportWorkLimitError('書き出しの追加メモリは512MiBまでです。');
    }
    this.bytes = next;
  }

  verifySerializedOutput(bytes: number): void {
    this.checkDeadline();
    if (nonNegativeSafe(bytes) > this.reservedOutput) {
      throw new ExportWorkLimitError('書き出しの見積りを超えました。');
    }
  }

  get triangleCount(): number { return this.triangles; }
  get usedBytes(): number { return this.bytes; }
  get remainingTriangles(): number { return this.triangleLimit - this.triangles; }
  get remainingJsBytes(): number { return EXPORT_JS_BYTE_LIMIT - this.bytes; }
}
