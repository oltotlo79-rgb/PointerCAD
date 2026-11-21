import { createHash } from 'node:crypto';

import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import { loadOcctForNode } from '../occt/loadOcct.node.js';
import { writeStep } from '../occt/writeStep.js';
import type { CurveSpec, SolidBodyMesh, SolidRecomputeRequest, SolidStepRequest, SolidStepSpec, Vec3Tuple } from '../types.js';
import { recomputeSolids, type CachedSolid } from './recomputeSolids.js';
import { createShapeCache, type ShapeCache } from './shapeCache.js';
import { stepBytesForComparison } from './stepBytesForComparison.testSupport.js';

/**
 * 工具 1 個の和・差・積の結果を、和・差の一括工具入力(M-04 の計算部)を足す**前**の計算部で録った値に固定する。
 *
 * 録った時の版: commit c286bc8b(作業ツリーの packages/kernel に変更なし)。値の出どころと計算部のファイルの SHA-256 は
 * 統括の記録(担当フォルダーの kernel0/record.md)にある。
 *
 * **比べ方は 2 段に分ける(両 OS の外部検査で、手元で録った値が違う値で落ちないようにするため)。**
 * - 段 A(録った値と比べる。OS によらない形だけ): 失敗 0・キャッシュの当たり 0・ボディの id と種類・B-rep の面・辺・頂点の数(整数)・
 *   名前の継ぎの状態(文字)・体積(相対 1e-9。下の VOLUME_RELATIVE)。体積は手で出した値とも比べる(ANALYTIC_RELATIVE)。
 * - 段 B(同じプロセスの中で 2 回作って完全一致。`determinism.test.ts` と同じ強さ): 表示のメッシュの位置・法線・番号・辺の
 *   バイトの SHA-256、三角形の数、体積の float64 のバイト、面・辺・頂点の情報と名前の継ぎの JSON の SHA-256、STEP のバイト
 *   (4 行目の日時だけを `stepBytesForComparison` で伏せる)の SHA-256。
 *   段 B の値は手元(Windows、node の arm64)で録った参考の値 REFERENCE と比べた結果を記録に出すだけで、合否にしない。
 *   既存の決定性検査も「同じプロセスの中の 2 回」しか比べておらず、別の OS・別のプロセスで同じバイトになる事は、この
 *   リポジトリの検査ではまだ示されていないため。両 OS の外部検査の記録で参考の値と全部一致した後に、完全一致の合否へ上げる。
 */

/** 録った体積との比べの相対の幅。計算部の同じ道なら差は 0 のはずで、OS の差(最後の桁)だけを吸う幅。 */
const VOLUME_RELATIVE = 1e-9;
/** 手で出した体積との比べの相対の幅。平面だけの形は 1e-9、曲面を含む形は 1e-7(OCCT の体積の積分の精度の範囲)。 */
const PLANAR_RELATIVE = 1e-9;
const CURVED_RELATIVE = 1e-7;

interface GoldenCase {
  readonly name: string;
  readonly steps: readonly SolidStepRequest[];
  /** 画面に出る最後の段(和・差・積)。 */
  readonly finalKey: string;
  readonly finalId: string;
  readonly analyticVolume: number;
  readonly analyticRelative: number;
}

/** 段 A: 録った値と比べる欄。 */
interface RecordedBody {
  readonly faceCount: number;
  readonly edgeCount: number;
  readonly vertexCount: number;
  readonly volume: number;
  readonly originsState: string;
}

/** 段 B: 同じプロセスの中の 2 回で完全一致を求める欄(参考の値と比べた結果は記録に出すだけ)。 */
interface ByteFingerprint {
  readonly meshSha256: string;
  readonly triangleCount: number;
  readonly volumeBits: string;
  readonly topologySha256: string;
  readonly originsSha256: string;
  readonly stepSha256: string;
}

function rectangleAt(x: number, y: number, z: number, width: number, depth: number): readonly CurveSpec[] {
  return [
    { kind: 'segment', from: [x, y, z], to: [x + width, y, z] },
    { kind: 'segment', from: [x + width, y, z], to: [x + width, y + depth, z] },
    { kind: 'segment', from: [x + width, y + depth, z], to: [x, y + depth, z] },
    { kind: 'segment', from: [x, y + depth, z], to: [x, y, z] },
  ];
}

