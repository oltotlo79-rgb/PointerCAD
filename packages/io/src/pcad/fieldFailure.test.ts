import { describe, expect, it } from 'vitest';
import { fieldFailure } from './guards.js';

type FieldProblem = Parameters<typeof fieldFailure>[0];

describe('persisted part and assembly field failures', () => {
  it('retains the missing-field code and exact nested path message', () => {
    expect(fieldFailure({ reason: 'missing', path: 'partFiles[0].path' })).toEqual({
      ok: false, error: { code: 'missingField', message: 'ファイルの中身が壊れています(partFiles[0].path が見つかりません)。' },
    });
  });

  it('retains the invalid-field code and does not normalize the supplied path', () => {
    expect(fieldFailure({ reason: 'type', path: 'document.図形[2].値' })).toEqual({
      ok: false, error: { code: 'invalidField', message: 'ファイルの中身が壊れています(document.図形[2].値 の形が違います)。' },
    });
  });

  it('reads reason before path exactly once and returns fresh failure objects', () => {
    const reads: string[] = [];
    const problem: FieldProblem = {
      get reason(): FieldProblem['reason'] { reads.push('reason'); return 'missing'; },
      get path() { reads.push('path'); return 'document'; },
    };
    const first = fieldFailure(problem);
    expect(reads).toEqual(['reason', 'path']);
    const second = fieldFailure(problem);
    expect(reads).toEqual(['reason', 'path', 'reason', 'path']);
    expect(second).toEqual(first);
    expect(second).not.toBe(first);
    expect(second.error).not.toBe(first.error);
  });

  it('preserves a path access exception without translating or swallowing it', () => {
    const failure = new Error('path accessor failed');
    const problem: FieldProblem = { reason: 'type', get path(): string { throw failure; } };
    let caught: unknown;
    try { fieldFailure(problem); } catch (error) { caught = error; }
    expect(caught).toBe(failure);
  });
});
