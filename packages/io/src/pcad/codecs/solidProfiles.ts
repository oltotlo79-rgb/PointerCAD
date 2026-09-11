/** 部品 JSON: 断面からの加工。documentJson.ts への逆向きの依存を持たない。 */

import {
  type Checked,
  checkRecord,
  fieldProblem,
  joinPath,
  readBoolean,
  readExpression,
  readLiteral,
  readNumber,
  readString,
  readValue,
} from '../guards.js';
import {
  readList,
  serializeExpression,
} from './fields.js';
import {
  readCurveRef,
  readFaceRef,
  readSubShapeRefField,
  serializeCurveRef,
  serializeFaceRef,
  serializeSubShapeRef,
} from './shapeReferences.js';
import {
  type SolidFeatureBase,
} from './solidBase.js';
import {
  DEFAULT_RULED_SPHERE_SEGMENTS,
  type RibSide,
  RULED_SPHERE_SEGMENT_CHOICES,
  type RuledSection,
  type RuledSphereSegments,
  type SolidFeature,
} from '@pointercad/model';

/** リブの厚みを付ける側(FR-420)。 */
const RIB_SIDES: readonly RibSide[] = ['both', 'positive', 'negative'];

/** 罫線面・ロフトの断面の 3 通り(P5 §2.9.1)。知らない `kind` は `readLiteral` が断る。 */
const RULED_SECTION_KINDS: readonly RuledSection['kind'][] = ['sketchFace', 'sketchCurves', 'solidFace', 'sphere'];

/**
 * 罫線面・ロフトの断面 1 つ(FR-430、FR-410、P5 計画書 §2.9.1、タスク25)。
 * 参照は id と指紋のまま保存し、輪郭の座標は保存しない(導出物、rules/04)。
 */
function serializeRuledSection(section: RuledSection): RuledSection {
  switch (section.kind) {
    case 'sketchCurves':
      return { kind: 'sketchCurves', ref: serializeCurveRef(section.ref) };
    case 'sketchFace':
      return { kind: 'sketchFace', ref: serializeFaceRef(section.ref) };
    case 'solidFace':
      return { kind: 'solidFace', ref: serializeSubShapeRef(section.ref) };
    case 'sphere':
      return { kind: 'sphere', sphereFeatureId: section.sphereFeatureId };
  }
}

/** 罫線面・ロフトの断面 1 つ(P5 §2.9.1、タスク25)。 */
function readRuledSectionItem(value: unknown, path: string): Checked<RuledSection> {
  const record = checkRecord(value, path);
  if (!record.ok) {
    return record;
  }
  const kind = readLiteral(record.value, 'kind', path, RULED_SECTION_KINDS);
  if (!kind.ok) {
    return kind;
  }
  switch (kind.value) {
    case 'sketchCurves': {
      const ref = readCurveRef(record.value, 'ref', path);
      return ref.ok ? { ok: true, value: { kind: 'sketchCurves', ref: ref.value } } : ref;
    }
    case 'sketchFace': {
      const ref = readFaceRef(record.value, 'ref', path);
      if (!ref.ok) {
        return ref;
      }
      return { ok: true, value: { kind: 'sketchFace', ref: ref.value } };
    }
    case 'solidFace': {
      const ref = readSubShapeRefField(record.value, 'ref', path);
      if (!ref.ok) {
        return ref;
      }
      return { ok: true, value: { kind: 'solidFace', ref: ref.value } };
    }
    case 'sphere': {
      const sphereFeatureId = readString(record.value, 'sphereFeatureId', path);
      if (!sphereFeatureId.ok) {
        return sphereFeatureId;
      }
      return { ok: true, value: { kind: 'sphere', sphereFeatureId: sphereFeatureId.value } };
    }
  }
}

function readRuledSectionField(
  source: Record<string, unknown>,
  key: string,
  parentPath: string,
): Checked<RuledSection> {
  const found = readValue(source, key, parentPath);
  if (!found.ok) {
    return found;
  }
  return readRuledSectionItem(found.value, joinPath(parentPath, key));
}

/**
 * 球へつなぐときの近似の点の数(§0.a-0.74)。
 *
 * **欄が無い古いファイルは既定の 24 として読む**(この欄は P5 の途中で足したもので、
 * 無いことが「壊れている」を意味しないため)。24 / 48 / 72 以外の数は
 * その欄の型が違うとして断る(新しい値の意味を推測しない)。
 */