function step(id: string, spec: SolidStepSpec, visible = false): SolidStepRequest {
  return { key: `key-${id}`, id, label: id, visible, step: spec };
}

function box(id: string, x: number, y: number, z: number, width: number, depth: number, height: number): SolidStepRequest {
  return step(id, { kind: 'extrude', profile: rectangleAt(x, y, z, width, depth), direction: [0, 0, 1], distance: height });
}

/** 基本形状の箱(中心が center)。基本形状は名前の継ぎを持つので、和・差・積の名前の継ぎ(semantic)の道も通る。 */
function primitiveBox(id: string, center: Vec3Tuple, sizeX: number, sizeY: number, sizeZ: number): SolidStepRequest {
  return step(id, { kind: 'primitive', origin: center, axis: [0, 0, 1], shape: { kind: 'box', sizeX, sizeY, sizeZ },
    originQuery: null, targetKey: null });
}

function cylinder(id: string, origin: Vec3Tuple, radius: number, height: number): SolidStepRequest {
  return step(id, { kind: 'primitive', origin, axis: [0, 0, 1], shape: { kind: 'cylinder', radius, height },
    originQuery: null, targetKey: null });
}

function sphere(id: string, origin: Vec3Tuple, radius: number): SolidStepRequest {
  return step(id, { kind: 'primitive', origin, axis: [0, 0, 1], shape: { kind: 'sphere', radius }, originQuery: null, targetKey: null });
}

/** 楕円の柱(押し出し)。工具に楕円の押し出しがあると、和・差の前に楕円の前処理(ellipseBoolean.ts)が効く。 */
function ellipticPrism(id: string, center: Vec3Tuple, majorRadius: number, minorRadius: number, height: number): SolidStepRequest {
  return step(id, { kind: 'extrude', profile: [{ kind: 'ellipse', center, normal: [0, 0, 1], majorAxis: [1, 0, 0],
    majorRadius, minorRadius }], direction: [0, 0, 1], distance: height });
}

function combine(id: string, operation: 'union' | 'subtract' | 'intersect', target: string, tool: string,
  options: { readonly visible?: boolean; readonly requireRemoval?: true } = {}): SolidStepRequest {
  return step(id, { kind: 'boolean', operation, targetKey: `key-${target}`, toolKey: `key-${tool}`,
    ...(options.requireRemoval === undefined ? {} : { requireRemoval: options.requireRemoval }) }, options.visible ?? true);
}

