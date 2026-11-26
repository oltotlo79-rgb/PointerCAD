/**
 * 資料の平板のブラケット(断面の輪の穴を押し出し、引き算で作る形)を、形を作る処理(kernel)で実際に作り、穴の面の表から通し穴を読めるかを確かめる。
 * 手で作った面の表の試験だけでは、実物の表(穴が半円 2 面に分かれる・起源の表を作らない)との食い違いを見つけられなかったため(2026-11-18)。
 * 期待の穴の数・穴径・板の厚さは、行の値(holesX × holesY・holeDiameter・thickness)から独立に決める。
 */
import { createKernelApi } from '@pointercad/kernel';
import { loadOcctForNode } from '@pointercad/kernel/testing/occt-node';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDirectKernelBridge } from '../../kernelBridge.js';
import { resolveSubShapeReference } from '../../kernelBridge/referenceResolution.js';
import type { SolidBody, SolidFaceEntry } from '../../kernelBridge/solidContracts.js';
import type { SubShapeRef } from '../../geometry/subShapeRef.js';
import { withinMagnitude } from '../../numericTolerance.js';
import { recomputePart } from '../../part/recomputePart.js';
import { dotVec3 } from '../../sketch/vec3.js';
import { FLAT_PLATE_FAMILY } from '../catalog/families/framePartCatalog.js';
import { FLAT_PLATE_RECORDS } from '../catalog/families/framePartRows.js';
import { DEFAULT_COMPONENT_PLACEMENT } from '../createAssemblyDocument.js';
import type { AssemblyComponent } from '../types.js';
import { profileClearanceHole, profileHoleSpan } from './frameSlotRequest.js';

/** kernel の面の表の寸法と行の値の一致とみなす幅(mm)。面の表の径・帯は解析の値なので、丸めの桁まで合う。 */
const KERNEL_LENGTH_TOLERANCE_MM = 1e-6;
/** 穴の軸と平面の法線を平行とみなす、内積の絶対値の 1 からのずれ。 */
const AXIS_PARALLEL_TOLERANCE = 1e-6;

const PLATE: AssemblyComponent = { id: 'plate', name: 'plate', source: { kind: 'part', partRef: 'plate' }, placement: DEFAULT_COMPONENT_PLACEMENT,
  fixed: false, visible: true, suppressed: false };
const REVISIONS: ReadonlyMap<string, string> = new Map([['plate', 'r1']]);

const bridge = createDirectKernelBridge(createKernelApi(loadOcctForNode));
beforeAll(async () => { await loadOcctForNode(); }, 180_000);
afterAll(() => { bridge.dispose(); });

/** 行の鍵で形を作り、最後の体を返す。 */
async function plateBody(key: string): Promise<SolidBody> {
  const row = FLAT_PLATE_FAMILY.rows.find((candidate) => candidate.key === key);
  const part = row === undefined ? null : FLAT_PLATE_FAMILY.build(row, {});
  if (part === null) throw new Error(`形が作れない: ${key}`);
  const result = await recomputePart(part, bridge);
  expect(result.errors, key).toEqual([]);
  const last = part.solids.at(-1)?.id;
  const body = result.bodies.find((entry) => entry.featureId === last);
  if (body === undefined) throw new Error(`最後の体が無い: ${key}`);
  return body;
}

/** 指紋だけの参照(起源の表を作らない形で、画面のクリックが作る参照と同じ中身)。 */
function fingerprintRef(body: SolidBody, face: SolidFaceEntry): SubShapeRef {
  return { bodyFeatureId: body.featureId, index: face.index, fingerprint: { kind: 'face', surfaceKind: face.surfaceKind, area: face.area,
    position: face.centroid, axis: face.axis, radius: face.radius } };
}

/** 穴の面の帯の端の平面(穴の軸に直交し、穴の面と辺を共有する面)。 */
function endPlanes(body: SolidBody, wall: SolidFaceEntry): readonly SolidFaceEntry[] {
  const axis = wall.axis;
  return axis === null ? [] : body.faces.filter((face) => face.surfaceKind === 'plane' && face.axis !== null
    && 1 - Math.abs(dotVec3(face.axis, axis)) <= AXIS_PARALLEL_TOLERANCE && (wall.adjacentFaces ?? []).includes(face.index));
}

/** 穴の見分け(板は z の向きの厚さなので、軸の上の点の x・y)。 */
function holeCenterKey(face: SolidFaceEntry): string {
  const origin = face.axisOrigin ?? null;
  return origin === null ? 'none' : `${origin[0].toFixed(3)},${origin[1].toFixed(3)}`;
}

