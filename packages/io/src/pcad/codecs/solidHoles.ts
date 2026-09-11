/** 部品 JSON: 穴とねじ。documentJson.ts への逆向きの依存を持たない。 */

import {
  type Checked,
  checkRecord,
  joinPath,
  readBoolean,
  readExpression,
  readLiteral,
  readRecord,
  readString,
  readValue,
} from '../guards.js';
import {
  readList,
  serializeExpression,
} from './fields.js';
import {
  readPointRef,
  readSubShapeRefField,
  serializePointRef,
  serializeSubShapeRef,
} from './shapeReferences.js';
import {
  type SolidFeatureBase,
} from './solidBase.js';
import {
  type HoleDepth,
  type HoleEntry,
  type SolidFeature,
  type ThreadRepresentation,
  type ThreadSeries,
} from '@pointercad/model';

/** 穴の入口の3通り(ざぐり・皿もみ。FR-422、§0.a-0.39)。 */
const HOLE_ENTRY_KINDS: readonly HoleEntry['kind'][] = ['plain', 'counterbore', 'countersink'];

/** 外ねじを切り始める端(FR-423)。 */
const THREAD_SHAFT_ENDS: readonly ('first' | 'last')[] = ['first', 'last'];

const HOLE_DEPTH_KINDS: readonly HoleDepth['kind'][] = ['through', 'blind'];

const THREAD_SERIES: readonly ThreadSeries[] = ['coarse', 'fine'];

const THREAD_REPRESENTATIONS: readonly ThreadRepresentation[] = ['simplified', 'modeled'];

function serializeHoleDepth(depth: HoleDepth): HoleDepth {
  switch (depth.kind) {
    case 'through':
      return { kind: 'through' };
    case 'blind':
      return { kind: 'blind', depth: serializeExpression(depth.depth) };
  }
}

/** 穴の入口(ざぐり・皿もみ。FR-422、P5 タスク43)。省略でないときだけ呼ぶ。 */
function serializeHoleEntry(entry: HoleEntry): HoleEntry {
  switch (entry.kind) {
    case 'plain':
      return { kind: 'plain' };
    case 'counterbore':
      return {
        kind: 'counterbore',
        diameter: serializeExpression(entry.diameter),
        depth: serializeExpression(entry.depth),
      };
    case 'countersink':
      return {
        kind: 'countersink',
        diameter: serializeExpression(entry.diameter),
        angle: serializeExpression(entry.angle),
      };
  }
}

/** 穴の深さ(貫通/止まり、§0.a-0.12)を読む。 */
function readHoleDepth(value: unknown, path: string): Checked<HoleDepth> {
  const record = checkRecord(value, path);
  if (!record.ok) {
    return record;
  }
  const kind = readLiteral(record.value, 'kind', path, HOLE_DEPTH_KINDS);
  if (!kind.ok) {
    return kind;
  }
  switch (kind.value) {
    case 'through':
      return { ok: true, value: { kind: 'through' } };
    case 'blind': {
      const depth = readExpression(record.value, 'depth', path);
      if (!depth.ok) {
        return depth;
      }
      return { ok: true, value: { kind: 'blind', depth: depth.value } };
    }
  }
}

function readHoleDepthField(
  source: Record<string, unknown>,
  key: string,
  parentPath: string,
): Checked<HoleDepth> {
  const found = readValue(source, key, parentPath);
  if (!found.ok) {
    return found;
  }
  return readHoleDepth(found.value, joinPath(parentPath, key));
}

/**
 * 穴の入口(ざぐり・皿もみ。FR-422、P5 タスク43)を読む。
 *
 * **欄が無い古いファイルは `undefined` のまま返す**(`RuledSphereSegments` は既定値を
 * 埋めたが、こちらは型が省略可能なので既定を書き込まない。読む側は model の
 * `holeEntryOf` を通せば `plain` が返る)。知らない `kind` は `readLiteral` が断る。
 */
