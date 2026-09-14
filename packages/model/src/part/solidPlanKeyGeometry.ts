/** 解決済みの幾何情報を、形状再利用の判定に必要な値へ変換する。 */
import type { ResolvedCurve } from '../sketch/types.js';
import type { Vec3 } from '../sketch/vec3.js';
import type {
  ExtrudeEndKeyMaterial, FilletRadiusKeyMaterial, HoleEntryKeyMaterial,
  KeyCurve, KeyTransform, KeyVec3, PrimitiveShapeKeyMaterial,
  SurfaceShapeKeyMaterial, ThruSectionKeyMaterial,
} from './cacheKey.js';
import type {
  ExtrudeEndPlan, FilletRadiusPlan, HoleEntryPlan, PrimitiveShapePlan,
  RigidTransform, SurfaceShapePlan, ThruSectionPlan,
} from './resolvePart.js';
import { fingerprintKeyText } from './subShapeRef.js';

export function toKeyVec3(vector: Vec3): KeyVec3 {
  return [vector[0], vector[1], vector[2]];
}

/** 剛体変換を鍵の材料へ詰め替える(パターン、タスク16)。欄名は cacheKey.ts の KeyTransform と同じ。 */
export function toKeyTransform(transform: RigidTransform): KeyTransform {
  return {
    translation: toKeyVec3(transform.translation),
    rotationOrigin: toKeyVec3(transform.rotationOrigin),
    rotationAxis: toKeyVec3(transform.rotationAxis),
    rotationAngle: transform.rotationAngle,
  };
}

/**
 * 解決済みの曲線を鍵の材料へ詰め替える(cacheKey.ts の KeyCurve)。
 * featureId は形に関わらないので落とす。詰め替えを省いて渡さないのは、
 * 材料の型が「鍵に混ぜる欄」の定義そのものであり、偶然の構造の一致に頼らないため。
 */
export function toKeyCurve(curve: ResolvedCurve): KeyCurve {
  switch (curve.kind) {
    case 'segment':
      return { kind: 'segment', from: toKeyVec3(curve.from), to: toKeyVec3(curve.to) };
    case 'arc':
      return {
        kind: 'arc',
        center: toKeyVec3(curve.center),
        normal: toKeyVec3(curve.normal),
        xAxis: toKeyVec3(curve.xAxis),
        radius: curve.radius,
        startAngle: curve.startAngle,
        endAngle: curve.endAngle,
      };
    case 'ellipse':
      return {
        kind: 'ellipse',
        center: toKeyVec3(curve.center),
        normal: toKeyVec3(curve.normal),
        majorAxis: toKeyVec3(curve.majorAxis),
        majorRadius: curve.majorRadius,
        minorRadius: curve.minorRadius,
        startAngle: curve.startAngle,
        endAngle: curve.endAngle,
      };
    case 'spline':
      return {
        kind: 'spline',
        mode: curve.mode,
        points: curve.points.map((point) => toKeyVec3(point)),
        closed: curve.closed,
      };
  }
}

/**
 * 基本形状の寸法を鍵の材料へ詰め替える(cacheKey.ts の `PrimitiveShapeKeyMaterial`)。
 * 欄名も形も同じだが、`toKeyCurve` と同じ理由で偶然の構造の一致に頼らず種類ごとに写す。
 */
export function toKeyPrimitiveShape(shape: PrimitiveShapePlan): PrimitiveShapeKeyMaterial {
  switch (shape.kind) {
    case 'sphere':
      return { kind: 'sphere', radius: shape.radius };
    case 'box':
      return { kind: 'box', sizeX: shape.sizeX, sizeY: shape.sizeY, sizeZ: shape.sizeZ };
    case 'cylinder':
      return { kind: 'cylinder', radius: shape.radius, height: shape.height };
    case 'cone':
      return {
        kind: 'cone',
        bottomRadius: shape.bottomRadius,
        topRadius: shape.topRadius,
        height: shape.height,
      };
    case 'torus':
      return { kind: 'torus', majorRadius: shape.majorRadius, minorRadius: shape.minorRadius };
  }
}

/**
 * 罫線面・ロフトの断面を鍵の材料へ詰め替える(cacheKey.ts の `ThruSectionKeyMaterial`)。
 * `toKeyCurve` と同じ理由で、欄が同じでも種類ごとに写す(偶然の構造の一致に頼らない)。
 */
