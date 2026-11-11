/**
 * ボディ(立体)を描画用の並びへ組み立てる(計画書 docs/plans/P2-ソリッド基礎.md タスク20 手順2)。
 *
 * 対応要件: FR-105(表示スタイル)、FR-106(ホバーと選択)、NFR-PF-1(60fps)。
 *
 * three.js にも DOM にも触れない純関数だけを置く(Node で検査できる)。
 * 組み立てた結果は `createSolidLayer.ts` が受け取り、同じ並び(同じ Float32Array)が
 * 返ってきたときは three.js の入れ物を触らない。ホバーや選択が変わっただけのときは
 * 三角形の並びが前と同じ参照のまま `emphasis` だけが変わるので、
 * 表示側は材質の色を塗り替えるだけで済む(NFR-PF-1)。
 *
 * スケッチ(buildSketchGeometry.ts)は強調の度合いごとに並びを分けているが、ボディは
 * **1 つずつ別の入れ物**に入れる。ボディは面と稜線がボディ単位でまとまっており、
 * 当たり判定(FR-106)も「どのボディに当たったか」を返す必要があるため。
 *
 * P5 タスク7(計画書 docs/plans/P5-高度なソリッド・外観と測定.md §2.5.2、§0.a-0.7)で
 * **箱投影の UV(FR-1108)と、面のまとまり(FR-1106)** を足した。どちらも three.js に
 * 触れない純関数のままで、実際に `BufferGeometry` へ流し込むのは `createSolidLayer.ts`
 * (タスク10)だけである。
 */

import { DEFAULT_APPEARANCE, type AppearanceSpec, type SolidBody } from '@pointercad/model';

import { buildFaceGroups, type FaceGroup } from '../appearance/buildFaceGroups.js';
import type { SolidEdgeEntry, SolidFaceEntry, SolidVertexEntry } from '../solid/subShapeSelection.js';

/** 強調の度合い。選択が最も強く、ホバーはその手前(FR-106)。 */
export type SolidEmphasis = 'none' | 'hovered' | 'selected';

/**
 * 部分形状の一覧を持つボディ(計画書タスク22)。
 *
 * `faces` / `edges` / `vertices` はタスク17 で `SolidBody` 本体に必須の欄として届くように
 * なった(model/src/kernelBridge.ts)。この型は「部分形状の一覧を持つボディ」であることを
 * 呼び出し側の型で示すために残しているだけで、`SolidBody` と同じ欄をそのまま再宣言している
 * (`SolidBody` は構造的にこの型を満たすので、呼び出し側の詰め替えは要らない)。
 */
export interface SolidBodyWithSubShapes extends SolidBody {
  readonly faces: readonly SolidFaceEntry[];
  readonly edges: readonly SolidEdgeEntry[];
  readonly vertices: readonly SolidVertexEntry[];
}

/** ボディ 1 つぶんの描画データ。通常はカーネル配列を参照し、local柄だけ描画用に複製する。 */
export interface SolidDrawEntry {
  /** ボディの id = それを作ったフィーチャーの id(§0.a-0.5)。 */
  readonly featureId: string;
  /** 頂点座標。x, y, z の順に 3 個ずつ。柄付きlocalでは三角形ごとの描画用複製。 */
  readonly positions: Float32Array;
  /** 頂点法線。positions と同じ長さ。 */
  readonly normals: Float32Array;
  /** 三角形の頂点番号。3 個ずつ。 */
  readonly indices: Uint32Array;
  /** 稜線の線分列。線分 1 本あたり 6 個(始点 xyz + 終点 xyz)。 */
  readonly edgePositions: Float32Array;
  /** Local mesh coordinates are placed in world space by this double-precision origin. */
  readonly coordinateFrame?: SolidBody['coordinateFrame'];
  readonly emphasis: SolidEmphasis;
  /** `entries` の中の位置。表示側の入れ物と 1 対 1 で対応する。 */
  readonly drawIndex: number;
  /** 全ボディを通した三角形の通し番号のうち、このボディが始まる位置。 */
  readonly triangleOffset: number;
  readonly triangleCount: number;
  /** 全ボディを通した稜線の通し番号のうち、このボディが始まる位置。 */
  readonly edgeOffset: number;
  readonly edgeCount: number;
  /** 面ごとの三角形の範囲(`pickSubShape.ts` の `faceIndexOfTriangle` が使う)。無ければ空。 */
  readonly faces: readonly SolidFaceEntry[];
  /** 辺ごとの線分の範囲。無ければ空。 */
  readonly edges: readonly SolidEdgeEntry[];
  /** 頂点の一覧。無ければ空。 */
  readonly vertices: readonly SolidVertexEntry[];
  /**
   * 柄(FR-1108)を貼るための箱投影 UV(mm 単位)。頂点 1 つあたり 2 個。
   *
   * 同じ元配列/材質/原点には控えの同じ並びを返すので、ホバーや選択が変わっただけの
   * 組み立て直しでは計算し直さない(NFR-PF-1)。
   */
  readonly uv: Float32Array;
  /** 描画のまとまり(`geometry.addGroup` へ渡す)。索引の全体をちょうど覆う。 */
  readonly groups: readonly FaceGroup[];
  /** `FaceGroup.materialIndex` の順に並んだ外観。0 番はこのボディの既定。 */
  readonly appearances: readonly AppearanceSpec[];
  /**
   * 外観の割り当てが上限(材質 8 種 / まとまり 32 個)を超えたか。
   *
   * 超えたときは**描画を止めず**、このボディの既定 1 色だけで描く形へ落とす
   * (FR-504「止めずに警告する」)。断りの文言を出すのは呼び出し側(タスク11)の役目で、
   * ここは「落とした」ことだけを伝える。
   */
  readonly appearanceLimitExceeded: boolean;
}

