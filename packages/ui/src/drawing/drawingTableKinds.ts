import type { DrawingTable } from '@pointercad/drawing';
import type { MessageKey } from '../i18n/t.js';

/**
 * 図面の表の種類と、画面に出す名前(表の窓の選択肢と図面ブラウザの行が同じ表を使う)。種類を足すと、ここが型で足りなくなる。
 * 選択肢の並びも、この表の並び。
 */
export const DRAWING_TABLE_KIND_LABELS: Readonly<Record<DrawingTable['kind'], MessageKey>> = {
  bom: 'drawing.table.bom',
  hole: 'drawing.table.hole',
  revision: 'drawing.table.revisionTable',
  parameter: 'drawing.table.parameterTable',
};

export function isDrawingTableKind(value: string): value is DrawingTable['kind'] {
  return Object.hasOwn(DRAWING_TABLE_KIND_LABELS, value);
}

/** 表の窓の選択肢の並び(名前の表の並び)。 */
export const DRAWING_TABLE_KINDS: readonly DrawingTable['kind'][] = Object.keys(DRAWING_TABLE_KIND_LABELS).filter(isDrawingTableKind);

/** 係数の表に出す係数(J-05c): 関数の曲線・曲面の式が使う係数だけか、すべての係数か。表の options.scope に保存する。 */
export type ParameterTableScope = 'function' | 'all';

export const PARAMETER_TABLE_SCOPE_LABELS: Readonly<Record<ParameterTableScope, MessageKey>> = {
  function: 'drawing.table.parameterScope.function',
  all: 'drawing.table.parameterScope.all',
};

export function isParameterTableScope(value: unknown): value is ParameterTableScope {
  return typeof value === 'string' && Object.hasOwn(PARAMETER_TABLE_SCOPE_LABELS, value);
}

/** 表の窓の「表に出す係数」の選択肢の並び(名前の表の並び)。 */
export const PARAMETER_TABLE_SCOPES: readonly ParameterTableScope[] = Object.keys(PARAMETER_TABLE_SCOPE_LABELS).filter(isParameterTableScope);

/** 係数の表の列(保存の columns。並びは drawing の parameterTable の列と同じ)。 */
export const PARAMETER_TABLE_COLUMNS: readonly string[] = ['name', 'value', 'unit', 'description'];
