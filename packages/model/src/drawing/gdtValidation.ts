import type { DatumDefinition, DatumReference, DrawingDocument, GdtFrameSegment, GdtDisplayRow, GdtToken, GeometricToleranceFrame,
  MaterialRequirement, ToleranceCharacteristic, ToleranceZone } from '@pointercad/drawing';
import { collectVariableNames, evaluateExpression } from '@pointercad/expression';
import { analyzeParameters } from '../parameters/parameterTable.js';
import { parseDisplayInput } from '../units/length.js';
import { resolveDrawingDimensions, type DimensionResolveContext } from './dimensionTarget.js';
import { resolveGdtFeature, type ResolvedGdtFeature } from './gdt.js';
import { compatibleGdtSizeDimensions } from './gdtAttachment.js';

export interface GdtRule {
  readonly clause: string;
  readonly datums: 'none' | 'optional' | 'required';
  readonly maximum: boolean;
  readonly kinds: readonly ResolvedGdtFeature['kind'][];
  readonly zones: readonly ToleranceZone[];
}
/** JIS B0021:1998の18章、実体方式はB0023:1996第1部。別版のASME制限を持ち込まない。 */
export const GDT_RULES = {
  straightness: { clause: '18.1', datums: 'none', maximum: true, kinds: ['line', 'axis'], zones: ['betweenLines', 'betweenPlanes', 'cylinder'] },
  flatness: { clause: '18.2', datums: 'none', maximum: true, kinds: ['plane', 'medianPlane'], zones: ['betweenPlanes'] },
  roundness: { clause: '18.3', datums: 'none', maximum: false, kinds: ['surface', 'curve'], zones: ['concentricCircles'] },
  cylindricity: { clause: '18.4', datums: 'none', maximum: false, kinds: ['surface'], zones: ['coaxialCylinders'] },
  lineProfile: { clause: '18.5/18.7', datums: 'optional', maximum: false, kinds: ['line', 'curve'], zones: ['lineProfile'] },
  surfaceProfile: { clause: '18.6/18.8', datums: 'optional', maximum: false, kinds: ['plane', 'surface'], zones: ['surfaceProfile'] },
  parallelism: { clause: '18.9', datums: 'required', maximum: true, kinds: ['plane', 'line', 'axis', 'medianPlane'], zones: ['betweenLines', 'betweenPlanes', 'cylinder'] },
  perpendicularity: { clause: '18.10', datums: 'required', maximum: true, kinds: ['plane', 'line', 'axis', 'medianPlane'], zones: ['betweenLines', 'betweenPlanes', 'cylinder'] },
  angularity: { clause: '18.11', datums: 'required', maximum: true, kinds: ['plane', 'line', 'axis', 'medianPlane'], zones: ['betweenLines', 'betweenPlanes', 'cylinder'] },
  position: { clause: '18.12', datums: 'optional', maximum: true, kinds: ['axis', 'medianPlane'], zones: ['betweenLines', 'betweenPlanes', 'cylinder'] },
  coaxiality: { clause: '18.13', datums: 'required', maximum: true, kinds: ['axis'], zones: ['cylinder'] },
  symmetry: { clause: '18.14', datums: 'required', maximum: true, kinds: ['medianPlane'], zones: ['betweenPlanes'] },
  circularRunout: { clause: '18.15', datums: 'required', maximum: false, kinds: ['surface', 'plane', 'curve'], zones: ['radialRunout', 'axialRunout'] },
  totalRunout: { clause: '18.16', datums: 'required', maximum: false, kinds: ['surface', 'plane'], zones: ['radialRunout', 'axialRunout'] },
} as const satisfies Record<ToleranceCharacteristic, GdtRule>;

export function defaultGdtToleranceZone(characteristic: ToleranceCharacteristic, kind: ResolvedGdtFeature['kind'] | null): ToleranceZone {
  const zones: readonly ToleranceZone[] = GDT_RULES[characteristic].zones;
  if (kind === 'axis' && zones.includes('cylinder')) return 'cylinder';
  if ((kind === 'plane' || kind === 'medianPlane') && zones.includes('betweenPlanes')) return 'betweenPlanes';
  return zones[0];
}

