import type { ParameterAnalysis } from '@pointercad/model';
import { displayNumber } from '../sketch/numericInputPresentation.js';

interface ParameterFieldResult {
  readonly text: string;
  readonly unresolved: readonly string[];
}

/** 入れ子を含む欄は外側の閉じ括弧まで原文として扱う。 */
function fieldEnd(source: string, open: number): number {
  let depth = 1;
  for (let i = open + 2; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * 図面の原文を一度だけ読み、未完の欄はそのまま返す。解けない欄は unresolvedMark があればその印に、無ければ原文のまま。
 * 値は画面の数の表示と同じ有効 6 桁(displayNumber。利用者の決定 2026-11-14)。
 */
export function parameterFields(source: string, analysis: Pick<ParameterAnalysis, 'variables'>,
  unresolvedMark?: string): ParameterFieldResult {
  const unresolved = new Set<string>();
  let text = '';
  for (let i = 0; i < source.length; i += 1) {
    if (source.startsWith('{{', i)) {
      text += '{';
      i += 1;
    } else if (source.startsWith('{=', i)) {
      const end = fieldEnd(source, i);
      if (end < 0) {
        text += source.slice(i);
        break;
      }
      const name = source.slice(i + 2, end);
      const nested = name.includes('{');
      const value = name === '' || nested ? undefined : analysis.variables.get(name);
      if (value === undefined) {
        if (!nested) unresolved.add(name);
        text += nested || unresolvedMark === undefined ? source.slice(i, end + 1) : unresolvedMark;
      } else {
        text += displayNumber(value).text;
      }
      i = end;
    } else {
      text += source[i];
    }
  }
  return { text, unresolved: [...unresolved] };
}