function readHoleEntry(
  record: Record<string, unknown>,
  path: string,
): Checked<HoleEntry | undefined> {
  if (!('entry' in record)) {
    return { ok: true, value: undefined };
  }
  const found = readRecord(record, 'entry', path);
  if (!found.ok) {
    return found;
  }
  const entryPath = joinPath(path, 'entry');
  const kind = readLiteral(found.value, 'kind', entryPath, HOLE_ENTRY_KINDS);
  if (!kind.ok) {
    return kind;
  }
  switch (kind.value) {
    case 'plain':
      return { ok: true, value: { kind: 'plain' } };
    case 'counterbore': {
      const diameter = readExpression(found.value, 'diameter', entryPath);
      if (!diameter.ok) {
        return diameter;
      }
      const depth = readExpression(found.value, 'depth', entryPath);
      if (!depth.ok) {
        return depth;
      }
      return {
        ok: true,
        value: { kind: 'counterbore', diameter: diameter.value, depth: depth.value },
      };
    }
    case 'countersink': {
      const diameter = readExpression(found.value, 'diameter', entryPath);
      if (!diameter.ok) {
        return diameter;
      }
      const angle = readExpression(found.value, 'angle', entryPath);
      if (!angle.ok) {
        return angle;
      }
      return {
        ok: true,
        value: { kind: 'countersink', diameter: diameter.value, angle: angle.value },
      };
    }
  }
}

/** 穴(FR-405、§0.a-0.9〜0.a-0.12)を読む。中心は1つ以上(点列は展開済みの一覧として保存)。 */
export function readHoleFeature(
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
  const centers = readList(record, 'centers', path, readPointRef);
  if (!centers.ok) {
    return centers;
  }
  const diameter = readExpression(record, 'diameter', path);
  if (!diameter.ok) {
    return diameter;
  }
  const depth = readHoleDepthField(record, 'depth', path);
  if (!depth.ok) {
    return depth;
  }
  // 入口(ざぐり・皿もみ。FR-422、P5 タスク43)。欄が無ければ省略のまま(= 広げない)。
  const entry = readHoleEntry(record, path);
  if (!entry.ok) {
    return entry;
  }
  const tiltAngle = readExpression(record, 'tiltAngle', path);
  if (!tiltAngle.ok) {
    return tiltAngle;
  }
  const tiltAzimuth = readExpression(record, 'tiltAzimuth', path);
  if (!tiltAzimuth.ok) {
    return tiltAzimuth;
  }
  return {
    ok: true,
    value: {
      ...base,
      kind: 'hole',
      targetFeatureId: targetFeatureId.value,
      face: face.value,
      centers: centers.value,
      diameter: diameter.value,
      depth: depth.value,
      // 押し出しの終端と同じ理由で、省略されていた入口は欄ごと省略のまま返す。
      ...(entry.value === undefined ? {} : { entry: entry.value }),
      tiltAngle: tiltAngle.value,
      tiltAzimuth: tiltAzimuth.value,
    },
  };
}

/** ねじ穴(FR-406、§0.a-0.13〜0.a-0.16)を読む。呼び・系列は一覧と突き合わせて絞る。 */
export function readThreadHoleFeature(
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
  const centers = readList(record, 'centers', path, readPointRef);
  if (!centers.ok) {
    return centers;
  }
  const designation = readString(record, 'designation', path);
  if (!designation.ok) {
    return designation;
  }
  const series = readLiteral(record, 'series', path, THREAD_SERIES);
  if (!series.ok) {
    return series;
  }
  const pitch = readExpression(record, 'pitch', path);
  if (!pitch.ok) {
    return pitch;
  }
  const drillDiameter = readExpression(record, 'drillDiameter', path);
  if (!drillDiameter.ok) {
    return drillDiameter;
  }
  const depth = readHoleDepthField(record, 'depth', path);
  if (!depth.ok) {
    return depth;
  }
  // 入口(ざぐり・皿もみ。FR-422、P5 タスク43)。穴とまったく同じ扱い。
  const entry = readHoleEntry(record, path);
  if (!entry.ok) {
    return entry;
  }
  const threadLength = readExpression(record, 'threadLength', path);
  if (!threadLength.ok) {
    return threadLength;
  }
  const representation = readLiteral(record, 'representation', path, THREAD_REPRESENTATIONS);
  if (!representation.ok) {
    return representation;
  }
  const tiltAngle = readExpression(record, 'tiltAngle', path);
  if (!tiltAngle.ok) {
    return tiltAngle;
  }
  const tiltAzimuth = readExpression(record, 'tiltAzimuth', path);
  if (!tiltAzimuth.ok) {
    return tiltAzimuth;
  }
  return {
    ok: true,
    value: {
      ...base,
      kind: 'threadHole',
      targetFeatureId: targetFeatureId.value,
      face: face.value,
      centers: centers.value,
      designation: designation.value,
      series: series.value,
      pitch: pitch.value,
      drillDiameter: drillDiameter.value,
      depth: depth.value,
      ...(entry.value === undefined ? {} : { entry: entry.value }),
      threadLength: threadLength.value,
      representation: representation.value,
      tiltAngle: tiltAngle.value,
      tiltAzimuth: tiltAzimuth.value,
    },
  };
}

