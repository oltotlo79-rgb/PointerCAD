/** A subshape fingerprint crosses the kernel boundary without its model owner ID. */
import type { SubShapeQuery } from '@pointercad/kernel';
import type { SubShapeQueryPlan } from '../part/resolvePart.js';


/**
 * 部分形状の指紋を kernel の言葉(`SubShapeQuery`)へ詰め替える(§2.4.2、§2.8、タスク17 手順3)。
 *
 * model の `SubShapeQueryPlan`(= `SubShapeRef`)は「そのボディを作ったフィーチャーの id」
 * (`bodyFeatureId`)を持つが、カーネルは段の対象(targetKey で指したボディ)の中だけを
 * 探すのでその id は要らない。`fingerprint` に包まれた欄をカーネルの平らな形へ展開する。
 * `as` は使わず、種類ごとに手で組む(fingerprint.kind で分岐し、各節を return で閉じる)。
 */
export function toSubShapeQuery(reference: SubShapeQueryPlan): SubShapeQuery {
  const { index, fingerprint } = reference;
  switch (fingerprint.kind) {
    case 'face':
      return {
        kind: 'face',
        index,
        surfaceKind: fingerprint.surfaceKind,
        area: fingerprint.area,
        position: fingerprint.position,
        axis: fingerprint.axis,
        radius: fingerprint.radius,
      };
    case 'edge':
      return {
        kind: 'edge',
        index,
        curveKind: fingerprint.curveKind,
        length: fingerprint.length,
        position: fingerprint.position,
        axis: fingerprint.axis,
        radius: fingerprint.radius,
      };
    case 'vertex':
      return { kind: 'vertex', index, position: fingerprint.position };
  }
}
