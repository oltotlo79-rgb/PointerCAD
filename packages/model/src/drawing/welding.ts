import type { DrawingDocument, WeldKind, WeldLengthValue, WeldSideSpec, WeldSymbol } from '@pointercad/drawing';
import { collectVariableNames, evaluateExpression } from '@pointercad/expression';
import { analyzeParameters } from '../parameters/parameterTable.js';
import type { ParameterUnit } from '../parameters/types.js';
import { parseDisplayInput } from '../units/length.js';
import type { DimensionResolveContext } from './dimensionTarget.js';
import { resolveGdtFeature, type ResolvedGdtFeature } from './gdt.js';
import { drawingManufacturingIds } from './gdtEdit.js';
import { nextSerialId } from '../sketch/createSketchDocument.js';

export interface WeldIssue { readonly code: 'target' | 'side' | 'size' | 'length' | 'pitch' | 'count' | 'groove' | 'finish' | 'allAround' | 'placement'; readonly message: string; readonly sideIndex?: number }
export interface ResolvedWeldSide {
  readonly spec: WeldSideSpec;
  readonly sizeMm: number | null;
  readonly lengthMm: number | null;
  readonly pitchMm: number | null;
  readonly count: number | null;
  readonly rootGapMm: number | null;
  readonly grooveDepthMm: number | null;
  readonly grooveAngleDeg: number | null;
}
export interface ResolvedWeldSymbol {
  readonly symbol: WeldSymbol;
  readonly feature: ResolvedGdtFeature | null;
  readonly sides: readonly ResolvedWeldSide[];
  readonly issues: readonly WeldIssue[];
}
const sizes: Readonly<Record<WeldKind, readonly NonNullable<WeldSideSpec['size']>['kind'][]>> = {
  fillet: ['leg', 'throat'], squareButt: ['penetration'], vButt: ['penetration'], bevelButt: ['penetration'], uButt: ['penetration'],
  jButt: ['penetration'], spot: ['diameter'], seam: ['width'],
};
function parameterUnits(source: string, document: DrawingDocument): ReadonlySet<ParameterUnit> {
  const result = new Set<ParameterUnit>(), pending = [...collectVariableNames(source)], seen = new Set<string>();
  for (let index = 0; index < pending.length; index++) {
    const name = pending[index]; if (seen.has(name)) continue; seen.add(name);
    const parameter = document.parameters.find((item) => item.name === name);
    if (parameter === undefined) continue;
    result.add(parameter.unit); pending.push(...collectVariableNames(parameter.value.source));
  }
  return result;
}
function evaluate(source: string, document: DrawingDocument, unit: 'mm' | 'inch' | 'degree' | 'none'): number {
  const units = parameterUnits(source, document);
  if ((unit === 'mm' || unit === 'inch') ? units.has('degree') : unit === 'degree' ? units.has('mm') : units.has('mm') || units.has('degree')) return NaN;
  const value = evaluateExpression(unit === 'mm' || unit === 'inch' ? parseDisplayInput(source, unit) : source, analyzeParameters(document.parameters, [source]));
  return value.ok ? value.value.value : NaN;
}
const length = (value: WeldLengthValue | undefined, document: DrawingDocument): number | null => value === undefined ? null : evaluate(value.expression.source, document, value.unit);

