import assert from 'node:assert/strict';
import type { BeamAnalysisDocument } from './analysisModel.js';
import type { FemClient } from './client.js';
import { modalFixture } from './modal.testSupport.js';
import type { BeamTransientInput } from './transientModel.js';
import { TRANSIENT_WORK_LIMIT } from './transientTranslation.js';
import { cantileverPulse, transientHistory } from './transient.testSupport.js';

/** Bounded cost/accuracy benchmark for Root (never part of the default unit run). It measures; it promises nothing.
 *
 * Three admissible extremes of the provisional bound stepCount x freeDofs^2 <= 4e8, each with the real Worker,
 * candidate wrapper and frozen runtime: 384 free DOFs x 2712 steps, 744 free DOFs x 722 steps (125 of the 128
 * mesh nodes) and 24 free DOFs x 4000 steps. Every case must complete through the existing client with
 * equilibrium and energy measures <= 1e-8 (the same gates as production, unchanged). Recorded per case: the
 * measured solving-phase and total milliseconds, the work product and both measures.
 *
 * Decision rule, fixed before execution: if the slowest solving phase is <= 30 s (half of the 60 s solve
 * deadline), 4e8 is retained; otherwise Root replaces it in both languages by floor(4e8 x 30 s / slowest)
 * and reruns. Accepted step counts, sample counts, mesh size and tolerances are never reduced to pass.
 */
export const TRANSIENT_BENCHMARK_HEADROOM_MS = 30_000;

function chain(segments: number): BeamAnalysisDocument {
  const base = modalFixture({ free: true, modes: 1, segments });
  const nodes = [0, 1, 2, 3, 4].map(index => ({ id: `node-${index}`, position: [index / 4, 0, 0] as [number, number, number] }));
  return { ...base, nodes, members: nodes.slice(1).map((node, index) => ({ ...base.members[0], id: `member-${index}`,
    componentId: `component-${index}`, occurrencePath: [`component-${index}`], startNodeId: nodes[index].id, endNodeId: node.id })) };
}

export function transientBenchmarkCases(): readonly { readonly name: string; readonly freeDofs: number; readonly input: BeamTransientInput }[] {
  const clamp = { nodeId: 'node-0', restrained: [true, true, true, true, true, true] as const };
  const tipLoad = (nodeId: string) => [{ id: 'tip', kind: 'nodal' as const, nodeId, force: [0, 10, 5] as [number, number, number],
    moment: [0.5, 0, 0] as [number, number, number] }];
  const make = (geometry: BeamAnalysisDocument, tip: string, steps: number): BeamTransientInput => ({
    schema: 'pointercad-beam-transient/1', geometry, supports: [clamp], referenceLoads: tipLoad(tip),
    history: transientHistory(1e-4, steps, [[0, 0], [Math.ceil(steps / 10), 1], [steps, 1]], Math.ceil(steps / 100)) });
  const split = modalFixture({ free: true, modes: 1, segments: 32, split: true });
  const steps = (dofs: number): number => Math.floor(TRANSIENT_WORK_LIMIT / (dofs * dofs));
  return [
    { name: 'split-65-nodes-384-dofs', freeDofs: 384, input: make(split, 'node-2', steps(384)) },
    { name: 'chain-125-nodes-744-dofs', freeDofs: 744, input: make(chain(31), 'node-4', steps(744)) },
    { name: 'cantilever-24-dofs-4000-steps', freeDofs: 24,
      input: cantileverPulse(transientHistory(1e-4, 4000, [[0, 0], [400, 1], [4000, 1]], 40)) },
  ];
}

export async function runTransientBenchmark(client: FemClient, record: (value: unknown) => Promise<void>,
  now: () => number = () => performance.now()): Promise<number> {
  let slowest = 0;
  for (const benchmark of transientBenchmarkCases()) {
    const started = now();
    const timing: { solving: number | null } = { solving: null };
    const completion = await client.analyzeTransient(benchmark.input, {
      onPhase: phase => { if (phase === 'solving' && timing.solving === null) timing.solving = now(); } });
    const finished = now();
    const solvingMs = timing.solving === null ? null : finished - timing.solving;
    const work = benchmark.input.history.stepCount * benchmark.freeDofs ** 2;
    await record({ name: benchmark.name, work, totalMs: finished - started, solvingMs, completion });
    assert.equal(completion.kind, 'result', `${benchmark.name}: ${JSON.stringify(completion)}`);
    if (completion.kind !== 'result' || solvingMs === null) throw new Error(`${benchmark.name}: no measured solve`);
    assert.equal(completion.result.freeDofs, benchmark.freeDofs);
    assert(work <= TRANSIENT_WORK_LIMIT);
    assert(completion.result.maximumEquilibriumResidual <= 1e-8 && completion.result.maximumEnergyBalanceError <= 1e-8);
    slowest = Math.max(slowest, solvingMs);
  }
  await record({ name: 'decision', slowestSolvingMs: slowest, headroomMs: TRANSIENT_BENCHMARK_HEADROOM_MS,
    retainLimit: slowest <= TRANSIENT_BENCHMARK_HEADROOM_MS,
    replacementLimit: Math.floor(TRANSIENT_WORK_LIMIT * Math.min(1, TRANSIENT_BENCHMARK_HEADROOM_MS / slowest)) });
  return slowest;
}