describe('資料の平板のブラケットの穴を、kernel で作った面の表から通し穴に読む', () => {
  it('穴ごとに全周の穴に読め、帯の端の平面のどちらを合わせ面にしても、行の穴径・板の厚さの通し穴になり、面は指紋の参照で 1 つに決まる', async () => {
    const record = FLAT_PLATE_RECORDS.find((candidate) => candidate.key === 's6-36x16x2-h2');
    if (record === undefined) throw new Error('行が無い');
    const body = await plateBody(record.key);
    const walls = body.faces.filter((face) => face.surfaceKind === 'cylinder' && face.radius !== null
      && withinMagnitude(face.radius - record.holeDiameter / 2, KERNEL_LENGTH_TOLERANCE_MM));
    expect(new Set(walls.map(holeCenterKey)).size).toBe(record.holesX.length * record.holesY.length);
    for (const wall of walls) {
      const span = profileHoleSpan(wall, body.faces, body.edges);
      if (span === null) throw new Error(`面 ${String(wall.index)} が全周の穴に読めない`);
      expect(withinMagnitude(span[1] - span[0] - record.thickness, KERNEL_LENGTH_TOLERANCE_MM), `面 ${String(wall.index)} の帯`).toBe(true);
      const planes = endPlanes(body, wall);
      expect(planes.length, `面 ${String(wall.index)} の帯の端の平面`).toBe(2);
      for (const face of [wall, ...planes]) {
        const resolved = resolveSubShapeReference(body, fingerprintRef(body, face));
        expect(resolved.status === 'matched' ? resolved.match.reference.index : resolved.status, `面 ${String(face.index)} の参照`).toBe(face.index);
      }
      for (const mating of planes) {
        const read = profileClearanceHole(PLATE, REVISIONS, { holeFeatureId: body.featureId, hole: wall, mating,
          matingRef: fingerprintRef(body, mating), bodyFaces: body.faces, bodyEdges: body.edges });
        if (typeof read === 'string' || 'code' in read) throw new Error(`面 ${String(wall.index)}・${String(mating.index)}: ${JSON.stringify(read)}`);
        if (read.hole.kind !== 'clearance') throw new Error(`面 ${String(wall.index)}・${String(mating.index)}: ${read.hole.kind}`);
        expect(withinMagnitude(read.hole.diameter - record.holeDiameter, KERNEL_LENGTH_TOLERANCE_MM), '穴径').toBe(true);
        expect(withinMagnitude(read.hole.length - record.thickness, KERNEL_LENGTH_TOLERANCE_MM), '長さ').toBe(true);
      }
    }
  }, 300_000);

  it.each([
    { key: 's6-36x16x2-h2', length: 36, width: 16, thickness: 2, chamfer: 1.5, radius: 2.75, endOffset: 10 },
    { key: 's8-55x24x3-h2', length: 55, width: 24, thickness: 3, chamfer: 2, radius: 3.3, endOffset: 15 },
    { key: 's10-75x34x3-h2', length: 75, width: 34, thickness: 3, chamfer: 2, radius: 4.4, endOffset: 20 },
  ])('登録溝幅の板 $key は実際に 2 穴を持ち、どちらの穴も実面から読める', async (item) => {
    const body = await plateBody(item.key);
    const expectedVolume = (item.length * item.width - 2 * item.chamfer ** 2 - 2 * Math.PI * item.radius ** 2) * item.thickness;
    expect(body.volume).toBeCloseTo(expectedVolume, 6);

    const walls = body.faces.filter((face) => face.surfaceKind === 'cylinder' && face.cylinderExterior === false
      && face.radius !== null && withinMagnitude(face.radius - item.radius, KERNEL_LENGTH_TOLERANCE_MM));
    const centers = [...new Set(walls.map(holeCenterKey))].sort();
    expect(centers).toEqual([-item.endOffset, item.endOffset].map((x) => `${x.toFixed(3)},0.000`));
    for (const wall of walls) {
      const span = profileHoleSpan(wall, body.faces, body.edges);
      if (span === null) throw new Error(`全周の穴を読めない: ${item.key} face ${wall.index}`);
      expect(span[1] - span[0]).toBeCloseTo(item.thickness, 6);
      const planes = endPlanes(body, wall);
      expect(planes).toHaveLength(2);
      for (const mating of planes) {
        const result = profileClearanceHole(PLATE, REVISIONS, { holeFeatureId: body.featureId, hole: wall, mating,
          matingRef: fingerprintRef(body, mating), bodyFaces: body.faces, bodyEdges: body.edges });
        if (typeof result === 'string' || 'code' in result) {
          throw new Error(`通し穴を読めない: ${item.key} face ${wall.index} ${JSON.stringify(result)}`);
        }
        if (result.hole.kind !== 'clearance') throw new Error('穴が通し穴になっていない');
        expect(result.hole.diameter).toBeCloseTo(2 * item.radius, 6);
        expect(result.hole.length).toBeCloseTo(item.thickness, 6);
      }
    }
  }, 300_000);
});