/** 1 ボディぶんの外観の割り当て(タスク10 が文書と照合の結果から組み立てて渡す)。 */
export interface BodyAppearanceInput {
  /** 立体全体の割り当て。無ければ `null`。 */
  readonly bodyAppearance: AppearanceSpec | null;
  /** 面の通し番号 → その面だけの割り当て(カーネルの照合の結果、§0.a-0.2)。 */
  readonly faceAppearances: ReadonlyMap<number, AppearanceSpec>;
}

/** 組み立てに渡す外観一式。省略すると全ボディが既定の外観 1 色になる。 */
export interface AppearanceInput {
  /** 文書の既定の外観。通常は `DEFAULT_APPEARANCE`。 */
  readonly defaultAppearance: AppearanceSpec;
  /** ボディの featureId → その割り当て。無い id は既定だけになる。 */
  readonly byBody: ReadonlyMap<string, BodyAppearanceInput>;
}

export interface SolidGeometryBundle {
  /** 画面に出すボディ。文書の並び順のまま。 */
  readonly entries: readonly SolidDrawEntry[];
  /** 全ボディの三角形の合計(NFR-PF-1 の目安としてプロパティ欄が出す)。 */
  readonly triangleCount: number;
  /** 全ボディの稜線の合計。 */
  readonly edgeCount: number;
  /** featureId → 描画の範囲。当たったボディの見た目を後から追えるようにする。 */
  readonly index: ReadonlyMap<string, SolidDrawEntry>;
  /** Scene-managed builds only: the UI-created typed backings (UVs and patterned copies) this bundle uses. */
  readonly displayCopies?: readonly ArrayBufferLike[];
}

/** ボディが 1 つも無いとき。起動直後と、片付けたあとの初期値に使う。 */
export const EMPTY_SOLID_GEOMETRY: SolidGeometryBundle = {
  entries: [],
  triangleCount: 0,
  edgeCount: 0,
  index: new Map<string, SolidDrawEntry>(),
};

/**
 * ボディ 1 つの強調の度合いを決める。**選択がホバーより強い**(両方に当たるなら選択)。
 *
 * 渡ってくる id はストアの `selection` / `hoveredElementId` そのままで、スケッチの要素
 * (`point-1`、点列の 1 点 `pa1#0`)が混ざっている。ボディの id は `#` を含まないので、
 * 取り違えは起きない。
 */
export function solidEmphasisOf(
  featureId: string,
  hoveredBodyId: string | null,
  selected: ReadonlySet<string>,
): SolidEmphasis {
  if (selected.has(featureId)) {
    return 'selected';
  }
  return hoveredBodyId === featureId ? 'hovered' : 'none';
}

/**
 * 描く価値があるボディか。
 *
 * `isValid` は描画できるCAD形状かを示す(model の kernelBridge.ts)。閉じた立体だけでなく、
 * 体積0の有効な開面も描く。無効な形や、三角形も稜線も無いものは空の入れ物を
 * 1 つ増やすだけなので同じく外す(FR-504 の理由表示は失敗の一覧が受け持つ)。
 */
function isDrawableBody(body: SolidBodyWithSubShapes): boolean {
  if (!body.isValid) {
    return false;
  }
  const frame = body.coordinateFrame;
  if (frame !== undefined && (
    frame.space !== 'local'
    || !Array.isArray(frame.origin)
    || frame.origin.length !== 3
    || ![0, 1, 2].every((axis) => Object.prototype.hasOwnProperty.call(frame.origin, axis)
      && Number.isFinite(frame.origin[axis]))
    || !Number.isFinite(frame.maximumFloat32ErrorMm)
    || frame.maximumFloat32ErrorMm <= 0
  )) return false;
  return body.mesh.indices.length > 0 || body.mesh.edgePositions.length > 0;
}