const CASES: readonly GoldenCase[] = [
  { name: '和: 箱 40×30×10 と箱 20×20×20(10×20×10 が重なる)', finalKey: 'key-union', finalId: 'union',
    steps: [box('plate', 0, 0, 0, 40, 30, 10), box('block', 30, 10, 0, 20, 20, 20), combine('union', 'union', 'plate', 'block')],
    analyticVolume: 12_000 + 8_000 - 2_000, analyticRelative: PLANAR_RELATIVE },
  { name: '差: 基本形状の箱 40×30×10 から半径 6 の円柱の貫通(名前の継ぎあり)', finalKey: 'key-cut', finalId: 'cut',
    steps: [primitiveBox('plate', [20, 15, 5], 40, 30, 10), cylinder('pin', [20, 15, -1], 6, 12), combine('cut', 'subtract', 'plate', 'pin')],
    analyticVolume: 12_000 - Math.PI * 36 * 10, analyticRelative: CURVED_RELATIVE },
  { name: '積: 基本形状の箱 40×30×10 と半径 8 の球(中心 z=5。上下 3 ずつの帽子が外れる。名前の継ぎあり)', finalKey: 'key-common',
    finalId: 'common',
    steps: [primitiveBox('plate', [20, 15, 5], 40, 30, 10), sphere('ball', [20, 15, 5], 8), combine('common', 'intersect', 'plate', 'ball')],
    analyticVolume: (4 / 3) * Math.PI * 512 - 2 * (Math.PI * 9 * (3 * 8 - 3)) / 3, analyticRelative: CURVED_RELATIVE },
  { name: '差: 楕円の柱(長 8・短 5)の貫通(楕円の前処理が効く)', finalKey: 'key-ellipse', finalId: 'ellipse',
    steps: [box('plate', 0, 0, 0, 40, 30, 10), ellipticPrism('oval', [20, 15, -1], 8, 5, 12), combine('ellipse', 'subtract', 'plate', 'oval')],
    analyticVolume: 12_000 - Math.PI * 8 * 5 * 10, analyticRelative: CURVED_RELATIVE },
  { name: '差(何も削れない差を断る欄つき): 基本形状の箱から円柱の貫通(名前の継ぎあり)', finalKey: 'key-cutRequired',
    finalId: 'cutRequired',
    steps: [primitiveBox('plate', [20, 15, 5], 40, 30, 10), cylinder('pin', [20, 15, -1], 6, 12),
      combine('cutRequired', 'subtract', 'plate', 'pin', { requireRemoval: true })],
    analyticVolume: 12_000 - Math.PI * 36 * 10, analyticRelative: CURVED_RELATIVE },
  { name: '積(内側も外側も残る事を確かめる欄つき): 箱と箱 20×20×12', finalKey: 'key-commonRequired', finalId: 'commonRequired',
    steps: [box('plate', 0, 0, 0, 40, 30, 10), box('window', 10, 5, -1, 20, 20, 12),
      combine('commonRequired', 'intersect', 'plate', 'window', { requireRemoval: true })],
    analyticVolume: 20 * 20 * 10, analyticRelative: PLANAR_RELATIVE },
  { name: '差の連鎖 3 段: 基本形状の箱 60×20×10 から半径 3 の円柱を 3 本(名前の継ぎあり)', finalKey: 'key-cut3', finalId: 'cut3',
    steps: [primitiveBox('bar', [30, 10, 5], 60, 20, 10), cylinder('pin1', [15, 10, -1], 3, 12), cylinder('pin2', [30, 10, -1], 3, 12),
      cylinder('pin3', [45, 10, -1], 3, 12), combine('cut1', 'subtract', 'bar', 'pin1', { visible: false }),
      combine('cut2', 'subtract', 'cut1', 'pin2', { visible: false }), combine('cut3', 'subtract', 'cut2', 'pin3')],
    analyticVolume: 12_000 - 3 * Math.PI * 9 * 10, analyticRelative: CURVED_RELATIVE },
];

/** 段 A の録った値(commit c286bc8b の計算部、手元の Windows・node v25.9.0 arm64 で録った)。 */
const RECORDED: Readonly<Record<string, RecordedBody>> = {
  union: { faceCount: 14, edgeCount: 32, vertexCount: 20, volume: 18000, originsState: 'untracked' },
  cut: { faceCount: 7, edgeCount: 15, vertexCount: 10, volume: 10869.026644707676, originsState: 'tracked' },
  common: { faceCount: 3, edgeCount: 3, vertexCount: 2, volume: 1748.8199104983187, originsState: 'tracked' },
  ellipse: { faceCount: 7, edgeCount: 15, vertexCount: 10, volume: 10743.362938563054, originsState: 'untracked' },
  cutRequired: { faceCount: 7, edgeCount: 15, vertexCount: 10, volume: 10869.026644707676, originsState: 'tracked' },
  commonRequired: { faceCount: 6, edgeCount: 12, vertexCount: 8, volume: 3999.999999999999, originsState: 'untracked' },
  cut3: { faceCount: 9, edgeCount: 21, vertexCount: 14, volume: 11151.769983530756, originsState: 'tracked' },
};

/**
 * 段 B の参考の値(同じ時に録った)。合否にはしない(上の説明のとおり)。STEP の SHA-256 は名前(最後の段の鍵)を含むので、
 * 同じ形の cut と cutRequired でも違う。
 */