function readRuledSphereSegments(
  record: Record<string, unknown>,
  path: string,
): Checked<RuledSphereSegments> {
  if (!('sphereSegments' in record)) {
    return { ok: true, value: DEFAULT_RULED_SPHERE_SEGMENTS };
  }
  const found = readNumber(record, 'sphereSegments', path);
  if (!found.ok) {
    return found;
  }
  for (const candidate of RULED_SPHERE_SEGMENT_CHOICES) {
    if (candidate === found.value) {
      return { ok: true, value: candidate };
    }
  }
  return fieldProblem(joinPath(path, 'sphereSegments'), 'type');
}

export function readRuledFeature(
  record: Record<string, unknown>,
  path: string,
  base: SolidFeatureBase,
): Checked<SolidFeature> {
  const first = readRuledSectionField(record, 'first', path);
  if (!first.ok) {
    return first;
  }
  const second = readRuledSectionField(record, 'second', path);
  if (!second.ok) {
    return second;
  }
  const twist = readExpression(record, 'twist', path);
  if (!twist.ok) {
    return twist;
  }
  const sphereSegments = readRuledSphereSegments(record, path);
  if (!sphereSegments.ok) {
    return sphereSegments;
  }
  return {
    ok: true,
    value: {
      ...base,
      kind: 'ruled',
      first: first.value,
      second: second.value,
      twist: twist.value,
      sphereSegments: sphereSegments.value,
    },
  };
}

export function readLoftFeature(
  record: Record<string, unknown>,
  path: string,
  base: SolidFeatureBase,
): Checked<SolidFeature> {
  const sections = readList(record, 'sections', path, readRuledSectionItem);
  if (!sections.ok) {
    return sections;
  }
  const twist = readExpression(record, 'twist', path);
  if (!twist.ok) {
    return twist;
  }
  // 旧版の省略は12→13の移行でfalseに補う。現行版の欠落/不正値は黙って補わない。
  const smooth = readBoolean(record, 'smooth', path);
  if (!smooth.ok) return smooth;
  return {
    ok: true,
    value: { ...base, kind: 'loft', smooth: smooth.value, sections: sections.value, twist: twist.value },
  };
}

/** スイープ(FR-409)を読む。断面はスケッチの面、経路はスケッチの曲線の並び。 */
export function readSweepFeature(
  record: Record<string, unknown>,
  path: string,
  base: SolidFeatureBase,
): Checked<SolidFeature> {
  const profile = readFaceRef(record, 'profile', path);
  if (!profile.ok) {
    return profile;
  }
  const sweepPath = readCurveRef(record, 'path', path);
  if (!sweepPath.ok) {
    return sweepPath;
  }
  const guide = 'guide' in record ? readCurveRef(record, 'guide', path) : undefined;
  if (guide !== undefined && !guide.ok) return guide;
  const frenet = readBoolean(record, 'frenet', path);
  if (!frenet.ok) {
    return frenet;
  }
  return {
    ok: true,
    value: {
      ...base,
      kind: 'sweep',
      profile: profile.value,
      path: sweepPath.value,
      ...(guide === undefined ? {} : { guide: guide.value }),
      frenet: frenet.value,
    },
  };
}

/** リブ(FR-420)を読む。輪郭は開いていてよいのでスケッチの曲線の並び。 */
export function readRibFeature(
  record: Record<string, unknown>,
  path: string,
  base: SolidFeatureBase,
): Checked<SolidFeature> {
  const targetFeatureId = readString(record, 'targetFeatureId', path);
  if (!targetFeatureId.ok) {
    return targetFeatureId;
  }
  const profile = readCurveRef(record, 'profile', path);
  if (!profile.ok) {
    return profile;
  }
  const thickness = readExpression(record, 'thickness', path);
  if (!thickness.ok) {
    return thickness;
  }
  const side = readLiteral(record, 'side', path, RIB_SIDES);
  if (!side.ok) {
    return side;
  }
  const extendToBody = readBoolean(record, 'extendToBody', path);
  if (!extendToBody.ok) {
    return extendToBody;
  }
  return {
    ok: true,
    value: {
      ...base,
      kind: 'rib',
      targetFeatureId: targetFeatureId.value,
      profile: profile.value,
      thickness: thickness.value,
      side: side.value,
      extendToBody: extendToBody.value,
    },
  };
}