/**
 * 位置と法線から、mm 単位の箱投影 UV を作る(FR-1108、§0.a-0.7)。
 *
 * **頂点ごとに法線の絶対値が最大の軸を選び、残る 2 軸の座標(mm)をそのまま UV にする。**
 * 柄の繰り返しの間隔は `texture.repeat = 1 / 間隔(mm)` で当てる(タスク8 の
 * `patternRepeatFor`)ので、ここでは 1mm = 1 の生の座標を渡せばよい。
 *
 * 軸の選び方と残る 2 軸の順序:
 *
 * ```
 * |nz| が最大 → (u, v) = (x, y)
 * |ny| が最大 → (u, v) = (x, z)
 * |nx| が最大 → (u, v) = (y, z)
 * ```
 *
 * **符号では規則を変えない。** `+z` の面も `-z` の面も同じ (x, y) を使い、残る 2 軸は
 * 常に x → y → z の順に並べる。向きを面ごとに反転させると、箱の稜線をまたぐところで
 * 柄が鏡に映ったように反転してしまうため(3 方向で規則をそろえる)。裏側の面では柄が
 * 左右反転して見えるが、木目・縞鋼板・エキスパンドメタルはいずれも対称な柄なので
 * 実害が無い。同じ理由で、絶対値が並んだとき(45°の面)は z → y → x の順で先に選ぶ
 * (どちらへ倒しても継ぎ目は生じるので、決め方を 1 つに固定して結果を再現可能にする。
 * §0.a-0.7 の「45°付近の継ぎ目は受け入れる」)。
 *
 * 法線が 0(または数でない)の頂点は投影面を選べないので `[0, 0]` にする。
 */
export function buildBoxProjectedUv(
  positions: Float32Array,
  normals: Float32Array,
  origin: readonly [number, number, number] = [0, 0, 0],
  allocated?: (buffer: ArrayBufferLike) => void,
): Float32Array {
  const vertexCount = Math.floor(positions.length / 3);
  const uv = new Float32Array(vertexCount * 2);
  notifyAllocatedBacking(allocated, uv.buffer);
  for (let vertex = 0; vertex < vertexCount; vertex += 1) {
    const base = vertex * 3;
    // 法線が足りない並びを渡されても落ちないようにする(0 とみなして退化の扱いへ送る)。
    const nx = Math.abs(normals[base] ?? 0);
    const ny = Math.abs(normals[base + 1] ?? 0);
    const nz = Math.abs(normals[base + 2] ?? 0);
    const target = vertex * 2;
    // NaN はどの比較も偽になるので、この条件で退化と同じ扱いになる。
    if (!(nx > 0 || ny > 0 || nz > 0)) {
      uv[target] = 0;
      uv[target + 1] = 0;
      continue;
    }
    if (nz >= nx && nz >= ny) {
      uv[target] = origin[0] + positions[base];
      uv[target + 1] = origin[1] + positions[base + 1];
      continue;
    }
    if (ny >= nx) {
      uv[target] = origin[0] + positions[base];
      uv[target + 1] = origin[2] + positions[base + 2];
      continue;
    }
    uv[target] = origin[1] + positions[base + 1];
    uv[target + 1] = origin[2] + positions[base + 2];
  }
  return uv;
}

/**
 * 同じ並びから 2 度 UV を作らないための控え。
 *
 * ホバーや選択が変わるたびに `buildSolidGeometry` は呼び直されるが、そのとき
 * `positions` はカーネルが返した同じ並びのままである(写さない)。頂点 10 万の UV を
 * 毎回作り直すと 60fps(NFR-PF-1)を脅かすので、並びそのものを鍵にして覚えておく。
 * `WeakMap` なのでボディが捨てられれば一緒に消える。
 *
 * 同じlocal並びでも法線またはoriginが変わればUVを作り直す。
 * 生存中の同じpositionsにつき直近1件だけ保持し、origin切替が続いても増やさない。
 */
const uvByPositions = new WeakMap<Float32Array, UvCopy>();

const MAX_DRAW_MESH_BYTES = 512 * 1024 * 1024;

/** A failed observer still hands the actual constructed backing to its runtime owner. */
export class AllocatedBackingRegistrationError extends Error {
  constructor(readonly backing: ArrayBufferLike, readonly original: unknown) {
    super('Actual display backing registration failed');
  }
}

export function notifyAllocatedBacking(allocated: ((buffer: ArrayBufferLike) => void) | undefined, buffer: ArrayBufferLike): void {
  if (allocated === undefined) return;
  try { allocated(buffer); }
  catch (error) { throw new AllocatedBackingRegistrationError(buffer, error); }
}

interface DrawArrays {
  readonly positions: Float32Array;
  readonly normals: Float32Array;
  readonly indices: Uint32Array;
  readonly uv: Float32Array;
}