const REFERENCE: Readonly<Record<string, ByteFingerprint>> = {
  union: {
    meshSha256: '215b34a28022ab4cc2d9de9532dc1a127d338ae0b886abc06fb22cf19b3d14ab',
    triangleCount: 36, volumeBits: '000000000094d140',
    topologySha256: '8d0fd84be327d22c8b35dc714ccaa842df5c40f4827f528773ce90eeb45e0752',
    originsSha256: '843c0eacbb5eea80ec43e4d0e5d99e82f31906339a7a5ba8ae16e4c13a83a985',
    stepSha256: '6c844e7b5a3ea33b0bf4572ccc920a33f7fef31f908f963bceed1590ecf19ecf',
  },
  cut: {
    meshSha256: 'bd22dc20fcfc58f9d4da8a02e8f8cb21bb7a133c16e0274c2eb7ee9a2c8c2d0c',
    triangleCount: 120, volumeBits: '0a021869833ac540',
    topologySha256: 'bd53e251b370447699fd047a6d1773de84085db52baed10b850d3c5ebe217c93',
    originsSha256: 'e2f29efbf94446e7411ab982bc2c590502983d6f19fb9c9e75c88e33ec9c9aa2',
    stepSha256: '8c84ea67b1e484c8b2045f5f41911973493cbed0945ba7b54577e47d893d04f8',
  },
  common: {
    meshSha256: 'ce9ef893d806e1de68c990a38f4538451e1110b57878a6d20d56bc4668763c8c',
    triangleCount: 454, volumeBits: 'b41f9e9647539b40',
    topologySha256: '1b8034453aee00cbf6670a2cca00cc332a7593dc675ed711b6d8aff39f83e0df',
    originsSha256: 'a17bb8f687aeb300401057b8f681d0bcca6a611e841cf803b30c0398bcca4b67',
    stepSha256: '0f0c50252651531a9e297d2246eefb7713f5549004e0fef1011a8567f624dfe3',
  },
  ellipse: {
    meshSha256: 'c06660ef006b0c98ac74ee9021a2f035864d7d622289cde9b3c2bfc53c12f1a5',
    triangleCount: 148, volumeBits: '6355c574aefbc440',
    topologySha256: '2c9c4ddf5d359550914e31de50121566c105b56ee19905ff93cefdb9fdbc61ff',
    originsSha256: '843c0eacbb5eea80ec43e4d0e5d99e82f31906339a7a5ba8ae16e4c13a83a985',
    stepSha256: 'e48d7e4fb7fdb37ea9337ab03e486d52ebaf2309b293d8231f465afbc88423f4',
  },
  cutRequired: {
    meshSha256: 'bd22dc20fcfc58f9d4da8a02e8f8cb21bb7a133c16e0274c2eb7ee9a2c8c2d0c',
    triangleCount: 120, volumeBits: '0a021869833ac540',
    topologySha256: 'bd53e251b370447699fd047a6d1773de84085db52baed10b850d3c5ebe217c93',
    originsSha256: 'e2f29efbf94446e7411ab982bc2c590502983d6f19fb9c9e75c88e33ec9c9aa2',
    stepSha256: 'a153120aa3b996ab9ae8a23d4403feebf04068292cf1811c47ba6bfd5fb0ab98',
  },
  commonRequired: {
    meshSha256: 'ed557d2836ccd69c292c42fb4aeb233f9bcec5fa872902dc194615d6f8586a42',
    triangleCount: 12, volumeBits: 'feffffffff3faf40',
    topologySha256: 'e39e3e28f3a55587eb8d93f6a425c90ebfa24a8c4bf2c3980c514699ffc78e4b',
    originsSha256: '843c0eacbb5eea80ec43e4d0e5d99e82f31906339a7a5ba8ae16e4c13a83a985',
    stepSha256: '3846d748b0cffd24775ed41b13ffd8f10d3272fc48198eb2f1fe113e9f8e65ca',
  },
  cut3: {
    meshSha256: '723d2b14c9199ecbaab7205aa5787a2b4fbf2a2d3b6a16f61cd0a24a4bebdf25',
    triangleCount: 336, volumeBits: '8701d28ee2c7c540',
    topologySha256: 'b6d5fc43cd79490bc00feacbcce28399e887a611cde462f311ea605e15dcb43e',
    originsSha256: '206a39e7a36f7a089adb5293a71f46257daa0a1ea9ca80d5530b7cd30a868474',
    stepSha256: '6324978aa446e6b1917e796bb9679971616a92458a41f1f9dfbad6e5abf9eb43',
  },
};