/** JIS Z3021:2016 System B。寸法・位置の指示を検証し、実物の溶接品質判定とは分ける。 */
export function resolveWeldSymbol(symbol: WeldSymbol, document: DrawingDocument, context: DimensionResolveContext): ResolvedWeldSymbol {
  const issues: WeldIssue[] = [];
  const target = symbol.target;
  const feature = target.kind !== 'subShape' || target.ref.fingerprint.kind === 'vertex' ? null
    : resolveGdtFeature({ kind: target.ref.fingerprint.kind === 'face' ? 'surface' : 'line', target }, document, context);
  if (feature === null) issues.push({ code: 'target', message: '溶接する面または継手の線が見つかりません。対象を選び直してください。' });
  if (!symbol.position.every(Number.isFinite) || !Number.isFinite(symbol.height) || symbol.height < 1 || symbol.height > 100
    || !document.layers.some((layer) => layer.id === symbol.layerId) || symbol.tail.length > 2000
    || (symbol.arrowBendOffset !== undefined && !symbol.arrowBendOffset.every(Number.isFinite)) || (symbol.closedTail === true && symbol.tail.trim() === ''))
    issues.push({ code: 'placement', message: '紙上位置、文字高1〜100mm、レイヤーと尾の文章を確認してください。' });
  if (symbol.sides.length < 1 || symbol.sides.length > 2 || new Set(symbol.sides.map((side) => side.side)).size !== symbol.sides.length
    || (symbol.sides.some((side) => side.side === 'center') && symbol.sides.length !== 1))
    issues.push({ code: 'side', message: '矢の側と反対側は各1組、側に関係しない指定は1組で記入してください。' });
  const sides = symbol.sides.slice(0, 2).map((spec, sideIndex): ResolvedWeldSide => {
    const issue = (code: WeldIssue['code'], message: string): void => { issues.push({ code, message, sideIndex }); };
    const sizeMm = length(spec.size?.value, document), lengthMm = length(spec.length, document), pitchMm = length(spec.pitch, document);
    const rootGapMm = length(spec.rootGap, document), count = spec.count === undefined ? null : evaluate(spec.count.source, document, 'none');
    const grooveDepthMm = length(spec.grooveDepth, document);
    const grooveAngleDeg = spec.grooveAngle === undefined ? null : evaluate(spec.grooveAngle.source, document, 'degree');
    const positive = (value: number | null): boolean => value === null || Number.isFinite(value) && value > 0;
    if (spec.side === 'center' && spec.kind !== 'spot' && spec.kind !== 'seam') issue('side', '基線の中央への指定は、側に関係しないスポットまたはシーム溶接に使います。');
    if (!positive(sizeMm) || (spec.size !== undefined && !sizes[spec.kind].includes(spec.size.kind))
      || (['fillet', 'spot', 'seam'].includes(spec.kind) && sizeMm === null))
      issue('size', 'すみ肉は脚長またはのど厚、スポットは直径、シームは幅を正の長さで指定してください。開先溶接の部分溶込みは溶接深さを指定します。');
    if (!positive(lengthMm) || (spec.kind === 'spot' && lengthMm !== null)) issue('length', '溶接長は正の長さで指定してください。スポットには長さを指定しません。');
    if (!positive(pitchMm) || (pitchMm !== null && lengthMm !== null && pitchMm <= lengthMm)) issue('pitch', '中心間隔は正の長さで、断続する溶接の長さより大きくしてください。');
    if (count !== null && (!Number.isSafeInteger(count) || count < 1 || count > 10000)) issue('count', '溶接の個数は単位のない1〜10000の整数で指定してください。');
    if ((pitchMm === null) !== (count === null) || (pitchMm !== null && spec.kind !== 'spot' && lengthMm === null))
      issue('pitch', '断続溶接は個数と中心間隔を組にし、スポット以外は溶接長も指定してください。');
    const groove = ['squareButt', 'vButt', 'bevelButt', 'uButt', 'jButt'].includes(spec.kind);
    if (rootGapMm !== null && (!groove || !Number.isFinite(rootGapMm) || rootGapMm < 0)) issue('groove', 'ルート間隔は開先溶接に0以上の長さで指定してください。');
    if (grooveDepthMm !== null && (!groove || !Number.isFinite(grooveDepthMm) || grooveDepthMm <= 0)) issue('groove', '開先深さは開先溶接に正の長さで指定してください。');
    if (grooveAngleDeg !== null && (!groove || spec.kind === 'squareButt' || !Number.isFinite(grooveAngleDeg) || grooveAngleDeg <= 0 || grooveAngleDeg >= 180))
      issue('groove', '開先角度はI形以外の開先溶接に0度より大きく180度より小さい角度で指定してください。');
    if (spec.finish !== 'none' && spec.contour === 'none') issue('finish', '仕上げ方法とともに、平ら・凸形・凹形の表面形状を指定してください。');
    if ((spec.kind === 'spot' || spec.kind === 'seam') && spec.side === 'center' && (spec.contour !== 'none' || spec.finish !== 'none'))
      issue('finish', '部材の接触面に行う抵抗溶接には、表面の仕上げ記号を併用しません。');
    return { spec, sizeMm, lengthMm, pitchMm, count, rootGapMm, grooveDepthMm, grooveAngleDeg };
  });
  if (symbol.allAround && sides.some((side) => side.spec.kind === 'spot' || side.pitchMm !== null || side.lengthMm !== null))
    issues.push({ code: 'allAround', message: '全周記号は閉じた継手を連続して溶接する指定に使います。部分長さや断続・スポットとは併用しません。' });
  return { symbol, feature, sides, issues };
}

export function resolveDrawingWelds(document: DrawingDocument, context: DimensionResolveContext): readonly ResolvedWeldSymbol[] {
  return document.weldSymbols.map((symbol) => resolveWeldSymbol(symbol, document, context));
}
export function putDrawingWeld(document: DrawingDocument, candidate: Omit<WeldSymbol, 'id'>, context: DimensionResolveContext, expected?: WeldSymbol):
  { readonly ok: true; readonly document: DrawingDocument; readonly id: string } | { readonly ok: false; readonly issues: readonly WeldIssue[] } {
  if (expected !== undefined && document.weldSymbols.find((item) => item.id === expected.id) !== expected)
    return { ok: false, issues: [{ code: 'target', message: '編集対象が変わりました。溶接記号を選び直してください。' }] };
  const id = expected?.id ?? nextSerialId(drawingManufacturingIds(document), 'weld-'), symbol = { ...candidate, id };
  const next = { ...document, weldSymbols: expected === undefined ? [...document.weldSymbols, symbol] : document.weldSymbols.map((item) => item === expected ? symbol : item) };
  const result = resolveWeldSymbol(symbol, next, context);
  if (result.issues.length > 0) return { ok: false, issues: result.issues };
  return { ok: true, id, document: expected !== undefined && JSON.stringify(expected) === JSON.stringify(symbol) ? document : next };
}
