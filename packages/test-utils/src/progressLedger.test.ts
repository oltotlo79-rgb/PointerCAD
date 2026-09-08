import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function record(value: unknown): Readonly<Record<string, unknown>> | null {
  return isRecord(value) ? value : null;
}

function stringArray(value: unknown): readonly string[] | null {
  if (!Array.isArray(value)) return null;
  const strings: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') return null;
    strings.push(item);
  }
  return strings;
}

function duplicateIds(ids: readonly string[]): readonly string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) duplicates.add(id);
    seen.add(id);
  }
  return [...duplicates].sort();
}

function requiredNumber(source: Readonly<Record<string, unknown>>, key: string): number {
  const value = source[key];
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new Error(`進捗台帳の ${key} は整数である必要があります。`);
  }
  return value;
}

describe('プロジェクト進捗台帳の重複防止(rules/06 10.23)', () => {
  it('重複したタスクidを機械的に列挙する', () => {
    expect(duplicateIds(['P7-1', 'P7-2', 'P7-1', 'P7-2', 'P7-3'])).toEqual(['P7-1', 'P7-2']);
  });

  it('docs/progress.jsonの予定・完了idが一意で、完了数と報告値が一致する', () => {
    const text = readFileSync(new URL('../../../docs/progress.json', import.meta.url), 'utf8');
    const parsed: unknown = JSON.parse(text);
    const ledger = record(parsed);
    expect(ledger).not.toBeNull();
    if (ledger === null) throw new Error('進捗台帳の根はオブジェクトである必要があります。');

    expect(requiredNumber(ledger, 'totalTasks')).toBe(552);
    expect(requiredNumber(ledger, 'futureEstimateTasks')).toBe(115);
    const baseline = requiredNumber(ledger, 'completedBeforeTrackedPhases');
    const reported = requiredNumber(ledger, 'reportedCompleted');
    const phaseValues: readonly unknown[] = Array.isArray(ledger.phases) ? ledger.phases : [];
    expect(phaseValues.length).toBeGreaterThan(0);

    let trackedCompleted = 0;
    const allPlanned: string[] = [];
    const allCompleted: string[] = [];
    for (const value of phaseValues) {
      const phase = record(value);
      if (phase === null) throw new Error('進捗台帳の phase はオブジェクトである必要があります。');
      const planned = stringArray(phase.plannedTaskIds);
      const completed = stringArray(phase.completedTaskIds);
      if (planned === null || completed === null) {
        throw new Error('進捗台帳のタスクidは文字列の配列である必要があります。');
      }
      expect(planned).toHaveLength(requiredNumber(phase, 'plannedTaskCount'));
      expect(duplicateIds(planned)).toEqual([]);
      expect(duplicateIds(completed)).toEqual([]);
      const plannedSet = new Set(planned);
      expect(completed.filter((id) => !plannedSet.has(id))).toEqual([]);
      trackedCompleted += completed.length;
      allPlanned.push(...planned);
      allCompleted.push(...completed);
    }
    expect(duplicateIds(allPlanned)).toEqual([]);
    expect(duplicateIds(allCompleted)).toEqual([]);
    expect(baseline + trackedCompleted).toBe(reported);
    expect(reported).toBeLessThanOrEqual(requiredNumber(ledger, 'totalTasks'));
  });
});
