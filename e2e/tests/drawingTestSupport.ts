import { expressionValueFromNumber } from '../../packages/expression/src/index.js';
import { writePcadFile } from '../../packages/io/src/index.js';
import { appendSolid, createEmptyPartDocument, createPrimitiveFeature, DEFAULT_WORK_PLANE_ID,
  type HoleFeature, type PartDocument } from '../../packages/model/src/index.js';

/** 履歴だけを保存する。試験中に本物のOCCTが箱とφ4の貫通穴を再計算する。 */
export function offsetHolePartFile(): Uint8Array {
  const empty = { ...createEmptyPartDocument(), name: '偏心穴つき箱' };
  const sketch = empty.sketches[0]; if (sketch === undefined) throw new Error('初期スケッチがありません');
  const number = expressionValueFromNumber;
  const withPoint: PartDocument = { ...empty, sketches: [{ ...sketch, features: [{
    id: 'point-1', kind: 'point', name: '穴の中心', planeId: DEFAULT_WORK_PLANE_ID,
    at: { mode: 'absolute', x: number(3), y: number(4), z: number(0) },
  }] }] };
  const box = createPrimitiveFeature(withPoint, 'box');
  const part = appendSolid(withPoint, box);
  const hole: HoleFeature = { id: 'hole-1', kind: 'hole', name: '貫通穴', suppressed: false,
    targetFeatureId: box.id, face: { bodyFeatureId: box.id, index: 5, fingerprint: {
      kind: 'face', surfaceKind: 'plane', area: 400, position: [0, 0, 10], axis: [0, 0, 1], radius: null,
    } }, centers: [{ sketchId: sketch.id, pointFeatureId: 'point-1' }],
    diameter: number(4), depth: { kind: 'through' }, tiltAngle: number(0), tiltAzimuth: number(0) };
  return writePcadFile(appendSolid(part, hole), { savedAt: '2026-09-10T00:00:00.000Z' });
}

/** 長さというパラメータをX寸法に使う箱。形状・値の注入は行わない。 */
export function configurableBoxPartFile(): Uint8Array {
  const number = expressionValueFromNumber;
  const empty: PartDocument = { ...createEmptyPartDocument(), name: '構成の箱',
    parameters: [{ name: '長さ', value: number(20), unit: 'mm', description: '' }],
    configurations: [{ id: 'configuration-1', name: '既定', values: { 長さ: '20' } }],
    activeConfigurationId: 'configuration-1' };
  const primitive = createPrimitiveFeature(empty, 'box');
  if (primitive.shape.kind !== 'box') throw new Error('箱ではありません');
  const box = { ...primitive, shape: { ...primitive.shape, sizeX: { ...number(20), source: '長さ' } } };
  return writePcadFile(appendSolid(empty, box), { savedAt: '2026-09-10T00:00:00.000Z' });
}