/** 外ねじ(FR-423)を読む。呼びはねじ穴と同じ規格表の鍵で、面は円柱面。 */
export function readThreadShaftFeature(
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
  const nominal = readString(record, 'nominal', path);
  if (!nominal.ok) {
    return nominal;
  }
  const series = readLiteral(record, 'series', path, THREAD_SERIES);
  if (!series.ok) {
    return series;
  }
  const pitch = readExpression(record, 'pitch', path);
  if (!pitch.ok) {
    return pitch;
  }
  const length = readExpression(record, 'length', path);
  if (!length.ok) {
    return length;
  }
  const fromEnd = readLiteral(record, 'fromEnd', path, THREAD_SHAFT_ENDS);
  if (!fromEnd.ok) {
    return fromEnd;
  }
  const modeled = readBoolean(record, 'modeled', path);
  if (!modeled.ok) {
    return modeled;
  }
  return {
    ok: true,
    value: {
      ...base,
      kind: 'threadShaft',
      targetFeatureId: targetFeatureId.value,
      face: face.value,
      nominal: nominal.value,
      series: series.value,
      pitch: pitch.value,
      length: length.value,
      fromEnd: fromEnd.value,
      modeled: modeled.value,
    },
  };
}

/** hole の保存欄。解決値を足さず、元の式と参照を保持する。 */
export function serializeHoleFeature(feature: Extract<SolidFeature, { readonly kind: 'hole' }>): SolidFeature {
  return {
    id: feature.id,
    kind: 'hole',
    name: feature.name,
    suppressed: feature.suppressed,
    targetFeatureId: feature.targetFeatureId,
    face: serializeSubShapeRef(feature.face),
    centers: feature.centers.map(serializePointRef),
    diameter: serializeExpression(feature.diameter),
    depth: serializeHoleDepth(feature.depth),
    // 入口(ざぐり・皿もみ。FR-422、P5 タスク43)。省略は欄ごと省略のまま。
    ...(feature.entry === undefined ? {} : { entry: serializeHoleEntry(feature.entry) }),
    tiltAngle: serializeExpression(feature.tiltAngle),
    tiltAzimuth: serializeExpression(feature.tiltAzimuth),
  };
}

/** threadHole の保存欄。解決値を足さず、元の式と参照を保持する。 */
export function serializeThreadHoleFeature(feature: Extract<SolidFeature, { readonly kind: 'threadHole' }>): SolidFeature {
  return {
    id: feature.id,
    kind: 'threadHole',
    name: feature.name,
    suppressed: feature.suppressed,
    targetFeatureId: feature.targetFeatureId,
    face: serializeSubShapeRef(feature.face),
    centers: feature.centers.map(serializePointRef),
    designation: feature.designation,
    series: feature.series,
    pitch: serializeExpression(feature.pitch),
    drillDiameter: serializeExpression(feature.drillDiameter),
    depth: serializeHoleDepth(feature.depth),
    ...(feature.entry === undefined ? {} : { entry: serializeHoleEntry(feature.entry) }),
    threadLength: serializeExpression(feature.threadLength),
    representation: feature.representation,
    tiltAngle: serializeExpression(feature.tiltAngle),
    tiltAzimuth: serializeExpression(feature.tiltAzimuth),
  };
}

/** threadShaft の保存欄。解決値を足さず、元の式と参照を保持する。 */
export function serializeThreadShaftFeature(feature: Extract<SolidFeature, { readonly kind: 'threadShaft' }>): SolidFeature {
  return {
    id: feature.id,
    kind: 'threadShaft',
    name: feature.name,
    suppressed: feature.suppressed,
    targetFeatureId: feature.targetFeatureId,
    face: serializeSubShapeRef(feature.face),
    nominal: feature.nominal,
    series: feature.series,
    pitch: serializeExpression(feature.pitch),
    length: serializeExpression(feature.length),
    fromEnd: feature.fromEnd,
    modeled: feature.modeled,
  };
}