export function toKeyThruSection(section: ThruSectionPlan): ThruSectionKeyMaterial {
  switch (section.kind) {
    case 'curves':
      return { kind: 'curves', curves: section.curves.map(toKeyCurve) };
    case 'sphere':
      return { kind: 'sphere', center: toKeyVec3(section.center), radius: section.radius };
    case 'faceQuery':
      // 上流の鍵と面の指紋を必ず混ぜる(混ぜないと、上流を伸ばして面が動いても
      // 段の鍵が変わらず古い輪郭の形がキャッシュから返る。NFR-PF-3)。
      return {
        kind: 'faceQuery',
        targetKey: section.targetKey,
        query: fingerprintKeyText(section.query),
      };
  }
}

/**
 * 押し出しの終端を鍵の材料へ詰め替える(cacheKey.ts の `ExtrudeEndKeyMaterial`)。
 * 欄も種類も同じだが、`toKeyCurve` と同じ理由で偶然の構造の一致に頼らず種類ごとに写す。
 */
export function toKeyExtrudeEnd(end: ExtrudeEndPlan): ExtrudeEndKeyMaterial {
  switch (end.kind) {
    case 'distance':
      return { kind: 'distance', distance: end.distance };
    case 'symmetric':
      return { kind: 'symmetric', forward: end.forward, backward: end.backward };
    case 'toFace':
      return { kind: 'toFace', distance: end.distance };
    case 'toNext':
      return { kind: 'toNext' };
  }
}

/**
 * 穴の入口を鍵の材料へ詰め替える(cacheKey.ts の `HoleEntryKeyMaterial`、タスク46)。
 * 段に欄が無い(広げない)ときは `{ kind: 'plain' }` を渡す——`keyHoleEntryExtra` が
 * `plain` を鍵の文字列に出さないので、省略と「広げない」は同じ鍵になる。
 */
export function toKeyHoleEntry(entry: HoleEntryPlan | undefined): HoleEntryKeyMaterial {
  if (entry === undefined) {
    return { kind: 'plain' };
  }
  return entry.kind === 'counterbore'
    ? { kind: 'counterbore', diameter: entry.diameter, depth: entry.depth }
    : { kind: 'countersink', diameter: entry.diameter, angle: entry.angle };
}

/**
 * 丸める半径を鍵の材料へ詰め替える(cacheKey.ts の `FilletRadiusKeyMaterial`)。
 * 一定半径は数 1 つのままなので、P3 からの R 面取りの鍵は 1 文字も変わらない。
 */
export function toKeyFilletRadius(radius: FilletRadiusPlan): FilletRadiusKeyMaterial {
  return typeof radius === 'number' ? radius : { start: radius.start, end: radius.end };
}

/**
 * 曲面の作り方を鍵の材料へ詰め替える(cacheKey.ts の `SurfaceShapeKeyMaterial`)。
 * `toKeyCurve` と同じ理由で、欄が同じでも種類ごとに写す(偶然の構造の一致に頼らない)。
 */
export function toKeySurfaceShape(shape: SurfaceShapePlan): SurfaceShapeKeyMaterial {
  switch (shape.kind) {
    case 'extrude':
      return {
        kind: 'extrude',
        profile: shape.profile.map(toKeyCurve),
        direction: toKeyVec3(shape.direction),
        distance: shape.distance,
      };
    case 'revolve':
      return {
        kind: 'revolve',
        profile: shape.profile.map(toKeyCurve),
        axisOrigin: toKeyVec3(shape.axisOrigin),
        axisDirection: toKeyVec3(shape.axisDirection),
        angle: shape.angle,
      };
    case 'planar':
      return { kind: 'planar', profile: shape.profile.map(toKeyCurve) };
    case 'loft':
      return {
        kind: 'loft',
        sections: shape.sections.map((section) => section.map(toKeyCurve)),
        ruled: shape.ruled,
      };
    case 'face':
      return { kind: 'face', face: fingerprintKeyText(shape.face) };
    case 'offset':
      return {
        kind: 'offset',
        face: fingerprintKeyText(shape.face),
        distance: shape.distance,
      };
  }
}
