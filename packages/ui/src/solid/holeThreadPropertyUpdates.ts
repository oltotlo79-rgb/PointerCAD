/** 穴・内外ねじの寸法と選択肢を、元の式を保持して書き戻す。 */
import { expressionValueFromNumber, type ExpressionValue } from '@pointercad/expression';
import {
  DEFAULT_COUNTERBORE_DEPTH_MM,
  DEFAULT_COUNTERBORE_DIAMETER_MM,
  DEFAULT_COUNTERSINK_ANGLE_DEGREES,
  DEFAULT_COUNTERSINK_DIAMETER_MM,
  DEFAULT_HOLE_DEPTH_MM,
  findMetricThread,
  holeEntryOf,
  metricThreadPitch,
  threadMinorDiameter,
  type HoleDepth,
  type HoleEntry,
  type HoleFeature,
  type MetricThreadSize,
  type SolidFeature,
  type ThreadHoleFeature,
  type ThreadRepresentation,
  type ThreadSeries,
  type ThreadShaftFeature,
} from '@pointercad/model';
import type { SolidFieldKey } from './solidPropertyContracts.js';

/**
 * 入口(ざぐり・皿もみ、FR-422)の欄を書き戻す。いまの入口の形に合わない欄が来たら null を
 * 返し、呼び出し側は同じフィーチャーをそのまま返す。穴とねじ穴で同じ処理を 2 度書かない。
 */
function setHoleEntryField(
  entry: HoleEntry,
  key: SolidFieldKey,
  value: ExpressionValue,
): HoleEntry | null {
  if (entry.kind === 'counterbore' && key === 'counterboreDiameter') {
    return { ...entry, diameter: value };
  }
  if (entry.kind === 'counterbore' && key === 'counterboreDepth') {
    return { ...entry, depth: value };
  }
  if (entry.kind === 'countersink' && key === 'countersinkDiameter') {
    return { ...entry, diameter: value };
  }
  if (entry.kind === 'countersink' && key === 'countersinkAngle') {
    return { ...entry, angle: value };
  }
  return null;
}

export function setHoleField(feature: HoleFeature, key: SolidFieldKey, value: ExpressionValue): SolidFeature {
  switch (key) {
    case 'diameter':
      return { ...feature, diameter: value };
    case 'depth':
      return feature.depth.kind === 'blind'
        ? { ...feature, depth: { kind: 'blind', depth: value } }
        : feature;
    case 'tiltAngle':
      return { ...feature, tiltAngle: value };
    case 'tiltAzimuth':
      return { ...feature, tiltAzimuth: value };
    default: {
      const entry = setHoleEntryField(holeEntryOf(feature), key, value);
      return entry === null ? feature : { ...feature, entry };
    }
  }
}

export function setThreadHoleField(
  feature: ThreadHoleFeature,
  key: SolidFieldKey,
  value: ExpressionValue,
): SolidFeature {
  switch (key) {
    case 'pitch':
      return { ...feature, pitch: value };
    case 'drillDiameter':
      return { ...feature, drillDiameter: value };
    case 'threadLength':
      return { ...feature, threadLength: value };
    case 'depth':
      return feature.depth.kind === 'blind'
        ? { ...feature, depth: { kind: 'blind', depth: value } }
        : feature;
    case 'tiltAngle':
      return { ...feature, tiltAngle: value };
    case 'tiltAzimuth':
      return { ...feature, tiltAzimuth: value };
    default: {
      const entry = setHoleEntryField(holeEntryOf(feature), key, value);
      return entry === null ? feature : { ...feature, entry };
    }
  }
}

/**
 * 深さの種類を切り替える(貫通 ↔ 止まり)。止まりへ切り替えたときの既定は
 * `DEFAULT_HOLE_DEPTH_MM`(前に止まりで打っていた値は引き継がない。常に既定へ戻す)。
 * 穴・ねじ穴以外は同じものを返す。
 */
export function setSolidDepthKind(feature: SolidFeature, kind: 'through' | 'blind'): SolidFeature {
  if (feature.kind !== 'hole' && feature.kind !== 'threadHole') {
    return feature;
  }
  if (feature.depth.kind === kind) {
    return feature;
  }
  const depth: HoleDepth =
    kind === 'through'
      ? { kind: 'through' }
      : { kind: 'blind', depth: expressionValueFromNumber(DEFAULT_HOLE_DEPTH_MM) };
  return { ...feature, depth };
}

