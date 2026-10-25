export interface RuntimePhaseJournalSnapshot<T> {
  readonly nonce: string;
  readonly capacity: number;
  readonly startedAfter: number;
  readonly acknowledgedThrough: number;
  readonly lastSeq: number;
  readonly dropped: number;
  readonly records: readonly T[];
}

/** Optional, finite metadata capture. The diagnostic ring remains independent.
 * Reading does not acknowledge delivery: only the next explicit cursor can retire
 * records that the caller has actually received. Overflow remains irreversible. */
export function createRuntimePhaseJournal<T extends { readonly seq: number }>(capacity = 4096) {
  if (!Number.isSafeInteger(capacity) || capacity < 1) throw new RangeError('Invalid journal capacity');
  let capture: { nonce: string; startedAfter: number; acknowledgedThrough: number;
    deliveredThrough: number; lastSeq: number; dropped: number; records: T[] } | null = null;
  return {
    begin(nonce: string, lastSeq: number): void {
      if (!/^[a-zA-Z0-9_-]{16,128}$/u.test(nonce) || !Number.isSafeInteger(lastSeq) || lastSeq < 0)
        throw new RangeError('Invalid phase capture identity');
      if (capture !== null) throw new Error('A phase capture is already active');
      capture = { nonce, startedAfter: lastSeq, acknowledgedThrough: lastSeq,
        deliveredThrough: lastSeq, lastSeq, dropped: 0, records: [] };
    },
    record(value: T): void {
      if (capture === null) return;
      if (value.seq !== capture.lastSeq + 1) capture.dropped += 1;
      capture.lastSeq = value.seq;
      if (capture.records.length >= capacity) { capture.dropped += 1; return; }
      capture.records.push(value);
    },
    read(nonce: string, acknowledge: number | null): RuntimePhaseJournalSnapshot<T> {
      if (capture === null || nonce !== capture.nonce) throw new Error('Phase capture owner differs');
      if (acknowledge !== null) {
        if (!Number.isSafeInteger(acknowledge) || acknowledge < capture.acknowledgedThrough
          || acknowledge > capture.deliveredThrough) throw new RangeError('Unreceived phase acknowledgement');
        capture.records = capture.records.filter(record => record.seq > acknowledge);
        capture.acknowledgedThrough = acknowledge;
      }
      capture.deliveredThrough = capture.records.at(-1)?.seq ?? capture.acknowledgedThrough;
      return Object.freeze({ nonce, capacity, startedAfter: capture.startedAfter,
        acknowledgedThrough: capture.acknowledgedThrough, lastSeq: capture.lastSeq,
        dropped: capture.dropped, records: Object.freeze([...capture.records]) });
    },
    end(nonce: string): void {
      if (capture === null || nonce !== capture.nonce) throw new Error('Phase capture owner differs');
      capture = null;
    },
  };
}