/** エンボス(FR-421)を読む。相手の面は指紋、輪郭はスケッチの面。 */
export function readEmbossFeature(
  record: Record<string, unknown>,
  path: string,
  base: SolidFeatureBase,
): Checked<SolidFeature> {
  const targetFeatureId = readString(record, 'targetFeatureId', path);
  if (!targetFeatureId.ok) {
    return targetFeatureId;
  }
  const face = readSubShapeRefField(record, 'face', path);
  if (!face.ok) {
    return face;
  }
  const profile = readFaceRef(record, 'profile', path);
  if (!profile.ok) {
    return profile;
  }
  const height = readExpression(record, 'height', path);
  if (!height.ok) {
    return height;
  }
  const raised = readBoolean(record, 'raised', path);
  if (!raised.ok) {
    return raised;
  }
  return {
    ok: true,
    value: {
      ...base,
      kind: 'emboss',
      targetFeatureId: targetFeatureId.value,
      face: face.value,
      profile: profile.value,
      height: height.value,
      raised: raised.value,
    },
  };
}

/** ruled の保存欄。解決値を足さず、元の式と参照を保持する。 */
export function serializeRuledFeature(feature: Extract<SolidFeature, { readonly kind: 'ruled' }>): SolidFeature {
  // 面をつなぐ(FR-430、P5 §2.9.1、タスク25)。断面 2 つ+ねじれ+球の点の数。
  return {
    id: feature.id,
    kind: 'ruled',
    name: feature.name,
    suppressed: feature.suppressed,
    first: serializeRuledSection(feature.first),
    second: serializeRuledSection(feature.second),
    twist: serializeExpression(feature.twist),
    sphereSegments: feature.sphereSegments,
  };
}

/** loft の保存欄。解決値を足さず、元の式と参照を保持する。 */
export function serializeLoftFeature(feature: Extract<SolidFeature, { readonly kind: 'loft' }>): SolidFeature {
  // ロフト(FR-410)。断面は 2 つ以上で、球を置けないので点の数の欄は持たない。
  return {
    id: feature.id,
    kind: 'loft', smooth: feature.smooth,
    name: feature.name,
    suppressed: feature.suppressed,
    sections: feature.sections.map(serializeRuledSection),
    twist: serializeExpression(feature.twist),
  };
}

/** sweep の保存欄。解決値を足さず、元の式と参照を保持する。 */
export function serializeSweepFeature(feature: Extract<SolidFeature, { readonly kind: 'sweep' }>): SolidFeature {
  return {
    id: feature.id,
    kind: 'sweep',
    name: feature.name,
    suppressed: feature.suppressed,
    profile: serializeFaceRef(feature.profile),
    path: serializeCurveRef(feature.path),
    ...(feature.guide === undefined ? {} : { guide: serializeCurveRef(feature.guide) }),
    frenet: feature.frenet,
  };
}

/** rib の保存欄。解決値を足さず、元の式と参照を保持する。 */
export function serializeRibFeature(feature: Extract<SolidFeature, { readonly kind: 'rib' }>): SolidFeature {
  return {
    id: feature.id,
    kind: 'rib',
    name: feature.name,
    suppressed: feature.suppressed,
    targetFeatureId: feature.targetFeatureId,
    profile: serializeCurveRef(feature.profile),
    thickness: serializeExpression(feature.thickness),
    side: feature.side,
    extendToBody: feature.extendToBody,
  };
}

/** emboss の保存欄。解決値を足さず、元の式と参照を保持する。 */
export function serializeEmbossFeature(feature: Extract<SolidFeature, { readonly kind: 'emboss' }>): SolidFeature {
  return {
    id: feature.id,
    kind: 'emboss',
    name: feature.name,
    suppressed: feature.suppressed,
    targetFeatureId: feature.targetFeatureId,
    face: serializeSubShapeRef(feature.face),
    profile: serializeFaceRef(feature.profile),
    height: serializeExpression(feature.height),
    raised: feature.raised,
  };
}
