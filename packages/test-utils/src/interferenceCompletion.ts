interface InterferenceCompletion {
  readonly completed: boolean;
  readonly error: string | null;
}

/** A progress notification or a completed subset cannot prove the requested runs succeeded. */
export function requireCompletedInterferenceRuns(runs: readonly InterferenceCompletion[], expected: number): void {
  if (!Number.isSafeInteger(expected) || expected < 1 || runs.length !== expected) {
    throw new Error(`Interference requires exactly ${String(expected)} runs; received ${String(runs.length)}`);
  }
  for (let index = 0; index < runs.length; index += 1) {
    const run = runs[index];
    if (run.completed !== true || run.error !== null) {
      throw new Error(`Interference run ${String(index + 1)} did not complete successfully: ${run.error ?? 'unfinished'}`);
    }
  }
}