/** 呼びからねじの寸法を引き、いまの系列でピッチ・下穴径を組み立て直す(FR-406)。 */
function applyThreadSize(
  feature: ThreadHoleFeature,
  size: MetricThreadSize,
  series: ThreadSeries,
): ThreadHoleFeature {
  const pitch = metricThreadPitch(size, series);
  return {
    ...feature,
    designation: size.designation,
    series,
    pitch: expressionValueFromNumber(pitch),
    drillDiameter: expressionValueFromNumber(threadMinorDiameter(size.diameter, pitch)),
  };
}

/**
 * ねじの呼びを変える。ピッチ・下穴径も規格表から一緒に変わる(FR-406)。
 * 利用者が個別に上書きしていても、呼びを変え直すとその上書きは失われる(この決めは
 * ヘルプ `thread.md`(タスク28)へ書く)。呼びが見つからない・ねじ穴以外なら同じものを返す。
 */
export function setThreadDesignation(feature: SolidFeature, designation: string): SolidFeature {
  if (feature.kind !== 'threadHole') {
    return feature;
  }
  const size = findMetricThread(designation);
  return size === undefined ? feature : applyThreadSize(feature, size, feature.series);
}

/** ねじの種類(並目/細目)を変える。ピッチ・下穴径も一緒に変わる(FR-406)。 */
export function setThreadSeries(feature: SolidFeature, series: ThreadSeries): SolidFeature {
  if (feature.kind !== 'threadHole') {
    return feature;
  }
  const size = findMetricThread(feature.designation);
  return size === undefined ? feature : applyThreadSize(feature, size, series);
}

/** ねじの見せ方(簡略/実際のねじ山)を変える。 */
export function setThreadRepresentation(
  feature: SolidFeature,
  representation: ThreadRepresentation,
): SolidFeature {
  if (feature.kind !== 'threadHole' || feature.representation === representation) {
    return feature;
  }
  return { ...feature, representation };
}

/**
 * 穴・ねじ穴の入口の形を切り替える(FR-422)。切り替えたときの欄は**既定へ戻す**
 * (前に入れていた値は引き継がない。深さの種類の切り替えとまったく同じ決め)。
 */
export function setHoleEntryKind(feature: SolidFeature, kind: HoleEntry['kind']): SolidFeature {
  if (feature.kind !== 'hole' && feature.kind !== 'threadHole') {
    return feature;
  }
  if (holeEntryOf(feature).kind === kind) {
    return feature;
  }
  const entry: HoleEntry =
    kind === 'plain'
      ? { kind: 'plain' }
      : kind === 'counterbore'
        ? {
            kind: 'counterbore',
            diameter: expressionValueFromNumber(DEFAULT_COUNTERBORE_DIAMETER_MM),
            depth: expressionValueFromNumber(DEFAULT_COUNTERBORE_DEPTH_MM),
          }
        : {
            kind: 'countersink',
            diameter: expressionValueFromNumber(DEFAULT_COUNTERSINK_DIAMETER_MM),
            angle: expressionValueFromNumber(DEFAULT_COUNTERSINK_ANGLE_DEGREES),
          };
  return { ...feature, entry };
}

/** 外ねじの呼びを変える(FR-423)。ピッチも規格表から一緒に変わる(ねじ穴と同じ決め)。 */
export function setThreadShaftNominal(feature: SolidFeature, nominal: string): SolidFeature {
  if (feature.kind !== 'threadShaft') {
    return feature;
  }
  const size = findMetricThread(nominal);
  return size === undefined ? feature : applyThreadShaftSize(feature, size, feature.series);
}

/** 外ねじの系列(並目/細目)を変える。ピッチも一緒に変わる。 */
export function setThreadShaftSeries(feature: SolidFeature, series: ThreadSeries): SolidFeature {
  if (feature.kind !== 'threadShaft') {
    return feature;
  }
  const size = findMetricThread(feature.nominal);
  return size === undefined ? feature : applyThreadShaftSize(feature, size, series);
}

/**
 * 外ねじの呼び・系列からピッチを入れ直す(FR-406 と同じ規格表)。
 * 下穴径はめねじだけのものなので、外ねじでは触らない。
 */
function applyThreadShaftSize(
  feature: ThreadShaftFeature,
  size: MetricThreadSize,
  series: ThreadSeries,
): ThreadShaftFeature {
  return {
    ...feature,
    nominal: size.designation,
    series,
    pitch: expressionValueFromNumber(metricThreadPitch(size, series)),
  };
}

/** 外ねじを切り始める端(FR-423)。 */
export function setThreadShaftFromEnd(feature: SolidFeature, fromEnd: 'first' | 'last'): SolidFeature {
  return feature.kind === 'threadShaft' ? { ...feature, fromEnd } : feature;
}