function sha256(...parts: readonly ArrayBufferView[]): string {
  const hash = createHash('sha256');
  for (const part of parts) hash.update(new Uint8Array(part.buffer, part.byteOffset, part.byteLength));
  return hash.digest('hex');
}

function textSha256(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value ?? null)).digest('hex');
}

function volumeBits(volume: number): string {
  return Buffer.from(new Float64Array([volume]).buffer).toString('hex');
}

function recordedOf(body: SolidBodyMesh): RecordedBody {
  return { faceCount: body.faceCount, edgeCount: body.edgeCount, vertexCount: body.vertices.length, volume: body.volume,
    originsState: body.origins?.state ?? 'none' };
}

function relativeDifference(actual: number, expected: number): number {
  return Math.abs(actual - expected) / Math.abs(expected);
}

describe('工具 1 個の和・差・積は、一括工具入力を足す前に録った結果のまま(M-04 の計算部 kernel-0)', () => {
  let oc: Awaited<ReturnType<typeof loadOcctForNode>>;
  const openCaches: ShapeCache<CachedSolid>[] = [];

  beforeAll(async () => {
    oc = await loadOcctForNode();
  });

  afterEach(() => {
    for (const cache of openCaches.splice(0)) cache.clear();
  });

  async function computeOnce(golden: GoldenCase): Promise<{ readonly body: SolidBodyMesh; readonly bytes: ByteFingerprint }> {
    const cache = createShapeCache<CachedSolid>();
    openCaches.push(cache);
    const request: SolidRecomputeRequest = { steps: golden.steps, generation: 1 };
    const result = await recomputeSolids({ oc, cache }, request);
    expect(result.failures).toEqual([]);
    expect(result.cacheHits).toBe(0);
    expect(result.bodies.map((item) => item.id)).toEqual([golden.finalId]);
    const [body] = result.bodies;
    const cached = cache.get(golden.finalKey);
    if (body === undefined || cached === undefined) throw new Error(`${golden.name}: 最後の段の形がありません`);
    const stepBytes = stepBytesForComparison(writeStep(oc, [{ shape: cached.shape, name: golden.finalKey, color: null }]).bytes);
    return { body, bytes: {
      meshSha256: sha256(body.positions, body.normals, body.indices, body.edgePositions),
      triangleCount: body.triangleCount,
      volumeBits: volumeBits(body.volume),
      topologySha256: textSha256([body.faces, body.edges, body.vertices]),
      originsSha256: textSha256(body.origins),
      stepSha256: sha256(stepBytes),
    } };
  }

  it.each(CASES)('$name', async (golden) => {
    const first = await computeOnce(golden);
    const second = await computeOnce(golden);
    // 段 B: 同じプロセスの中の 2 回で、バイトまで完全一致。
    expect(second.bytes).toEqual(first.bytes);
    const reference = REFERENCE[golden.finalId];
    console.log(`GOLDEN ${JSON.stringify({ id: golden.finalId, recorded: recordedOf(first.body), bytes: first.bytes,
      sameAsReference: reference === undefined ? null : JSON.stringify(reference) === JSON.stringify(first.bytes) })}`);
    // 段 A: 録った値と比べる(OS によらない形だけ)。
    const recorded = RECORDED[golden.finalId];
    expect(recorded).toBeDefined();
    if (recorded === undefined) return;
    expect(first.body.bodyKind).toBe('solid');
    expect({ ...recordedOf(first.body), volume: 0 }).toEqual({ ...recorded, volume: 0 });
    expect(relativeDifference(first.body.volume, recorded.volume)).toBeLessThanOrEqual(VOLUME_RELATIVE);
    expect(relativeDifference(first.body.volume, golden.analyticVolume)).toBeLessThanOrEqual(golden.analyticRelative);
  });
});
