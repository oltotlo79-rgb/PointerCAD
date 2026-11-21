import type { DrawingDocument } from '@pointercad/drawing';
import { collectMathCoefficients } from '@pointercad/expression';
import { MathInputProblem } from '@pointercad/expression/math/contracts';
import {
  analyzeParameters, mapDocumentFunctionExpressions, type DrawingSourceLibrary, type EmbeddedDrawingSource, type PartDocument,
} from '@pointercad/model';
import { t } from '../i18n/t.js';
import { PARAMETER_UNIT_KEYS } from '../parameters/parameterUnitKeys.js';
import { displayNumber } from '../sketch/numericInputPresentation.js';
import type { ParameterTableScope } from './drawingTableKinds.js';
import { parameterFields } from './parameterFields.js';

/** 解けない欄の代わりに出す印(今の注記の「解けない」と同じ「？」)。 */
const UNRESOLVED_MARK = '？';

/** 図面の元(埋め込みの部品・組立)。取り込んだ時の参照と中身の指紋が同じ物だけ。 */
function embeddedSourceOf(document: DrawingDocument, library: DrawingSourceLibrary): EmbeddedDrawingSource | undefined {
  return library.sources.find((entry) => entry.metadata.sourceRef === document.source.sourceRef
    && entry.metadata.contentHash === document.source.contentHash);
}

/**
 * 普通の注記の {=名前} を、図面の元(埋め込みの部品・組立)の係数の今の値に置き換える関数を返す。
 * 元が見つからない時は置き換えない(原文のまま)。解けない名前の欄は「？」にする。
 * 画面・書き出し・選ぶ時の囲みが同じ文字を使うよう、注記を描く所と囲みを測る所の両方から呼ぶ。
 */
export function drawingNoteFields(document: DrawingDocument, library: DrawingSourceLibrary): (text: string) => string {
  const embedded = embeddedSourceOf(document, library);
  if (embedded === undefined) return (text) => text;
  const analysis = analyzeParameters(embedded.document.parameters, []);
  return (text) => parameterFields(text, analysis, UNRESOLVED_MARK).text;
}

/**
 * 関数の曲線・曲面の式が使う係数の名前。式の中の係数は id と名前の組で、係数の mathId と名前の両方が合う物だけを数える
 * (関数の作図が係数を探すのと同じ照らし方。functionGeometry/resolveFunctionInputs.ts)。式の参照名が食い違う時は null。
 */
function functionCoefficientNames(source: PartDocument): ReadonlySet<string> | null {
  const names = new Set<string>();
  try {
    mapDocumentFunctionExpressions(source, (formula) => {
      for (const reference of collectMathCoefficients(formula.expression)) {
        const parameter = source.parameters.find((item) => item.mathId === reference.id && item.name === reference.label);
        if (parameter !== undefined) names.add(parameter.name);
      }
      return formula;
    });
  } catch (error) {
    if (!(error instanceof MathInputProblem)) throw error;
    return null;
  }
  return names;
}

/** 係数の表の 1 行(drawing の parameterTable が受ける形)。 */
interface DrawingParameterRow {
  readonly name: string;
  readonly value: string;
  readonly unit: string;
  readonly description: string;
}

/**
 * 係数の表(J-05c)の行を、図面の元(埋め込みの部品・組立)の今の係数から作る(行は保存しない)。
 * scope が 'function' の時は、関数の曲線・曲面の式が使う係数だけ(組立には関数の式が無いので行は無い)。
 * 値は注記の {=名前} と同じ有効 6 桁、解けない係数は「？」。元が見つからない・式が読めない時は null(表は解けない表になる)。
 */
export function drawingParameterRows(document: DrawingDocument, library: DrawingSourceLibrary,
  scope: ParameterTableScope): readonly DrawingParameterRow[] | null {
  const embedded = embeddedSourceOf(document, library);
  if (embedded === undefined) return null;
  const source = embedded.document;
  const used = scope === 'all' ? undefined : 'sketches' in source ? functionCoefficientNames(source) : new Set<string>();
  if (used === null) return null;
  const analysis = analyzeParameters(source.parameters, []);
  return source.parameters.filter((parameter) => used === undefined || used.has(parameter.name)).map((parameter) => {
    const value = analysis.variables.get(parameter.name);
    return { name: parameter.name, value: value === undefined ? UNRESOLVED_MARK : displayNumber(value).text,
      unit: t(PARAMETER_UNIT_KEYS[parameter.unit]), description: parameter.description };
  });
}
