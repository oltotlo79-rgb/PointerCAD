import type {
  ChamferKeyMaterial, FilletKeyMaterial, HoleKeyMaterial, ThreadKeyMaterial, ThreadShaftKeyMaterial,
} from './cacheKey.js';
import type { SolidStepPlan } from './resolvePart.js';
import { toKeyFilletRadius, toKeyHoleEntry, toKeyTransform, toKeyVec3 } from './solidPlanKeyGeometry.js';
import { fingerprintKeyText } from './subShapeRef.js';

/** 穴・ねじ穴で共通の配置材料。省略された配置は鍵にも載せない。辺からの距離の辺は指紋の文字列にする(M-02)。 */
function holePlacementKeyMaterial(plan: Extract<SolidStepPlan, { readonly kind: 'hole' | 'thread' }>) {
  const planar = plan.planar;
  return {
    centers: plan.centers.map(toKeyVec3),
    ...(plan.cylindrical === undefined ? {} : { cylindrical: plan.cylindrical }),
    ...(planar === undefined ? {} : { planar: planar.kind === 'plane-face' ? planar
      : { kind: planar.kind, edge1: fingerprintKeyText(planar.edge1), edge2: fingerprintKeyText(planar.edge2), locations: planar.locations } }),
  };
}

export function holeKeyMaterial(plan: Extract<SolidStepPlan, { kind: 'hole' }>): HoleKeyMaterial {
  return {
    kind: 'hole',
    ...(plan.centerAnchors === undefined ? {} : { centerAnchors: plan.centerAnchors }),
    ...(plan.placementRoles === undefined ? {} : { placementRoles: plan.placementRoles }),
    ...(plan.pointPlacementReferences === undefined ? {} : { pointPlacementReferences: plan.pointPlacementReferences }),
    targetKey: plan.targetKey,
    face: fingerprintKeyText(plan.face),
    ...holePlacementKeyMaterial(plan),
    diameter: plan.diameter,
    depth: plan.depth,
    tiltAngle: plan.tiltAngle,
    tiltAzimuth: plan.tiltAzimuth,
    transforms: plan.transforms.map(toKeyTransform),
    // 入口の形(FR-422)。省略と「広げない」は同じ鍵になる(`toKeyHoleEntry` の注釈)。
    entry: toKeyHoleEntry(plan.entry),
  };
}

export function threadKeyMaterial(plan: Extract<SolidStepPlan, { kind: 'thread' }>): ThreadKeyMaterial {
  return {
    kind: 'thread',
    // 下穴の面の名前は形の結果(由来)に入るので鍵に混ぜる。欄が無ければ鍵の文字列は以前と同じ。
    ...(plan.centerAnchors === undefined ? {} : { centerAnchors: plan.centerAnchors }),
    ...(plan.placementRoles === undefined ? {} : { placementRoles: plan.placementRoles }),
    targetKey: plan.targetKey,
    face: fingerprintKeyText(plan.face),
    ...holePlacementKeyMaterial(plan),
    drillDiameter: plan.drillDiameter,
    // 外径とねじ部の長さは印(必ず作る)から取る。実らせんの有無で欠けることがない。
    majorDiameter: plan.mark.majorDiameter,
    pitch: plan.pitch,
    threadLength: plan.mark.length,
    depth: plan.depth,
    // 実らせんか簡略表示かで形そのものが変わるので鍵に混ぜる。
    modeled: plan.thread !== null,
    tiltAngle: plan.tiltAngle,
    tiltAzimuth: plan.tiltAzimuth,
    transforms: plan.transforms.map(toKeyTransform),
    // 入口の形(FR-422)。穴とまったく同じ扱いで、省略と「広げない」は同じ鍵になる。
    entry: toKeyHoleEntry(plan.entry),
  };
}

export function filletKeyMaterial(plan: Extract<SolidStepPlan, { kind: 'fillet' }>): FilletKeyMaterial {
  return {
    kind: 'fillet',
    targetKey: plan.targetKey,
    // 並びはすでに planFillet が通し番号の昇順に揃えてある(FilletKeyMaterial の注釈)。
    targets: plan.targets.map(fingerprintKeyText),
    radius: toKeyFilletRadius(plan.radius),
  };
}

export function threadShaftKeyMaterial(plan: Extract<SolidStepPlan, { kind: 'threadShaft' }>): ThreadShaftKeyMaterial {
  return {
    kind: 'threadShaft',
    targetKey: plan.targetKey,
    face: fingerprintKeyText(plan.face),
    majorDiameter: plan.majorDiameter,
    pitch: plan.pitch,
    length: plan.length,
    fromEnd: plan.fromEnd,
    modeled: plan.modeled,
  };
}

export function chamferKeyMaterial(plan: Extract<SolidStepPlan, { kind: 'chamfer' }>): ChamferKeyMaterial {
  const size = plan.size;
  // ChamferKeyMaterial は3通りの大きさを「距離2つ」に均して持つ(cacheKey.ts の注釈)。
  // 等距離は distance2 を使わないので 0 に揃え、距離+角度は角度(ラジアン)を distance2 に置く。
  const [distance1, distance2] =
    size.kind === 'equal'
      ? [size.distance, 0]
      : size.kind === 'twoDistances'
        ? [size.distance1, size.distance2]
        : [size.distance, size.angle];
  return {
    kind: 'chamfer',
    targetKey: plan.targetKey,
    targets: plan.targets.map(fingerprintKeyText),
    mode: size.kind,
    distance1,
    distance2,
    swapReferenceFace: plan.swapReferenceFace,
  };
}
