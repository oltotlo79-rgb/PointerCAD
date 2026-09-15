import type { ExpressionValue } from '@pointercad/expression';

export interface DefinitionDifference {
  readonly path: readonly string[];
  readonly kind: 'value' | 'expression' | 'expression-and-value' | 'stored-value' | 'order';
  readonly before: string;
  readonly after: string;
  readonly beforeStoredValue?: number;
  readonly afterStoredValue?: number;
}
export interface DiffBudget { readonly tick: () => void; readonly text: (length: number) => void; readonly fail: () => never }

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && !ArrayBuffer.isView(value);
}
function expression(value: unknown): value is Record<string, unknown> & { source: string; value: number; display: string } {
  return record(value) && typeof value.source === 'string' && typeof value.value === 'number' && typeof value.display === 'string';
}
const EXPRESSION_FIELDS = { source: 'definition', mathDefinition: 'definition', value: 'stored', display: 'presentation' } satisfies Record<keyof ExpressionValue, 'definition' | 'stored' | 'presentation'>;
const NON_DEFINITION_FIELDS = new Set(Object.entries(EXPRESSION_FIELDS).filter(([, policy]) => policy !== 'definition').map(([key]) => key));
function expressionDefinition(value: Record<string, unknown>): Record<string, unknown> {
  // 保存形式が増えたら分類を要求する。未知の欄も黙って落とさず定義へ含める。
  return Object.fromEntries(Object.entries(value).filter(([key, entry]) => !NON_DEFINITION_FIELDS.has(key) && entry !== undefined));
}

/** 型と入れ子を保つ比較用の文字列。プロパティの列挙順で偽の差分を作らない。 */
function canonical(value: unknown, budget: DiffBudget, depth = 0): string {
  budget.tick(); if (depth > 64) return budget.fail();
  if (value === undefined) return 'undefined';
  if (value === null) return 'null';
  if (typeof value === 'string') { if (value.length > 65_536) return budget.fail(); return JSON.stringify(value); }
  if (typeof value === 'number') { if (!Number.isFinite(value)) return budget.fail(); return String(value); }
  if (typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) {
    const values: readonly unknown[] = value;
    let result = '[';
    for (const item of values) {
      const part = canonical(item, budget, depth + 1);
      if (result.length + part.length > 131_070) return budget.fail();
      result += (result.length === 1 ? '' : ',') + part;
    }
    return result + ']';
  }
  if (record(value)) {
    let result = '{';
    for (const key of Object.keys(value).sort()) {
      const part = `${JSON.stringify(key)}:${canonical(value[key], budget, depth + 1)}`;
      if (result.length + part.length > 131_070) return budget.fail();
      result += (result.length === 1 ? '' : ',') + part;
    }
    return result + '}';
  }
  return budget.fail();
}

export function compareDefinitionValues(before: unknown, after: unknown, budget: DiffBudget): readonly DefinitionDifference[] {
  const changes: DefinitionDifference[] = [];
  const append = (difference: DefinitionDifference): void => {
    if (changes.length >= 1_024 || difference.before.length + difference.after.length > 131_072) budget.fail();
    budget.text(difference.before.length + difference.after.length + difference.path.reduce((sum, item) => sum + item.length, 0));
    changes.push(difference);
  };
  const visit = (old: unknown, next: unknown, path: readonly string[]): void => {
    budget.tick(); if (path.length > 64) budget.fail();
    if (old === next) return;
    if (expression(old) && expression(next)) {
      // displayは丸めた表示キャッシュ。原式と構造定義・保存値を別々に判定する。
      const oldFields = expressionDefinition(old), newFields = expressionDefinition(next);
      const oldDefinition = canonical(oldFields, budget);
      const newDefinition = canonical(newFields, budget);
      const definitionChanged = oldDefinition !== newDefinition, valueChanged = old.value !== next.value;
      if (definitionChanged || valueChanged) append({ path, kind: definitionChanged ? valueChanged ? 'expression-and-value' : 'expression' : 'stored-value',
        before: Object.keys(oldFields).every(key => key === 'source') ? old.source : oldDefinition,
        after: Object.keys(newFields).every(key => key === 'source') ? next.source : newDefinition,
        beforeStoredValue: old.value, afterStoredValue: next.value });
      return;
    }
    if (record(old) && record(next)) {
      for (const key of [...new Set([...Object.keys(old), ...Object.keys(next)])].sort()) visit(old[key], next[key], [...path, key]);
      return;
    }
    if (Array.isArray(old) && Array.isArray(next) && old.length === next.length) {
      const oldItems: readonly unknown[] = old, nextItems: readonly unknown[] = next;
      for (let i = 0; i < oldItems.length; i += 1) visit(oldItems[i], nextItems[i], [...path, String(i + 1)]);
      return;
    }
    const previousText = canonical(old, budget), nextText = canonical(next, budget);
    if (previousText !== nextText) append({ path, kind: 'value', before: previousText, after: nextText });
  };
  visit(before, after, []); return changes;
}