interface PatternedDrawCache extends DrawArrays {
  readonly sourceNormals: Float32Array;
  readonly sourceIndices: Uint32Array;
  readonly origin: readonly [number, number, number];
  readonly groupKey: string;
}

/** One latest patterned rendering per source array; no origin-history Map is retained. */
const patternedByPositions = new WeakMap<Float32Array, PatternedDrawCache>();

interface UvCopy {
  readonly normals: Float32Array;
  readonly origin: readonly [number, number, number];
  readonly uv: Float32Array;
}

/** Where display copies are remembered: the shared WeakMaps, or a scene-owned cache. */
interface CopyStore {
  readonly uv: { get(source: Float32Array): UvCopy | undefined; set(source: Float32Array, copy: UvCopy): unknown;
    delete(source: Float32Array): unknown };
  readonly patterned: { get(source: Float32Array): PatternedDrawCache | undefined;
    set(source: Float32Array, copy: PatternedDrawCache): unknown; delete(source: Float32Array): unknown };
}

/** Pure callers keep the historical shared caches; their retention is outside the managed budget. */
const SHARED_COPIES: CopyStore = { uv: uvByPositions, patterned: patternedByPositions };

/**
 * Scene-owned display copies (box UVs and patterned drawing copies), keyed by source positions.
 * Unlike the shared WeakMaps, every copy it keeps is enumerable, so the scene can count it and
 * prune it to the published bodies: no history entry keeps an unpublished copy alive silently.
 */
export class DisplayCopyCache implements CopyStore {
  readonly uv = new Map<Float32Array, UvCopy>();
  readonly patterned = new Map<Float32Array, PatternedDrawCache>();

  /** Every typed backing this cache currently keeps alive. */
  buffers(): readonly ArrayBufferLike[] {
    return [...[...this.uv.values()].map((copy) => copy.uv.buffer),
      ...[...this.patterned.values()].flatMap((copy) => [copy.positions.buffer, copy.normals.buffer,
        copy.indices.buffer, copy.uv.buffer])];
  }

  /** Keep only the copies of the published bodies; strong references to the rest are dropped. */
  retainBodies(bodies: readonly SolidBody[]): void {
    const live = new Set(bodies.map((body) => body.mesh.positions));
    for (const source of [...this.uv.keys()]) if (!live.has(source)) this.uv.delete(source);
    for (const source of [...this.patterned.keys()]) if (!live.has(source)) this.patterned.delete(source);
  }

  clear(): void {
    this.uv.clear();
    this.patterned.clear();
  }

  /** Returns a function restoring exactly today's entries, which returns a refused candidate's copies. */
  checkpoint(): () => void {
    const uv = new Map(this.uv);
    const patterned = new Map(this.patterned);
    return () => {
      this.uv.clear();
      for (const [source, copy] of uv) this.uv.set(source, copy);
      this.patterned.clear();
      for (const [source, copy] of patterned) this.patterned.set(source, copy);
    };
  }
}

/**
 * A local display's finite reservation for UI-created typed copies. The kernel's post-token
 * union (its cache, displayed and reply arrays plus the reply clone) is the known baseline, so
 * the received source arrays are not added again; only UV, patterned and overlay copies are.
 * WASM, native, GPU and JS object/Map overhead are not part of this byte count.
 */
export interface DisplayCopyBudget {
  readonly limitBytes: number;
  readonly baselineBytes: number;
  /** UI copies alive until this candidate is published (old bundle and overlays). */
  readonly retained: Iterable<ArrayBufferLike>;
  /** Exact registered main Source intersection from the current issued global inspection. */
  readonly sourceBackings?: ReadonlySet<ArrayBufferLike>;
}

/** Scene-managed construction: copies go to `cache`; a local display also passes its budget. */
export interface ManagedDisplayCopies {
  readonly cache: DisplayCopyCache;
  readonly budget?: DisplayCopyBudget;
  /** Called immediately after each actual constructor returns, before fill/cache/publication. */
  readonly allocated?: (buffer: ArrayBufferLike) => void;
}

const DISPLAY_COPY_BUDGET_MESSAGE = 'Local display copies exceed the live-byte budget';

/** Counts each live typed backing once and refuses a planned copy before it is allocated. */
class DisplayCopyLedger {
  private readonly counted = new Set<ArrayBufferLike>();
  private bytes: number;

  constructor(private readonly budget: DisplayCopyBudget, cache: DisplayCopyCache) {
    if (!Number.isSafeInteger(budget.limitBytes) || budget.limitBytes <= 0
      || budget.limitBytes > MAX_DRAW_MESH_BYTES || !Number.isSafeInteger(budget.baselineBytes)
      || budget.baselineBytes < 0) throw new RangeError(DISPLAY_COPY_BUDGET_MESSAGE);
    this.bytes = budget.baselineBytes;
    for (const buffer of [...budget.retained, ...cache.buffers()]) this.hold(buffer);
  }

