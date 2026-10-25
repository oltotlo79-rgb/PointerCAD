import { describe, expect, it } from 'vitest';
import { createRuntimePhaseJournal } from './runtimePhaseJournal.js';
import { createKernelPhaseObserver } from './kernelApi.js';

const nonce = 'actual-phase-capture-1234';

describe('bounded runtime phase capture', () => {
  it('records actual kernel phases without clearing the independent diagnostic overflow', () => {
    const observer = createKernelPhaseObserver();
    observer.beginCapture(nonce);
    const owner = { dispatchId: 'dispatch-1', partId: 'part-1', generation: 1, kind: 'display' as const, steps: [] };
    observer.record('native-build-start', owner);
    for (let index = 0; index < 300; index++) observer.record('geometry-cancel-check', owner);
    observer.record('native-build-return', owner);
    const journal = observer.readCapture(nonce, null);
    expect(journal.records).toHaveLength(302);
    expect(journal.dropped).toBe(0);
    expect(journal.records[0]?.phase).toBe('native-build-start');
    expect(journal.records.at(-1)?.phase).toBe('native-build-return');
    expect(observer.snapshot().dropped).toBe(46);
    observer.endCapture(nonce);
    expect(observer.snapshot().dropped).toBe(46);
  });

  it('retains one hundred feature checks beyond the diagnostic ring and retires only delivered acknowledgements', () => {
    const journal = createRuntimePhaseJournal<{ readonly seq: number; readonly generation: number }>();
    journal.begin(nonce, 20);
    for (let seq = 21; seq <= 621; seq++) journal.record(Object.freeze({ seq, generation: 3 }));
    const first = journal.read(nonce, null);
    expect(first.records).toHaveLength(601);
    expect(first.dropped).toBe(0);
    expect(journal.read(nonce, null)).toEqual(first);
    expect(() => journal.read(nonce, 622)).toThrow('Unreceived');
    expect(journal.read(nonce, 620).records.map(row => row.seq)).toEqual([621]);
    expect(first.records).toHaveLength(601);
    expect(Object.isFrozen(first.records)).toBe(true);
    journal.end(nonce);
    expect(() => journal.read(nonce, null)).toThrow('owner');
  });

  it('preserves overflow after acknowledgement and refuses a missing sequence', () => {
    const journal = createRuntimePhaseJournal<{ readonly seq: number }>(2);
    journal.begin(nonce, 0);
    journal.record({ seq: 1 }); journal.record({ seq: 2 }); journal.record({ seq: 3 });
    expect(journal.read(nonce, null)).toMatchObject({ dropped: 1, lastSeq: 3 });
    expect(() => journal.read(nonce, 3)).toThrow('Unreceived');
    journal.read(nonce, 2); journal.record({ seq: 5 });
    expect(journal.read(nonce, 2)).toMatchObject({ dropped: 2, records: [{ seq: 5 }] });
  });

  it('does not permit another owner to replace, read or end a live capture', () => {
    const journal = createRuntimePhaseJournal<{ readonly seq: number }>();
    journal.record({ seq: 8 });
    journal.begin(nonce, 8);
    expect(() => journal.begin('another-capture-1234', 8)).toThrow('already active');
    expect(() => journal.read('another-capture-1234', null)).toThrow('owner');
    expect(() => journal.end('another-capture-1234')).toThrow('owner');
    expect(journal.read(nonce, null)).toMatchObject({ startedAfter: 8, lastSeq: 8, records: [] });
  });
});
