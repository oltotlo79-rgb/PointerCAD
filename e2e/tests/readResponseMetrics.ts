import type { ReadInput, ReadObservation, ReadSpan } from './readResponseObservation.js';

/** Replay observed key/input/reset/paint order, independently of the final DOM value. */
export function readCommandTimeline(span: ReadSpan, inputs: readonly ReadInput[], resets: ReadObservation['resets']) {
  const failures: string[] = [];
  const events: { at: number; order: number; phase: string; index: number; value: unknown; before?: unknown }[] = [];
  const order = (input: ReadInput, key: string): number => {
    const value: unknown = Reflect.get(input, key);
    return typeof value === 'number' ? value : 0;
  };
  const rows = inputs.filter(input => Reflect.get(input, 'readId') === span.id);
  const resetRows = resets.filter(reset => reset.readId === span.id);
  const expectations = rows.map(input => {
    const keyAt: unknown = Reflect.get(input, 'keydownObservedAt') ?? input.at;
    const inputAt: unknown = Reflect.get(input, 'inputObservedAt') ?? Reflect.get(input, 'inputAt');
    const expected: unknown = Reflect.get(input, 'expectedValue');
    return { keyAt, inputAt, expected: typeof keyAt === 'number' && typeof inputAt === 'number'
      && resetRows.some(reset => (reset.at > keyAt || (reset.at === keyAt && (reset.order ?? 0) > order(input, 'keydownOrder')))
        && (reset.at < inputAt || (reset.at === inputAt && (reset.order ?? 0) <= order(input, 'inputOrder')))) ? 'a' : expected };
  });
  rows.forEach((input, index) => {
    const { keyAt, inputAt } = expectations[index];
    if (!input.trusted || typeof keyAt !== 'number' || !Number.isFinite(keyAt) || keyAt < input.at
      || typeof inputAt !== 'number' || !Number.isFinite(inputAt) || inputAt < keyAt
      || input.paintedAt === null || !Number.isFinite(input.paintedAt) || input.paintedAt < inputAt) {
      failures.push(`input ${index}: incomplete or invalid event order`); return;
    }
    events.push({ at: keyAt, order: order(input, 'keydownOrder'), phase: 'key', index, value: Reflect.get(input, 'beforeValue') },
      { at: inputAt, order: order(input, 'inputOrder'), phase: 'input', index, value: Reflect.get(input, 'value') },
      { at: input.paintedAt, order: order(input, 'paintOrder'), phase: 'paint', index, value: Reflect.get(input, 'paintedValue') });
  });
  resetRows.forEach(reset => {
    if (span.end === null || !Number.isFinite(reset.at) || reset.at < span.end || reset.value !== '') {
      failures.push('reset precedes Worker end or is invalid');
    }
    events.push({ at: reset.at, order: reset.order ?? 0, phase: 'reset', index: -1, value: reset.value, before: reset.beforeValue });
  });
  let expectedFinalValue = '';
  for (const event of events.sort((a, b) => a.at - b.at || a.order - b.order)) {
    if (event.phase === 'reset') {
      if (event.before !== expectedFinalValue) failures.push('reset beforeValue mismatch');
      expectedFinalValue = '';
    } else if (event.phase === 'input') {
      const expected = expectations[event.index].expected;
      if (typeof expected !== 'string' || event.value !== expected) failures.push(`input ${event.index}: value mismatch`);
      if (typeof expected === 'string') expectedFinalValue = expected;
    } else if (event.value !== expectedFinalValue) failures.push(`input ${event.index}: ${event.phase} value mismatch`);
  }
  if (span.end === null || !Number.isFinite(span.end)) failures.push('Worker end missing');
  // If the draft stayed empty throughout the Worker, React need not write value=''.
  // A first key delivered after that boundary needs no invented reset event.
  const emptyThroughWorkerEnd = span.end !== null && expectations.every(row => typeof row.keyAt === 'number' && row.keyAt >= (span.end ?? Infinity));
  if (resetRows.length > 1 || (rows.length > 0 && resetRows.length === 0 && !emptyThroughWorkerEnd)) failures.push('one observed document reset required');
  return { readId: span.id, expectedFinalValue, failures, events, expectations, emptyThroughWorkerEnd };
}