  /** An existing live copy, counted once however many entries use it. */
  hold(buffer: ArrayBufferLike): void {
    if (this.counted.has(buffer)) return;
    this.counted.add(buffer);
    if (this.budget.sourceBackings?.has(buffer) === true) return;
    this.admit(buffer.byteLength);
  }

  /** Bytes a not-yet-allocated copy will need; throws before the allocation. */
  plan(bytes: number): void {
    this.admit(bytes);
  }

  /** The planned copy now exists; its buffers are already inside the planned bytes. */
  allocated(buffers: readonly ArrayBufferLike[]): void {
    for (const buffer of buffers) this.counted.add(buffer);
  }

  private admit(bytes: number): void {
    const next = this.bytes + bytes;
    if (!Number.isSafeInteger(bytes) || bytes < 0 || !Number.isSafeInteger(next)
      || next > this.budget.limitBytes) throw new RangeError(DISPLAY_COPY_BUDGET_MESSAGE);
    this.bytes = next;
  }
}

function checkedDrawBytes(...sizes: readonly number[]): number {
  let total = 0;
  for (const size of sizes) {
    if (!Number.isSafeInteger(size) || size < 0 || !Number.isSafeInteger(total + size)) {
      throw new RangeError('Patterned local mesh byte count is invalid');
    }
    total += size;
  }
  return total;
}

function projectionAxes(normals: Float32Array, base: number): readonly [number, number] {
  const nx = Math.abs(normals[base] ?? Number.NaN);
  const ny = Math.abs(normals[base + 1] ?? Number.NaN);
  const nz = Math.abs(normals[base + 2] ?? Number.NaN);
  if (![nx, ny, nz].every(Number.isFinite)) {
    throw new RangeError('Patterned local mesh normal is invalid');
  }
  if (nz >= nx && nz >= ny) return [0, 1];
  if (ny >= nx) return [0, 2];
  return [1, 2];
}

/**
 * Pattern UVs are unwrapped per triangle. One period anchor for all three corners
 * keeps interpolation continuous over a repeat boundary; drawing-only vertices
 * allow neighbouring triangles to use different material spacing/projections.
 */