export interface GdtIssue {
  readonly code: 'target' | 'characteristic' | 'zone' | 'value' | 'unit' | 'material' | 'datum' | 'label' | 'placement' | 'basicDimension' | 'sizeDimension' | 'segments';
  readonly message: string;
  readonly segmentIndex?: number;
}
export interface ResolvedDatum {
  readonly datum: DatumDefinition;
  readonly feature: ResolvedGdtFeature | null;
  readonly issues: readonly GdtIssue[];
}
export interface ResolvedFrameSegment {
  readonly segment: GdtFrameSegment;
  readonly valueMm: number;
  /** 欄と優先順を保持し、共通データムは欄の中の配列で表す。 */
  readonly datums: readonly (readonly { readonly datum: ResolvedDatum; readonly material: MaterialRequirement }[])[];
}
export interface ResolvedGdtFrame {
  readonly frame: GeometricToleranceFrame;
  readonly feature: ResolvedGdtFeature | null;
  readonly segments: readonly ResolvedFrameSegment[];
  readonly issues: readonly GdtIssue[];
}
export interface DrawingGdtResolution {
  readonly datums: readonly ResolvedDatum[];
  readonly frames: readonly ResolvedGdtFrame[];
  readonly unresolvedCount: number;
}
export function resolveDrawingGdt(document: DrawingDocument, context: DimensionResolveContext): DrawingGdtResolution {
  const dimensions = document.datums.length + document.gdtFrames.length === 0 ? [] : resolveDrawingDimensions(document, context);
  // 意味の検証に加え、製造図として軸・中心平面の指示先をサイズ寸法線へ拘束する。
  const attachmentIssues = (item: DatumDefinition | GeometricToleranceFrame): readonly GdtIssue[] => {
    const needsSize = item.feature.kind === 'axis' || item.feature.kind === 'medianPlane';
    if (!needsSize) return item.sizeDimensionId === undefined ? []
      : [{ code: 'sizeDimension', message: '面や線の指示にはサイズ寸法を関連付けません。' }];
    return compatibleGdtSizeDimensions(item.feature, document, context, dimensions).some((entry) => entry.dimension.id === item.sizeDimensionId) ? []
      : [{ code: 'sizeDimension', message: '同じ軸の直径寸法、または同じ二面の幅寸法を作成して関連付けてください。' }];
  };
  const datums = resolveDrawingDatums(document.datums, document, context).map((entry) => ({ ...entry,
    issues: [...entry.issues, ...attachmentIssues(entry.datum)] }));
  const frames = document.gdtFrames.map((frame) => {
    const entry = resolveGdtFrame(frame, document, context, datums);
    const basicIssues: GdtIssue[] = [];
    frame.segments.forEach((segment, segmentIndex) => {
      const linked = segment.basicDimensionIds.map((id) => dimensions.find((item) => item.dimension.id === id));
      if (linked.some((item) => item?.status !== 'resolved')) basicIssues.push({ code: 'basicDimension', segmentIndex,
        message: '参照する理論的に正確な寸法の対象が未解決です。寸法の対象を修復してください。' });
      // B0021の11/18.11。傾きの指定を、公差の幅だけを持つ枠で代用しない。
      if (segment.characteristic === 'angularity' && !linked.some((item) => item?.status === 'resolved' && item.dimension.kind === 'angle'
        && item.dimension.basic === true)) basicIssues.push({ code: 'basicDimension', segmentIndex,
        message: '傾斜度には、姿勢を定義する理論的に正確な角度寸法を記入して参照してください。' });
    });
    return { ...entry, issues: [...entry.issues, ...attachmentIssues(frame), ...basicIssues] };
  });
  return { datums, frames, unresolvedCount: datums.filter((datum) => datum.issues.length > 0).length + frames.filter((frame) => frame.issues.length > 0).length };
}
export const datumMembers = (reference: DatumReference) => reference.kind === 'single' ? [reference.member] : reference.members;
function sameNominalDatum(a: ResolvedGdtFeature | null, b: ResolvedGdtFeature | null): boolean {
  if (a === null || b === null || a.kind !== b.kind || a.direction === null || b.direction === null) return false;
  const direction = a.direction;
  const dot = (x: readonly number[], y: readonly number[]): number => x.reduce((sum, value, index) => sum + value * y[index], 0);
  if (1 - Math.abs(dot(a.direction, b.direction)) > 1e-7) return false;
  const delta = a.point.map((value, index) => value - b.point[index]), along = dot(delta, a.direction);
  if (a.kind === 'plane' || a.kind === 'medianPlane') return Math.abs(along) <= 1e-7;
  return Math.hypot(...delta.map((value, index) => value - along * direction[index])) <= 1e-7;
}
function hasAngleParameter(source: string, document: DrawingDocument): boolean {
  const pending = [...collectVariableNames(source)], seen = new Set<string>();
  for (let index = 0; index < pending.length; index++) {
    const name = pending[index]; if (seen.has(name)) continue; seen.add(name);
    const parameter = document.parameters.find((entry) => entry.name === name);
    if (parameter?.unit === 'degree') return true;
    if (parameter !== undefined) pending.push(...collectVariableNames(parameter.value.source));
  }
  return false;
}
function placementIssues(item: Pick<DatumDefinition, 'height' | 'position' | 'layerId'>, document: DrawingDocument): GdtIssue[] {
  return !Number.isFinite(item.height) || item.height < 1 || item.height > 100 || !item.position.every(Number.isFinite)
    || !document.layers.some((layer) => layer.id === item.layerId)
    ? [{ code: 'placement', message: '文字高を1〜100mmとし、用紙上の位置とレイヤーを指定してください。' }] : [];
}

