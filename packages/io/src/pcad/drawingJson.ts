/** 図面文書と `.pcadd` の `document.json` の相互変換(P8 タスク3)。 */

import type {
  Annotation,
  Balloon,
  Dimension,
  DrawingDocument,
  DrawingElementStyle,
  DrawingLayer,
  DrawingParameter,
  DrawingSheet,
  DrawingSource,
  DrawingSubShapeFingerprint,
  DrawingSubShapeRef,
  DrawingTable,
  DrawingView,
} from '@pointercad/model';

import { isRecord, isUnknownArray } from './guards.js';
import { hasOnlyFiniteJsonNumbers, preserveDrawingJsonFields } from './drawingJsonCompatibility.js';
import { migrateToCurrentSchema, type ParseError } from './documentJson.js';
import {
  PCAD_APP_NAME,
  PCAD_DRAWING_KIND,
  PCAD_DRAWING_KINDS,
  PCAD_SCHEMA_VERSION,
  type PcadDrawingEnvelope,
  type PcadDrawingKind,
} from './schema.js';

export interface SerializeDrawingOptions {
  readonly savedAt?: string;
  readonly kind?: PcadDrawingKind;
}

export type ParseDrawingResult =
  | {
      readonly ok: true;
      readonly document: DrawingDocument;
      readonly savedAt: string;
      readonly kind: PcadDrawingKind;
    }
  | { readonly ok: false; readonly error: ParseError };

const NOT_DRAWING_MESSAGE = 'この形式の図面ではありません。';

function cleanStyle(style: DrawingElementStyle | null | undefined): DrawingElementStyle | null | undefined {
  if (style === undefined || style === null) return style;
  return {
    ...(style.color === undefined ? {} : { color: style.color }),
    ...(style.lineType === undefined ? {} : { lineType: style.lineType }),
    ...(style.lineWidth === undefined ? {} : { lineWidth: style.lineWidth }),
  };
}

function cleanFingerprint(fingerprint: DrawingSubShapeFingerprint): DrawingSubShapeFingerprint {
  if (fingerprint.kind === 'vertex') {
    return { kind: 'vertex', position: [...fingerprint.position] };
  }
  if (fingerprint.kind === 'face') {
    return {
      kind: 'face',
      surfaceKind: fingerprint.surfaceKind,
      area: fingerprint.area,
      position: [...fingerprint.position],
      axis: fingerprint.axis === null ? null : [...fingerprint.axis],
      radius: fingerprint.radius,
    };
  }
  return {
    kind: 'edge',
    curveKind: fingerprint.curveKind,
    length: fingerprint.length,
    position: [...fingerprint.position],
    axis: fingerprint.axis === null ? null : [...fingerprint.axis],
    radius: fingerprint.radius,
  };
}

function cleanSubShapeRef(ref: DrawingSubShapeRef): DrawingSubShapeRef {
  return {
    bodyFeatureId: ref.bodyFeatureId,
    index: ref.index,
    fingerprint: cleanFingerprint(ref.fingerprint),
  };
}

function cleanSource(source: DrawingSource): DrawingSource {
  return {
    sourceRef: source.sourceRef,
    sourceKind: source.sourceKind,
    fileName: source.fileName,
    path: source.path,
    contentHash: source.contentHash,
    importedAt: source.importedAt,
  };
}

export function cleanSheet(sheet: DrawingSheet): DrawingSheet {
  return {
    paperSizeId: sheet.paperSizeId,
    orientation: sheet.orientation,
    scale: sheet.scale,
    projectionMethod: sheet.projectionMethod,
    frame: { visible: sheet.frame.visible },
    titleBlock: {
      title: sheet.titleBlock.title,
      drawingNumber: sheet.titleBlock.drawingNumber,
      revision: sheet.titleBlock.revision,
      author: sheet.titleBlock.author,
      date: sheet.titleBlock.date,
      material: sheet.titleBlock.material,
    },
    ...(sheet.generalTolerance === undefined ? {} : { generalTolerance: sheet.generalTolerance }),
    ...(sheet.textHeight === undefined ? {} : { textHeight: sheet.textHeight }),
    ...(sheet.scaleOptions === undefined ? {} : { scaleOptions: [...sheet.scaleOptions] }),
    ...(sheet.titleBlockFields === undefined ? {} : { titleBlockFields: sheet.titleBlockFields.map((field) => ({ ...field })) }),
  };
}