function patternedDrawArraysOf(
  mesh: SolidBody['mesh'],
  origin: readonly [number, number, number],
  plan: AppearancePlan,
  maximumLiveMeshBytes: number,
  retainedBytes: number,
  store: CopyStore,
  ledger: DisplayCopyLedger | undefined,
  allocated: ((buffer: ArrayBufferLike) => void) | undefined,
): DrawArrays {
  const source = mesh.positions;
  const normals = mesh.normals;
  const indices = mesh.indices;
  if (source.length % 3 !== 0 || normals.length !== source.length || indices.length % 3 !== 0) {
    throw new RangeError('Patterned local mesh arrays have invalid lengths');
  }
  const spacingByGroup = plan.groups.map((group) => {
    if (!Number.isSafeInteger(group.start) || !Number.isSafeInteger(group.count)
      || group.start < 0 || group.count < 0 || group.start % 3 !== 0 || group.count % 3 !== 0
      || !Number.isSafeInteger(group.start + group.count)
      || group.start + group.count > indices.length) {
      throw new RangeError('Patterned local mesh group is invalid');
    }
    const pattern = plan.appearances[group.materialIndex]?.pattern;
    if (pattern === undefined) throw new RangeError('Patterned local mesh material is missing');
    if (pattern.kind === 'none') return null;
    const spacing = pattern.spacing.value;
    if (!Number.isFinite(spacing) || spacing <= 0) {
      throw new RangeError('Patterned local mesh spacing is invalid');
    }
    return spacing;
  });
  const groupKey = plan.groups.map((group, index) =>
    `${group.start}/${group.count}/${group.materialIndex}/${String(spacingByGroup[index])}`).join(';');
  const sourceBytes = checkedDrawBytes(source.byteLength, normals.byteLength,
    indices.byteLength, mesh.edgePositions.byteLength);
  const copyBytes = checkedDrawBytes(indices.length * 12, indices.length * 12,
    indices.length * 4, indices.length * 8);
  const cached = store.patterned.get(source);
  const sameCache = cached !== undefined && cached.sourceNormals === normals
    && cached.sourceIndices === indices && cached.groupKey === groupKey
    && cached.origin.every((value, axis) => value === origin[axis]);
  const priorPatternBytes = cached === undefined || sameCache ? 0 : checkedDrawBytes(
    cached.positions.byteLength, cached.normals.byteLength,
    cached.indices.byteLength, cached.uv.byteLength);
  const priorBytes = checkedDrawBytes(priorPatternBytes,
    store.uv.get(source)?.uv.byteLength ?? 0);
  const required = checkedDrawBytes(retainedBytes, sourceBytes, copyBytes, priorBytes);
  if (required > maximumLiveMeshBytes) {
    throw new RangeError('Patterned local mesh exceeds live-byte budget');
  }
  // Validate every referenced value before allocating the drawing copies.
  for (const vertex of indices) {
    if (vertex >= source.length / 3) throw new RangeError('Patterned local mesh index is invalid');
    const base = vertex * 3;
    for (let axis = 0; axis < 3; axis += 1) {
      if (!Number.isFinite(source[base + axis]) || !Number.isFinite(normals[base + axis])) {
        throw new RangeError('Patterned local mesh coordinate is invalid');
      }
    }
  }
  for (let groupIndex = 0; groupIndex < plan.groups.length; groupIndex += 1) {
    const group = plan.groups[groupIndex];
    const spacing = spacingByGroup[groupIndex];
    if (spacing === null) continue;
    for (let corner = group.start; corner < group.start + group.count; corner += 3) {
      const firstBase = indices[corner] * 3;
      const [uAxis, vAxis] = projectionAxes(normals, firstBase);
      for (const axis of [uAxis, vAxis]) {
        const phase = origin[axis] % spacing;
        const anchor = Math.floor((phase + source[firstBase + axis]) / spacing) * spacing;
        if (!Number.isFinite(anchor)) {
          throw new RangeError('Patterned local mesh phase is invalid');
        }
        for (let offset = 0; offset < 3; offset += 1) {
          const projected = phase + source[indices[corner + offset] * 3 + axis] - anchor;
          if (!Number.isFinite(projected) || !Number.isFinite(Math.fround(projected))) {
            throw new RangeError('Patterned local mesh phase is invalid');
          }
        }
      }
    }
  }
  if (sameCache && cached !== undefined) {
    for (const array of [cached.positions, cached.normals, cached.indices, cached.uv]) ledger?.hold(array.buffer);
    return cached;
  }
  // The managed ledger refuses the drawing copies here, before any of them is allocated.
  ledger?.plan(copyBytes);

  const drawPositions = new Float32Array(indices.length * 3);
  notifyAllocatedBacking(allocated, drawPositions.buffer);
  const drawNormals = new Float32Array(indices.length * 3);
  notifyAllocatedBacking(allocated, drawNormals.buffer);
  const drawIndices = new Uint32Array(indices.length);
  notifyAllocatedBacking(allocated, drawIndices.buffer);
  const drawUv = new Float32Array(indices.length * 2);
  notifyAllocatedBacking(allocated, drawUv.buffer);
  for (let groupIndex = 0; groupIndex < plan.groups.length; groupIndex += 1) {
    const group = plan.groups[groupIndex];
    const spacing = spacingByGroup[groupIndex];
    for (let corner = group.start; corner < group.start + group.count; corner += 3) {
      const firstBase = indices[corner] * 3;
      const [uAxis, vAxis] = projectionAxes(normals, firstBase);
      const uPhase = spacing === null ? 0 : origin[uAxis] % spacing;
      const vPhase = spacing === null ? 0 : origin[vAxis] % spacing;
      const uAnchor = spacing === null ? 0 :
        Math.floor((uPhase + source[firstBase + uAxis]) / spacing) * spacing;
      const vAnchor = spacing === null ? 0 :
        Math.floor((vPhase + source[firstBase + vAxis]) / spacing) * spacing;
      for (let offset = 0; offset < 3; offset += 1) {
        const target = corner + offset;
        const sourceBase = indices[target] * 3;
        const drawBase = target * 3;
        drawPositions.set(source.subarray(sourceBase, sourceBase + 3), drawBase);
        drawNormals.set(normals.subarray(sourceBase, sourceBase + 3), drawBase);
        drawIndices[target] = target;
        drawUv[target * 2] = spacing === null ? origin[uAxis] + source[sourceBase + uAxis]
          : uPhase + source[sourceBase + uAxis] - uAnchor;
        drawUv[target * 2 + 1] = spacing === null ? origin[vAxis] + source[sourceBase + vAxis]
          : vPhase + source[sourceBase + vAxis] - vAnchor;
      }
    }
  }
  const result: PatternedDrawCache = { positions: drawPositions, normals: drawNormals,
    indices: drawIndices, uv: drawUv, sourceNormals: normals, sourceIndices: indices,
    origin: [origin[0], origin[1], origin[2]], groupKey };
  ledger?.allocated([drawPositions.buffer, drawNormals.buffer, drawIndices.buffer, drawUv.buffer]);
  store.uv.delete(source);
  store.patterned.set(source, result);
  return result;
}