export function resolveDrawingDatums(datums: readonly DatumDefinition[], document: DrawingDocument, context: DimensionResolveContext): readonly ResolvedDatum[] {
  return datums.map((datum) => {
    const feature = resolveGdtFeature(datum.feature, document, context), issues = placementIssues(datum, document);
    if (datum.id.trim() === '' || !/^[A-Z]$/.test(datum.label) || datums.some((other) => other !== datum && (other.label === datum.label || other.id === datum.id))) {
      issues.push({ code: 'label', message: 'データム名は重複しない英大文字1文字で指定してください。' });
    }
    if (feature === null || !['plane', 'line', 'axis', 'medianPlane'].includes(feature.kind)) {
      issues.push({ code: 'target', message: '基準にする平面・直線・軸・中心平面が見つかりません。対象を選び直してください。' });
    }
    return { datum, feature, issues };
  });
}

function zoneMatches(segment: GdtFrameSegment, feature: ResolvedGdtFeature): boolean {
  const { characteristic, zone } = segment;
  if (zone === 'cylinder' && feature.kind !== 'axis') return false;
  if (zone === 'betweenLines' && (feature.kind === 'plane' || feature.kind === 'medianPlane')) return false;
  if (characteristic === 'roundness') return ['circle', 'cylinder', 'cone', 'sphere', 'torus'].includes(feature.geometry);
  if (characteristic === 'cylindricity') return feature.geometry === 'cylinder';
  if (zone === 'axialRunout') return feature.kind === 'plane';
  if (zone === 'radialRunout') return characteristic === 'totalRunout' ? feature.geometry === 'cylinder'
    : ['cylinder', 'cone', 'circle', 'torus'].includes(feature.geometry);
  return true;
}