function cleanView(view: DrawingView): DrawingView {
  return {
    id: view.id,
    name: view.name,
    kind: view.kind,
    position: [...view.position],
    scale: view.scale,
    direction: [...view.direction],
    xDir: [...view.xDir],
    showHidden: view.showHidden,
    showCenterLines: view.showCenterLines,
    ...(view.hiddenCenterMarkIds === undefined ? {} : { hiddenCenterMarkIds: [...view.hiddenCenterMarkIds] }),
    ...(view.section === undefined ? {} : { section: { ...view.section } }),
    ...(view.detail === undefined
      ? {}
      : { detail: { center: [...view.detail.center], radius: view.detail.radius, scale: view.detail.scale } }),
    ...(view.breakOut === undefined
      ? {}
      : { breakOut: { boundary: view.breakOut.boundary.map((point) => [...point]), depth: view.breakOut.depth } }),
    layerId: view.layerId,
    ...(view.style === undefined ? {} : { style: cleanStyle(view.style) }),
  };
}

type ToleranceValue = number | DrawingParameter['value'];

function cleanExpressionValue(value: DrawingParameter['value']): DrawingParameter['value'] {
  return { source: value.source, value: value.value, display: value.display };
}

function cleanToleranceValue(value: ToleranceValue): ToleranceValue {
  return typeof value === 'number' ? value : cleanExpressionValue(value);
}

function cleanDimensionTarget(target: Dimension['targets'][number]): Dimension['targets'][number] {
  return target.kind === 'point'
    ? { kind: 'point', viewId: target.viewId, paperPoint: [...target.paperPoint],
      ...(target.modelPoint === undefined ? {} : { modelPoint: [...target.modelPoint] }) }
    : { kind: 'subShape', viewId: target.viewId, sourceRef: target.sourceRef,
      ...(target.componentId === undefined ? {} : { componentId: target.componentId }), ref: cleanSubShapeRef(target.ref) };
}

function cleanDimension(dimension: Dimension): Dimension {
  return {
    id: dimension.id,
    kind: dimension.kind,
    measurement: dimension.measurement,
    targets: dimension.targets.map(cleanDimensionTarget),
    placement: {
      commonNormalCoordinate: dimension.placement.commonNormalCoordinate,
      textPosition: dimension.placement.textPosition === null
        ? null
        : [...dimension.placement.textPosition],
    },
    ...(dimension.tolerance === undefined ? {} : { tolerance: dimension.tolerance.kind === 'symmetric'
      ? { kind: 'symmetric' as const, value: cleanToleranceValue(dimension.tolerance.value) }
      : { kind: 'deviation' as const, upper: cleanToleranceValue(dimension.tolerance.upper), lower: cleanToleranceValue(dimension.tolerance.lower) } }),
    ...(dimension.prefix === undefined ? {} : { prefix: dimension.prefix }),
    ...(dimension.suffix === undefined ? {} : { suffix: dimension.suffix }),
    ...(dimension.fit === undefined ? {} : { fit: { symbol: dimension.fit.symbol, showDeviation: dimension.fit.showDeviation } }),
    reference: dimension.reference,
    origin: dimension.origin,
    layerId: dimension.layerId,
    ...(dimension.style === undefined ? {} : { style: cleanStyle(dimension.style) }),
  };
}