function boxProjectedUvOf(
  positions: Float32Array,
  normals: Float32Array,
  origin: readonly [number, number, number],
  store: CopyStore = SHARED_COPIES,
  ledger?: DisplayCopyLedger,
  allocated?: (buffer: ArrayBufferLike) => void,
): Float32Array {
  store.patterned.delete(positions);
  const cached = store.uv.get(positions);
  if (cached !== undefined
    && cached.normals === normals
    && cached.origin[0] === origin[0]
    && cached.origin[1] === origin[1]
    && cached.origin[2] === origin[2]) {
    ledger?.hold(cached.uv.buffer);
    return cached.uv;
  }
  // Two Float32 values per vertex; the managed ledger refuses them before allocation.
  ledger?.plan(Math.floor(positions.length / 3) * 8);
  const uv = buildBoxProjectedUv(positions, normals, origin, allocated);
  ledger?.allocated([uv.buffer]);
  store.uv.set(positions, { normals, origin: [origin[0], origin[1], origin[2]], uv });
  return uv;
}

/** 面の割り当てが 1 つも無いボディに使う空の表(毎回作らない)。 */
const NO_FACE_APPEARANCES: ReadonlyMap<number, AppearanceSpec> = new Map<number, AppearanceSpec>();

/**
 * まとまりが索引の全体をちょうど覆うようにする(three の `addGroup` の約束)。
 *
 * 面の範囲表に隙間があっても(三角形が付かなかった面などで起こりうる)、覆われない索引が
 * 出ると**その三角形がまったく描かれない**。P2 と同じ絵を出すため、隙間と末尾は
 * このボディの既定(材質 0 番)で埋める。隣り合う同じ材質は 1 つに畳んでドローコールを
 * 増やさない。
 */
function coverAllIndices(groups: readonly FaceGroup[], indexCount: number): readonly FaceGroup[] {
  const covered: FaceGroup[] = [];
  const push = (start: number, count: number, materialIndex: number): void => {
    if (count <= 0) {
      return;
    }
    const last = covered.length > 0 ? covered[covered.length - 1] : undefined;
    if (last !== undefined && last.materialIndex === materialIndex) {
      covered[covered.length - 1] = { start: last.start, count: last.count + count, materialIndex };
      return;
    }
    covered.push({ start, count, materialIndex });
  };

  let cursor = 0;
  for (const group of groups) {
    const start = Math.max(group.start, cursor);
    const end = Math.min(group.start + group.count, indexCount);
    if (end <= start) {
      continue;
    }
    push(cursor, start - cursor, 0);
    push(start, end - start, group.materialIndex);
    cursor = end;
  }
  push(cursor, indexCount - cursor, 0);
  return covered;
}

interface AppearancePlan {
  readonly groups: readonly FaceGroup[];
  readonly appearances: readonly AppearanceSpec[];
  readonly limitExceeded: boolean;
}

/**
 * ボディ 1 つぶんのまとまりと材質の一覧を決める。
 *
 * 材質が 1 種類しか無いとき(= 外観を割り当てていない、または立体全体に 1 つだけ)は
 * **面の範囲表を見ずに索引の全体を 1 つのまとまりにする**。ドローコールが 1 で済み、
 * 面の範囲表がどうであれ P2 と 1 ドットも変わらない絵になる(§0.a-0.12)ため。
 */
function appearancePlanOf(
  body: SolidBodyWithSubShapes,
  indexCount: number,
  appearance: AppearanceInput | undefined,
): AppearancePlan {
  const defaultAppearance = appearance?.defaultAppearance ?? DEFAULT_APPEARANCE;
  const assignment = appearance?.byBody.get(body.featureId);
  const bodyAppearance = assignment?.bodyAppearance ?? null;
  const base = bodyAppearance ?? defaultAppearance;
  const wholeBody: readonly FaceGroup[] = [{ start: 0, count: indexCount, materialIndex: 0 }];

  const plan = buildFaceGroups(
    body.faces ?? [],
    assignment?.faceAppearances ?? NO_FACE_APPEARANCES,
    bodyAppearance,
    defaultAppearance,
  );
  if (plan === null) {
    return { groups: wholeBody, appearances: [base], limitExceeded: true };
  }
  if (plan.appearances.length <= 1) {
    return { groups: wholeBody, appearances: [base], limitExceeded: false };
  }
  return {
    groups: coverAllIndices(plan.groups, indexCount),
    appearances: plan.appearances,
    limitExceeded: false,
  };
}

/**
 * ボディの一覧と強調から、描画用の並び一式を組み立てる。
 *
 * 変化したときにだけ呼ぶ(毎フレーム呼ばない、NFR-PF-1)。通常は並びを写さず、
 * 柄付きlocalでも同じ元配列/材質/原点なら描画用の控えを再利用する。
 *
 * `appearance` は省略できる(FR-1106 の配線が済むまでと、外観を持たない呼び出しのため)。
 * 省略したときは全ボディが既定の外観 1 色・まとまり 1 つになり、P2 と同じ絵が出る。
 */