export function readInputMetrics(span: ReadSpan | undefined, inputs: readonly ReadInput[],
  trips: readonly { readonly start: number; readonly end: number; readonly ms: number; readonly readId?: string | null }[],
  offset: { readonly lower: number; readonly upper: number },
  spans: readonly ReadSpan[] = span === undefined ? [] : [span], resets?: ReadObservation['resets']) {
  const timelines = new Map(spans.map(candidate => [candidate.id,
    resets === undefined ? null : readCommandTimeline(candidate, inputs, resets)]));
  const decisions = inputs.map((input, index) => {
    const trip = trips[index];
    const id: unknown = Reflect.get(input, 'readId');
    const matches = spans.filter(candidate => candidate.id === id);
    const actual = matches.length === 1 ? matches[0] : undefined;
    let reason = 'accepted';
    if (!input.trusted) reason = 'untrusted-event';
    else if (trip === undefined) reason = 'missing-roundtrip';
    else if (typeof id !== 'string' || id !== trip.readId || actual === undefined) reason = 'read-id-mismatch-or-missing';
    else if (actual.end === null) reason = 'worker-end-missing';
    else if (![actual.start, actual.end, input.at, trip.start, trip.end, trip.ms, offset.lower, offset.upper].every(Number.isFinite)
      || offset.lower > offset.upper || actual.end <= actual.start || trip.end < trip.start || trip.ms < 0
      || Math.abs(trip.ms - (trip.end - trip.start)) > 0.001) reason = 'invalid-clock-or-duration';
    else if (input.at < actual.start || input.at >= actual.end) reason = 'event-start-outside-worker';
    // Bound the start only. A slow response/paint crossing actual.end still counts.
    else if (trip.start + offset.lower < actual.start || trip.start + offset.upper >= actual.end
      || input.at < trip.start + offset.lower || input.at > trip.end + offset.upper) reason = 'uncertain-clock-boundary';
    else if (input.paintedAt === null || !Number.isFinite(input.paintedAt) || input.paintedAt < input.at) reason = 'paint-missing-or-invalid';
    const beforeValue: unknown = Reflect.get(input, 'beforeValue'), expectedValue: unknown = Reflect.get(input, 'expectedValue');
    const value: unknown = Reflect.get(input, 'value'), inputAt: unknown = Reflect.get(input, 'inputAt');
    const paintedValue: unknown = Reflect.get(input, 'paintedValue');
    const timeline = actual === undefined ? null : timelines.get(actual.id) ?? null;
    const timelineIndex = inputs.slice(0, index).filter(row => Reflect.get(row, 'readId') === id).length;
    const expectedAtInput = timeline?.expectations[timelineIndex]?.expected ?? expectedValue;
    const paintDisposition = timeline !== null ? (timeline.failures.length ? 'unexplained' : 'observed-timeline') : paintedValue === value ? 'input-value'
      : paintedValue === '' && actual?.end !== null && actual?.end !== undefined
        && input.paintedAt !== null && input.paintedAt >= actual.end ? 'document-reset'
        : inputs.some((later, laterIndex) => laterIndex > index && Reflect.get(later, 'readId') === id
          && Reflect.get(later, 'value') === paintedValue && typeof Reflect.get(later, 'inputAt') === 'number'
          && Reflect.get(later, 'inputAt') <= (input.paintedAt ?? -Infinity)) ? 'later-input-value' : 'unexplained';
    const valueFailure = typeof beforeValue !== 'string' || typeof expectedValue !== 'string'
      || typeof value !== 'string' || typeof inputAt !== 'number' || !Number.isFinite(inputAt) || inputAt < input.at
      || input.paintedAt === null || inputAt > input.paintedAt
      ? 'missing-input-value' : value !== expectedAtInput || (value === beforeValue && expectedAtInput === expectedValue) ? 'input-value-mismatch'
        : typeof paintedValue !== 'string' ? 'missing-painted-value'
          : paintDisposition === 'unexplained' ? 'unexpected-painted-value' : null;
    // Value evidence is independent of timing: do not discard a slow sample to hide a bad value.
    return { index, readId: typeof id === 'string' ? id : null, reason, valueFailure, paintDisposition, input, trip,
      crossesWorkerEnd: actual?.end !== null && actual?.end !== undefined && input.paintedAt !== null
        && (input.paintedAt >= actual.end || (trip !== undefined && trip.end + offset.upper >= actual.end)) };
  });
  const active = decisions.filter(row => row.reason === 'accepted');
  const samples = active.map(({ input, trip }) => Math.max((input.paintedAt ?? Infinity) - input.at, trip?.ms ?? Infinity)).sort((a, b) => a - b);
  const incomplete = decisions.filter(row => row.valueFailure !== null
    || (row.reason !== 'event-start-outside-worker' && row.reason !== 'uncertain-clock-boundary' && row.reason !== 'accepted'));
  return { active, samples, decisions, incomplete, p95: samples.length >= 100 ? samples[Math.ceil(samples.length * 0.95) - 1] : null };
}