function cleanAnnotation(annotation: Annotation): Annotation {
  return {
    id: annotation.id,
    kind: annotation.kind,
    text: annotation.text,
    position: [...annotation.position],
    ...(annotation.leader === undefined
      ? {}
      : { leader: annotation.leader.map((point) => [...point]) }),
    ...(annotation.leaderEnd === undefined ? {} : { leaderEnd: annotation.leaderEnd }),
    ...(annotation.target === undefined ? {} : { target: cleanSubShapeRef(annotation.target) }),
    ...(annotation.sourceTarget === undefined ? {} : { sourceTarget: cleanDimensionTarget(annotation.sourceTarget) }),
    ...(annotation.surfaceFinish === undefined ? {} : { surfaceFinish: { process: annotation.surfaceFinish.process,
      parameter: annotation.surfaceFinish.parameter, value: cleanExpressionValue(annotation.surfaceFinish.value) } }),
    ...(annotation.machiningFeatureId === undefined ? {} : { machiningFeatureId: annotation.machiningFeatureId }),
    height: annotation.height,
    layerId: annotation.layerId,
    ...(annotation.style === undefined ? {} : { style: cleanStyle(annotation.style) }),
  };
}

function cleanOptions(
  options: Readonly<Record<string, string | number | boolean>>,
): Readonly<Record<string, string | number | boolean>> {
  const result: Record<string, string | number | boolean> = {};
  for (const key of Object.keys(options).sort()) {
    const value = options[key];
    if (value !== undefined) result[key] = value;
  }
  return result;
}

function cleanTable(table: DrawingTable): DrawingTable {
  return {
    id: table.id,
    kind: table.kind,
    position: [...table.position],
    columns: [...table.columns],
    ...(table.rows === undefined ? {} : { rows: table.rows.map((row) => [...row]) }),
    options: cleanOptions(table.options),
    layerId: table.layerId,
    ...(table.style === undefined ? {} : { style: cleanStyle(table.style) }),
  };
}

function cleanBalloon(balloon: Balloon): Balloon {
  return {
    ...(balloon.sourceTarget === undefined ? {} : { sourceTarget: cleanDimensionTarget(balloon.sourceTarget) }),
    ...(balloon.targetKind === undefined ? {} : { targetKind: balloon.targetKind }),
    id: balloon.id,
    itemNumber: balloon.itemNumber,
    componentIds: [...balloon.componentIds],
    position: [...balloon.position],
    leader: balloon.leader.map((point) => [...point]),
    layerId: balloon.layerId,
    ...(balloon.style === undefined ? {} : { style: cleanStyle(balloon.style) }),
  };
}

function cleanLayer(layer: DrawingLayer): DrawingLayer {
  return {
    id: layer.id,
    name: layer.name,
    visible: layer.visible,
    printable: layer.printable,
    color: layer.color,
    lineType: layer.lineType,
    lineWidth: layer.lineWidth,
  };
}

function cleanParameter(parameter: DrawingParameter): DrawingParameter {
  return {
    name: parameter.name,
    value: {
      source: parameter.value.source,
      value: parameter.value.value,
      display: parameter.value.display,
    },
    unit: parameter.unit,
    description: parameter.description,
  };
}

function cleanDrawingDocument(document: DrawingDocument): DrawingDocument {
  const clean: DrawingDocument = {
    id: document.id,
    name: document.name,
    schemaVersion: document.schemaVersion,
    source: cleanSource(document.source),
    sheet: cleanSheet(document.sheet),
    views: document.views.map(cleanView),
    dimensions: document.dimensions.map(cleanDimension),
    annotations: document.annotations.map(cleanAnnotation),
    tables: document.tables.map(cleanTable),
    balloons: document.balloons.map(cleanBalloon),
    layers: document.layers.map(cleanLayer),
    parameters: document.parameters.map(cleanParameter),
  };
  return preserveDrawingJsonFields(document, clean);
}

/** 未知の指定を保ち、投影線などの導出値を除いて図面の封筒を書く。 */
export function serializeDrawing(
  document: DrawingDocument,
  options: SerializeDrawingOptions = {},
): string {
  if (!hasOnlyFiniteJsonNumbers(document)) throw new Error('図面に有限でない数値が含まれるため保存できません。');
  const envelope: PcadDrawingEnvelope = {
    schema: document.schemaVersion,
    kind: options.kind ?? PCAD_DRAWING_KIND,
    app: PCAD_APP_NAME,
    savedAt: options.savedAt ?? new Date().toISOString(),
    document: cleanDrawingDocument(document),
  };
  return `${JSON.stringify(envelope, null, 2)}\n`;
}