export function resolveGdtFrame(frame: GeometricToleranceFrame, document: DrawingDocument, context: DimensionResolveContext,
  datums: readonly ResolvedDatum[]): ResolvedGdtFrame {
  const feature = resolveGdtFeature(frame.feature, document, context), issues = placementIssues(frame, document);
  const segments: ResolvedFrameSegment[] = [];
  if (feature === null) issues.push({ code: 'target', message: '公差の対象が見つかりません。面・線・軸を選び直してください。' });
  if (frame.segments.length < 1 || frame.segments.length > 8) issues.push({ code: 'segments', message: '公差枠は1〜8段で指定してください。' });
  frame.segments.slice(0, 8).forEach((segment, segmentIndex) => {
    const issue = (code: GdtIssue['code'], message: string): void => { issues.push({ code, message, segmentIndex }); };
    const rule: GdtRule | undefined = GDT_RULES[segment.characteristic];
    if (rule === undefined) { issue('characteristic', '幾何公差の種類を選んでください。'); return; }
    if (feature !== null && !rule.kinds.includes(feature.kind)) issue('characteristic', 'この公差の種類は選んだ形体に指定できません。');
    if (!rule.zones.includes(segment.zone) || (feature !== null && !zoneMatches(segment, feature))) issue('zone', '選んだ形体と公差の種類に合う公差域を指定してください。');
    if (segment.material === 'maximum' && (!rule.maximum || feature?.sizeFeature !== true)) issue('material', '最大実体公差は適用できる軸または中心平面に指定してください。');
    if (segment.datums.length > 3 || (rule.datums === 'none' && segment.datums.length !== 0)
      || (rule.datums === 'required' && segment.datums.length === 0)) issue('datum', rule.datums === 'none'
        ? 'この形状公差にはデータムを指定しません。' : '必要な基準を、第1〜第3データムの順に指定してください。');
    const seen = new Set<string>();
    const resolvedDatums = segment.datums.slice(0, 3).map((reference) => {
      const members = datumMembers(reference);
      if (reference.kind === 'common' && members.length !== 2) issue('datum', '共通データムには2つの基準を指定してください。');
      const group = members.flatMap((member) => {
        const candidates = datums.filter((entry) => entry.datum.id === member.datumId);
        if (seen.has(member.datumId)) issue('datum', '同じデータムを同一段で重複して指定できません。');
        seen.add(member.datumId);
        if (candidates.length !== 1 || candidates[0].issues.length !== 0) { issue('datum', '参照するデータムが未解決です。基準を選び直してください。'); return []; }
        const datum = candidates[0];
        if (feature?.shapeKeys.some((key) => datum.feature?.shapeKeys.includes(key)) === true) issue('datum', '公差対象そのものを基準に指定できません。');
        if (member.material === 'maximum' && datum.feature?.sizeFeature !== true) issue('material', 'データムの最大実体指定にはサイズ形体を選んでください。');
        return [{ datum, material: member.material }];
      });
      if (reference.kind === 'common' && group.length === 2 && !sameNominalDatum(group[0].datum.feature, group[1].datum.feature))
        issue('datum', '共通データムには、公称形状で同じ軸または同じ平面となる2つの基準を指定してください。');
      return group;
    });
    if ((segment.characteristic === 'coaxiality' || segment.characteristic === 'circularRunout' || segment.characteristic === 'totalRunout')
      && !resolvedDatums.some((group) => group.some((entry) => entry.datum.feature?.kind === 'axis'))) issue('datum', 'この公差には基準となる軸が必要です。');
    if (new Set(segment.basicDimensionIds).size !== segment.basicDimensionIds.length || segment.basicDimensionIds.some((id) => {
      const dimension = document.dimensions.find((entry) => entry.id === id);
      return dimension?.basic !== true || dimension.reference || dimension.tolerance !== undefined || dimension.fit !== undefined;
    })) issue('basicDimension', '参照する理論的に正確な寸法が見つからないか、寸法公差と併用されています。');
    const expression = segment.tolerance.expression.source;
    if (hasAngleParameter(expression, document))
      issue('unit', '幾何公差の値に角度のパラメータは使えません。長さを指定してください。');
    const evaluated = evaluateExpression(parseDisplayInput(expression, segment.tolerance.unit), analyzeParameters(document.parameters, [expression]));
    const valueMm = evaluated.ok ? evaluated.value.value : NaN;
    if (!Number.isFinite(valueMm) || valueMm < 0 || (valueMm === 0 && segment.material !== 'maximum'))
      issue('value', '公差は正の長さで指定してください。最大実体公差を指定した場合は0も使えます。');
    segments.push({ segment, valueMm, datums: resolvedDatums });
  });
  return { frame, feature, segments, issues };
}

/** 未解決の枠は出力用文字列に変換しない。値は紙面の寸法と同じ内部mmで表す。 */
export function gdtFrameDisplayRows(resolved: ResolvedGdtFrame): readonly GdtDisplayRow[] | null {
  if (resolved.issues.length !== 0 || resolved.feature === null) return null;
  return resolved.segments.map(({ segment, valueMm, datums }) => {
    const value: GdtToken[] = [];
    if (segment.zone === 'cylinder' || segment.zone === 'sphere') {
      if (segment.zone === 'sphere') value.push({ kind: 'text', text: 'S' });
      value.push({ kind: 'symbol', symbol: 'diameter' });
    }
    value.push({ kind: 'text', text: valueMm.toString() });
    if (segment.material === 'maximum') value.push({ kind: 'symbol', symbol: 'maximum' });
    return { characteristic: segment.characteristic, value, datums: datums.map((group) => group.flatMap((member, index): GdtToken[] => [
      ...(index === 0 ? [] : [{ kind: 'text' as const, text: '-' }]), { kind: 'text', text: member.datum.datum.label },
      ...(member.material === 'maximum' ? [{ kind: 'symbol' as const, symbol: 'maximum' as const }] : []),
    ])) };
  });
}
