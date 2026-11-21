import { checkVariableName, CONSTANT_TOKEN_NAMES, FUNCTION_ARITY, LENGTH_UNITS, normalizeExpressionSource } from '@pointercad/expression';
import type { Parameter } from '@pointercad/model';

interface CompletionWord {
  readonly start: number;
  readonly end: number;
  readonly prefix: string;
  readonly unitSuffix: boolean;
}

interface Candidate {
  readonly name: string;
  readonly detail: string;
  readonly call: boolean;
}

const MAX_CANDIDATES = 8;

// Use the expression grammar's character checks. A reserved name is still an identifier.
function wordCharacter(text: string): boolean {
  return text !== '' && checkVariableName(text) !== 'invalidCharacter';
}

export function completionWord(source: string, caret: number): CompletionWord | null {
  if (!Number.isInteger(caret) || caret <= 0 || caret > source.length) return null;
  const text = normalizeExpressionSource(source).replace(/[Ａ-Ｚａ-ｚ]/gu, letter => letter.normalize('NFKC'));
  let start = caret;
  let end = caret;
  if (text.charAt(caret - 1) === '"') {
    start -= 1;
  } else {
    while (start > 0 && wordCharacter(text.charAt(start - 1))) start -= 1;
    while (start < caret && /[0-9]/u.test(text.charAt(start))) start += 1;
    if (start === caret) return null;
    while (end < text.length && wordCharacter(text.charAt(end))) end += 1;
  }
  const before = text.slice(0, start).trimEnd();
  let tokenStart = before.length;
  while (tokenStart > 0 && wordCharacter(before.charAt(tokenStart - 1))) tokenStart -= 1;
  const unitSuffix = before.endsWith(')') || before.endsWith('.') || /^[0-9]+$/u.test(before.slice(tokenStart));
  return { start, end, prefix: text.slice(start, caret), unitSuffix };
}

export function expressionCandidates(word: CompletionWord, parameters: readonly Parameter[], values: ReadonlyMap<string, number>): Candidate[] {
  const { prefix } = word;
  if (word.unitSuffix) {
    return LENGTH_UNITS.filter(unit => unit.startsWith(prefix.toLowerCase()))
      .map(name => ({ name, detail: '', call: false }));
  }
  const candidates: Candidate[] = [];
  for (const { name, unit } of parameters) {
    const value = values.get(name);
    if (!name.startsWith(prefix) || value === undefined) continue;
    const suffix = unit === 'mm' ? ' mm' : unit === 'degree' ? '°' : '';
    candidates.push({ name, detail: String(value) + suffix, call: false });
    if (candidates.length === MAX_CANDIDATES) return candidates;
  }
  for (const name of FUNCTION_ARITY.keys()) {
    if (name.startsWith(prefix)) candidates.push({ name, detail: '', call: true });
  }
  for (const name of CONSTANT_TOKEN_NAMES) {
    if (name.startsWith(prefix)) candidates.push({ name, detail: '', call: false });
  }
  return candidates.slice(0, MAX_CANDIDATES);
}

export function insertCompletion(source: string, word: CompletionWord, candidate: Candidate): { source: string; caret: number } {
  const next = source.slice(word.end);
  const reuseParen = candidate.call && /^[（(]/u.test(next);
  const insertion = candidate.call && !reuseParen ? candidate.name + '(' : candidate.name;
  return { source: source.slice(0, word.start) + insertion + next, caret: word.start + insertion.length + Number(reuseParen) };
}

type CompletionAction = { kind: 'select'; index: number } | { kind: 'accept'; index: number } | { kind: 'close' } | { kind: 'pass' };

export function completionKey(key: string, count: number, selected: number): CompletionAction {
  if (count === 0) return { kind: 'pass' };
  if (key === 'Escape') return { kind: 'close' };
  if (key === 'ArrowDown') return { kind: 'select', index: (selected + 1) % count };
  if (key === 'ArrowUp') return { kind: 'select', index: selected <= 0 ? count - 1 : selected - 1 };
  if (key === 'Enter' && selected >= 0 && selected < count) return { kind: 'accept', index: selected };
  return { kind: 'pass' };
}