function hasString(record: Record<string, unknown>, key: string): boolean {
  return typeof record[key] === 'string';
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function hasNumber(record: Record<string, unknown>, key: string): boolean {
  return isFiniteNumber(record[key]);
}

function hasBoolean(record: Record<string, unknown>, key: string): boolean {
  return typeof record[key] === 'boolean';
}

function isLiteral<T extends string>(value: unknown, allowed: readonly T[]): value is T {
  if (typeof value !== 'string') return false;
  for (const candidate of allowed) {
    if (candidate === value) return true;
  }
  return false;
}

function isPoint2(value: unknown): value is readonly [number, number] {
  return isUnknownArray(value)
    && value.length === 2
    && isFiniteNumber(value[0])
    && isFiniteNumber(value[1]);
}

function isVector3(value: unknown): value is readonly [number, number, number] {
  return isUnknownArray(value)
    && value.length === 3
    && value.every((item) => isFiniteNumber(item));
}

const LINE_TYPES = ['solid', 'dashed', 'chain', 'chain2', 'zigzag'] as const;

function isStyle(value: unknown): value is DrawingElementStyle | null {
  if (value === null) return true;
  if (!isRecord(value)) return false;
  return (value['color'] === undefined || typeof value['color'] === 'string')
    && (value['lineType'] === undefined || isLiteral(value['lineType'], LINE_TYPES))
    && (value['lineWidth'] === undefined || isFiniteNumber(value['lineWidth']));
}

function hasOptionalStyle(record: Record<string, unknown>): boolean {
  return record['style'] === undefined || isStyle(record['style']);
}

function isFingerprint(value: unknown): value is DrawingSubShapeFingerprint {
  if (!isRecord(value) || !isLiteral(value['kind'], ['face', 'edge', 'vertex'])) return false;
  if (!isVector3(value['position'])) return false;
  if (value['kind'] === 'vertex') return true;
  const common = (value['axis'] === null || isVector3(value['axis']))
    && (value['radius'] === null || isFiniteNumber(value['radius']));
  if (!common) return false;
  return value['kind'] === 'face'
    ? isLiteral(value['surfaceKind'], ['plane', 'cylinder', 'cone', 'sphere', 'torus', 'other'])
      && isFiniteNumber(value['area'])
    : isLiteral(value['curveKind'], ['line', 'circle', 'ellipse', 'other'])
      && isFiniteNumber(value['length']);
}

function isSubShapeRef(value: unknown): value is DrawingSubShapeRef {
  return isRecord(value)
    && hasString(value, 'bodyFeatureId')
    && hasNumber(value, 'index')
    && isFingerprint(value['fingerprint']);
}

function isSource(value: unknown): value is DrawingSource {
  return isRecord(value)
    && hasString(value, 'sourceRef')
    && isLiteral(value['sourceKind'], ['part', 'assembly'])
    && hasString(value, 'fileName')
    && hasString(value, 'path')
    && hasString(value, 'contentHash')
    && hasString(value, 'importedAt');
}

function isTitleBlockField(value: unknown): boolean {
  return isRecord(value) && hasString(value, 'key') && hasString(value, 'label')
    && (value['fixedText'] === undefined || typeof value['fixedText'] === 'string')
    && (value['widthWeight'] === undefined || (isFiniteNumber(value['widthWeight']) && value['widthWeight'] > 0));
}

export function isSheet(value: unknown): value is DrawingSheet {
  if (!isRecord(value)
    || !hasString(value, 'paperSizeId')
    || !isLiteral(value['orientation'], ['landscape', 'portrait'])
    || !isFiniteNumber(value['scale']) || value['scale'] <= 0
    || value['projectionMethod'] !== 'third'
    || !isRecord(value['frame'])
    || !hasBoolean(value['frame'], 'visible')
    || !isRecord(value['titleBlock'])) return false;
  const title = value['titleBlock'];
  return ['title', 'drawingNumber', 'revision', 'author', 'date', 'material'].every(
    (key) => hasString(title, key),
  ) && (value['generalTolerance'] === undefined || typeof value['generalTolerance'] === 'string')
    && (value['textHeight'] === undefined || (isFiniteNumber(value['textHeight']) && value['textHeight'] > 0))
    && (value['scaleOptions'] === undefined || (isUnknownArray(value['scaleOptions']) && value['scaleOptions'].length > 0
      && value['scaleOptions'].every((scale) => isFiniteNumber(scale) && scale > 0)))
    && (value['titleBlockFields'] === undefined || (isUnknownArray(value['titleBlockFields']) && value['titleBlockFields'].length > 0
      && value['titleBlockFields'].every(isTitleBlockField)));
}

function isView(value: unknown): value is DrawingView {
  if (!isRecord(value)
    || !hasString(value, 'id')
    || !hasString(value, 'name')
    || !isLiteral(value['kind'], [
      'front', 'top', 'right', 'left', 'rear', 'bottom', 'isometric', 'section', 'detail',
      'auxiliary', 'partial', 'broken',
    ])
    || !isPoint2(value['position'])
    || !(value['scale'] === null || (isFiniteNumber(value['scale']) && value['scale'] > 0))
    || !isVector3(value['direction'])
    || !isVector3(value['xDir'])
    || !hasBoolean(value, 'showHidden')
    || !hasBoolean(value, 'showCenterLines')
    || (value['hiddenCenterMarkIds'] !== undefined && !isStringArray(value['hiddenCenterMarkIds']))
    || !hasString(value, 'layerId')
    || !hasOptionalStyle(value)) return false;
  const section = value['section'];
  if (section !== undefined && (!isRecord(section)
    || !hasString(section, 'cuttingLineId')
    || !isLiteral(section['direction'], ['forward', 'backward'])
    || !hasString(section, 'label'))) return false;
  const detail = value['detail'];
  if (detail !== undefined && (!isRecord(detail)
    || !isPoint2(detail['center'])
    || !hasNumber(detail, 'radius')
    || !hasNumber(detail, 'scale'))) return false;
  const breakOut = value['breakOut'];
  return breakOut === undefined || (isRecord(breakOut)
    && isUnknownArray(breakOut['boundary'])
    && breakOut['boundary'].every(isPoint2)
    && hasNumber(breakOut, 'depth'));
}

function isDimensionTarget(value: unknown): boolean {
  if (!isRecord(value) || !isLiteral(value['kind'], ['point', 'subShape']) || !hasString(value, 'viewId')) {
    return false;
  }
  if (value['kind'] === 'point') {
    return isPoint2(value['paperPoint'])
      && (value['modelPoint'] === undefined || isVector3(value['modelPoint']));
  }
  return hasString(value, 'sourceRef')
    && (value['componentId'] === undefined || typeof value['componentId'] === 'string')
    && isSubShapeRef(value['ref']);
}

function isToleranceValue(value: unknown): value is ToleranceValue {
  return (typeof value === 'number' && Number.isFinite(value)) ||
    (isRecord(value) && hasString(value, 'source') && hasString(value, 'display')
      && typeof value['value'] === 'number' && Number.isFinite(value['value']));
}

function isDimension(value: unknown): value is Dimension {
  if (!isRecord(value)
    || !hasString(value, 'id')
    || !isLiteral(value['kind'], [
      'length', 'diameter', 'radius', 'angle', 'sphereDiameter', 'sphereRadius', 'arcLength',
      'thickness', 'coordinate',
    ])
    || !isLiteral(value['measurement'], [
      'horizontal', 'vertical', 'trueDistance', 'angle', 'radius', 'coordinate',
    ])
    || !isUnknownArray(value['targets'])
    || !value['targets'].every(isDimensionTarget)
    || !isRecord(value['placement'])
    || !hasNumber(value['placement'], 'commonNormalCoordinate')
    || !(value['placement']['textPosition'] === null || isPoint2(value['placement']['textPosition']))
    || (value['prefix'] !== undefined && typeof value['prefix'] !== 'string')
    || (value['suffix'] !== undefined && typeof value['suffix'] !== 'string')
    || (value['fit'] !== undefined && (!isRecord(value['fit']) || !hasString(value['fit'], 'symbol')
      || !hasBoolean(value['fit'], 'showDeviation') || value['tolerance'] !== undefined))
    || !hasBoolean(value, 'reference')
    || !isLiteral(value['origin'], ['auto', 'manual'])
    || !hasString(value, 'layerId')
    || !hasOptionalStyle(value)) return false;
  const tolerance = value['tolerance'];
  if (tolerance === undefined) return true;
  if (!isRecord(tolerance) || !isLiteral(tolerance['kind'], ['symmetric', 'deviation'])) return false;
  return tolerance['kind'] === 'symmetric'
    ? isToleranceValue(tolerance['value'])
    : isToleranceValue(tolerance['upper']) && isToleranceValue(tolerance['lower']);
}

function isAnnotation(value: unknown): value is Annotation {
  return isRecord(value)
    && hasString(value, 'id')
    && isLiteral(value['kind'], ['note', 'leaderNote', 'surfaceFinish', 'generalTolerance'])
    && hasString(value, 'text')
    && isPoint2(value['position'])
    && (value['leader'] === undefined
      || (isUnknownArray(value['leader']) && value['leader'].every(isPoint2)))
    && (value['target'] === undefined || isSubShapeRef(value['target']))
    && (value['sourceTarget'] === undefined || isDimensionTarget(value['sourceTarget']))
    && (value['leaderEnd'] === undefined || (value['kind'] === 'leaderNote' && isLiteral(value['leaderEnd'], ['arrow', 'dot'])))
    && (value['machiningFeatureId'] === undefined || (typeof value['machiningFeatureId'] === 'string' && value['kind'] === 'leaderNote'))
    && (value['surfaceFinish'] === undefined || (value['kind'] === 'surfaceFinish' && isRecord(value['surfaceFinish'])
      && isLiteral(value['surfaceFinish']['process'], ['basic', 'removal', 'noRemoval'])
      && isLiteral(value['surfaceFinish']['parameter'], ['Ra', 'Rz'])
      && isRecord(value['surfaceFinish']['value']) && isToleranceValue(value['surfaceFinish']['value'])))
    && hasNumber(value, 'height')
    && hasString(value, 'layerId')
    && hasOptionalStyle(value);
}

function isStringArray(value: unknown): value is readonly string[] {
  return isUnknownArray(value) && value.every((item) => typeof item === 'string');
}

function isTable(value: unknown): value is DrawingTable {
  if (!isRecord(value)
    || !hasString(value, 'id')
    || !isLiteral(value['kind'], ['bom', 'hole', 'revision'])
    || !isPoint2(value['position'])
    || !isStringArray(value['columns'])
    || (value['rows'] !== undefined
      && (!isUnknownArray(value['rows']) || !value['rows'].every(isStringArray)))
    || !isRecord(value['options'])
    || !hasString(value, 'layerId')
    || !hasOptionalStyle(value)) return false;
  return Object.values(value['options']).every(
    (item) => typeof item === 'string' || isFiniteNumber(item) || typeof item === 'boolean',
  );
}

function isBalloon(value: unknown): value is Balloon {
  return isRecord(value)
    && (value['sourceTarget'] === undefined || isDimensionTarget(value['sourceTarget']))
    && (value['targetKind'] === undefined || value['targetKind'] === 'face' || value['targetKind'] === 'edge')
    && hasString(value, 'id')
    && hasNumber(value, 'itemNumber')
    && isStringArray(value['componentIds'])
    && isPoint2(value['position'])
    && isUnknownArray(value['leader'])
    && value['leader'].every(isPoint2)
    && hasString(value, 'layerId')
    && hasOptionalStyle(value);
}

export function isLayer(value: unknown): value is DrawingLayer {
  return isRecord(value)
    && hasString(value, 'id')
    && hasString(value, 'name')
    && hasBoolean(value, 'visible')
    && hasBoolean(value, 'printable')
    && hasString(value, 'color')
    && isLiteral(value['lineType'], LINE_TYPES)
    && hasNumber(value, 'lineWidth');
}

function isParameter(value: unknown): value is DrawingParameter {
  return isRecord(value)
    && hasString(value, 'name')
    && isRecord(value['value'])
    && hasString(value['value'], 'source')
    && hasNumber(value['value'], 'value')
    && hasString(value['value'], 'display')
    && isLiteral(value['unit'], ['mm', 'degree', 'none'])
    && hasString(value, 'description');
}

function isDrawingDocument(value: unknown): value is DrawingDocument {
  return isRecord(value)
    && hasString(value, 'id')
    && hasString(value, 'name')
    && hasNumber(value, 'schemaVersion')
    && isSource(value['source'])
    && isSheet(value['sheet'])
    && isUnknownArray(value['views']) && value['views'].every(isView)
    && isUnknownArray(value['dimensions']) && value['dimensions'].every(isDimension)
    && isUnknownArray(value['annotations']) && value['annotations'].every(isAnnotation)
    && isUnknownArray(value['tables']) && value['tables'].every(isTable)
    && isUnknownArray(value['balloons']) && value['balloons'].every(isBalloon)
    && isUnknownArray(value['layers']) && value['layers'].every(isLayer)
    && isUnknownArray(value['parameters']) && value['parameters'].every(isParameter);
}

function failure(code: ParseError['code'], message: string): ParseDrawingResult {
  return { ok: false, error: { code, message } };
}

function readCurrentEnvelope(raw: Record<string, unknown>): ParseDrawingResult {
  if (raw['app'] !== PCAD_APP_NAME || typeof raw['savedAt'] !== 'string') {
    return failure('notPcad', NOT_DRAWING_MESSAGE);
  }
  if (!isLiteral(raw['kind'], PCAD_DRAWING_KINDS)) {
    return failure('unsupportedKind', NOT_DRAWING_MESSAGE);
  }
  if (!isDrawingDocument(raw['document'])) {
    return failure('invalidField', 'ファイルの中身が壊れています(document の形が違います)。');
  }
  if (raw['document'].schemaVersion !== PCAD_SCHEMA_VERSION) {
    return failure(
      'versionMismatch',
      `ファイルの版の記録が食い違っています(封筒 ${String(PCAD_SCHEMA_VERSION)} / 文書 ${String(raw['document'].schemaVersion)})。`,
    );
  }
  return {
    ok: true,
    document: cleanDrawingDocument(raw['document']),
    savedAt: raw['savedAt'],
    kind: raw['kind'],
  };
}

/** 壊れた入力でも例外を外へ出さず、部品・アセンブリと共通のエラー形を返す。 */
export function parseDrawing(text: string): ParseDrawingResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    return failure('invalidJson', '図面ファイルの中身を読み取れませんでした。');
  }
  if (!hasOnlyFiniteJsonNumbers(parsed)) return failure('invalidField', '図面に有限でない数値が含まれています。');
  if (!isRecord(parsed) || typeof parsed['schema'] !== 'number') {
    return failure('notPcad', NOT_DRAWING_MESSAGE);
  }
  const schema = parsed['schema'];
  if (schema > PCAD_SCHEMA_VERSION) {
    return failure(
      'unsupportedNewVersion',
      `この図面は新しい版の PointerCAD で保存されています(版 ${String(schema)})。`,
    );
  }
  if (isRecord(parsed['document'])
    && typeof parsed['document']['schemaVersion'] === 'number'
    && parsed['document']['schemaVersion'] !== schema) {
    return failure(
      'versionMismatch',
      `ファイルの版の記録が食い違っています(封筒 ${String(schema)} / 文書 ${String(parsed['document']['schemaVersion'])})。`,
    );
  }
  if (schema < PCAD_SCHEMA_VERSION) {
    const migrated = migrateToCurrentSchema(parsed, schema);
    if (migrated === null) {
      return failure('unsupportedOldVersion', `対応していない古い版です(版 ${String(schema)})。`);
    }
    return readCurrentEnvelope(migrated);
  }
  return readCurrentEnvelope(parsed);
}