export function buildSolidGeometry(
  bodies: readonly SolidBodyWithSubShapes[],
  hoveredBodyId: string | null,
  selectedBodyIds: readonly string[],
  appearance?: AppearanceInput,
  maximumLiveMeshBytes = MAX_DRAW_MESH_BYTES,
  managed?: ManagedDisplayCopies,
): SolidGeometryBundle {
  if (!Number.isSafeInteger(maximumLiveMeshBytes) || maximumLiveMeshBytes <= 0
    || maximumLiveMeshBytes > MAX_DRAW_MESH_BYTES) {
    throw new RangeError('Patterned local mesh budget must be a positive safe integer <= 512 MiB');
  }
  let bundleBudget = maximumLiveMeshBytes;
  for (const body of bodies) {
    const limit = body.coordinateFrame?.maximumLiveMeshBytes;
    if (limit === undefined) continue;
    if (!Number.isSafeInteger(limit) || limit <= 0 || limit > MAX_DRAW_MESH_BYTES) {
      throw new RangeError('Local body mesh budget must be a positive safe integer <= 512 MiB');
    }
    bundleBudget = Math.min(bundleBudget, limit);
  }
  const selected = new Set(selectedBodyIds);
  const entries: SolidDrawEntry[] = [];
  const index = new Map<string, SolidDrawEntry>();
  let triangleOffset = 0;
  let edgeOffset = 0;
  let retainedDrawBytes = 0;
  const store: CopyStore = managed?.cache ?? SHARED_COPIES;
  // Constructed before any copy: the kernel baseline and every live UI copy are counted first.
  const ledger = managed?.budget === undefined ? undefined : new DisplayCopyLedger(managed.budget, managed.cache);
  const copies = new Set<ArrayBufferLike>();

  for (const body of bodies) {
    // 1 フィーチャーが作るボディは最大 1 つ(§0.a-0.5)。同じ id が 2 つ来たら
    // 先のものだけを描き、対応表が後のもので上書きされないようにする。
    if (index.has(body.featureId) || !isDrawableBody(body)) {
      continue;
    }
    const mesh = body.mesh;
    const edgeCount = Math.floor(mesh.edgePositions.length / 6);
    const plan = appearancePlanOf(body, mesh.indices.length, appearance);
    const patterned = body.coordinateFrame !== undefined && mesh.indices.length > 0
      && plan.appearances.some((spec) => spec.pattern.kind !== 'none');
    const draw = patterned ? patternedDrawArraysOf(mesh, body.coordinateFrame.origin,
      plan, bundleBudget, retainedDrawBytes, store, ledger, managed?.allocated) : null;
    if (draw !== null) {
      retainedDrawBytes = checkedDrawBytes(retainedDrawBytes, mesh.positions.byteLength,
        mesh.normals.byteLength, mesh.indices.byteLength, mesh.edgePositions.byteLength,
        draw.positions.byteLength, draw.normals.byteLength, draw.indices.byteLength, draw.uv.byteLength);
    }
    const entry: SolidDrawEntry = {
      featureId: body.featureId,
      positions: draw?.positions ?? mesh.positions,
      normals: draw?.normals ?? mesh.normals,
      indices: draw?.indices ?? mesh.indices,
      edgePositions: mesh.edgePositions,
      ...(body.coordinateFrame === undefined ? {} : { coordinateFrame: body.coordinateFrame }),
      emphasis: solidEmphasisOf(body.featureId, hoveredBodyId, selected),
      drawIndex: entries.length,
      triangleOffset,
      triangleCount: mesh.triangleCount,
      edgeOffset,
      edgeCount,
      faces: body.faces ?? [],
      edges: body.edges ?? [],
      vertices: body.vertices ?? [],
      uv: draw?.uv ?? boxProjectedUvOf(mesh.positions, mesh.normals, body.coordinateFrame?.origin ?? [0, 0, 0],
        store, ledger, managed?.allocated),
      groups: plan.groups,
      appearances: plan.appearances,
      appearanceLimitExceeded: plan.limitExceeded,
    };
    entries.push(entry);
    index.set(entry.featureId, entry);
    triangleOffset += entry.triangleCount;
    edgeOffset += edgeCount;
    copies.add(entry.uv.buffer);
    if (draw !== null) for (const array of [draw.positions, draw.normals, draw.indices]) copies.add(array.buffer);
  }

  return { entries, triangleCount: triangleOffset, edgeCount: edgeOffset, index,
    ...(managed === undefined ? {} : { displayCopies: Object.freeze([...copies]) }) };
}

/** Exact bytes of distinct typed backings, the shared unit of CPU display-copy accounting. */
export function distinctBackingBytes(buffers: Iterable<ArrayBufferLike>): number {
  let bytes = 0;
  for (const buffer of new Set(buffers)) bytes += buffer.byteLength;
  return bytes;
}
