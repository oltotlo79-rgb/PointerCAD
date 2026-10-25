/** 文書の寿命に沿って部品を再計算し、配置と共有形状をストアへ渡す。 */
import {
  appearanceOf, buildStandardPartFromSource, diagnoseMatesSteps, jointFramePairFromTargets,
  KERNEL_BROKEN_MESSAGE, partKeyOf,
  resolveAssembly, resolveConstrainedAssembly,
  resolveMateTarget, createSubShapeReferenceResolver, solveMatesSteps, runCooperative,
  type AssemblyDocument, type AssemblyKernelBridge, type ComponentSource, type EmbeddedPartAttachments, type PartDocument, type PartLibrary, type SolveMatesOutcome,
  type JointFramePair, type MateDiagnosis, type MateResidualTargetPair, type MateTarget,
  type PartRecomputeResult, type CooperativeResult, type CooperativeRun, type CooperativeSchedule, type RigidWorkBudget, type RigidWorkPoint,
  type ResolveAssemblyOptions, type ResolvedAssembly, type ResolvedPart, type RigidPlacement, type SolidBody,
} from '@pointercad/model';
import { buildAppearanceInput } from '../appearance/appearanceCommands.js';
import { t } from '../i18n/t.js';
import type { AssemblySnapshot } from '../store/assemblySlice.js';
import { captureMeshBodyLayout } from '../store/recomputeSlice.js';
import { assemblyUiBackings, currentAssemblyMeshPublication, type AssemblyMeshOwnership, type AssemblySourceMeshOwner } from '../viewport/assemblyMeshAdmission.js';
import { LOCAL_DISPLAY_MESH_BUDGET, type PartRecomputer } from '../store/attachKernel.js';
import { activeDocument } from '../store/documentKind.js';
import { useAppStore } from '../store/useAppStore.js';
import { jointOccurrenceInputsOf } from '../viewport/pickJointOccurrence.js';
import { recomputePartWithMath as recomputePart } from '../math/recomputePartWithMath.js';
import type { AppearanceInput } from '../viewport/buildSolidGeometry.js';
import type { AssemblyReplacementRunner } from './replaceCommands.js';

/** Diagnostic metadata only: not native/GPU/high-water acceptance evidence. */
export interface AssemblyGateEvent {
  readonly seq: number;
  readonly attachment: number;
  readonly documentId: string;
  readonly version: number;
  readonly generation: number;
  readonly stage: string;
  readonly reason: string | null;
  readonly count: number | null;
}
const assemblyGateEvents: AssemblyGateEvent[] = [];
let assemblyGateSequence = 0, assemblyGateAttachment = 0;
let assemblyGateDropped = 0, assemblyGateObserverFailures = 0;
export function readAssemblyRecomputeGates() {
  return Object.freeze({ events: Object.freeze(assemblyGateEvents.slice()),
    dropped: assemblyGateDropped, observerFailures: assemblyGateObserverFailures,
    status: assemblyGateDropped === 0 && assemblyGateObserverFailures === 0 ? 'observed' : 'unknown',
    coverage: 'bounded-assembly-recompute-gates-only', acceptanceComplete: false });
}
/**
 * Diagnostic metadata only (EX12 W02): wall-clock milliseconds of the sections of each assembly recompute (release of
 * the previous document, part recompute loop and its kernel/availability round trips, resolve, constraints,
 * publication). Bounded; never a gate, an acceptance or a native/GPU reading.
 */
export interface AssemblyLoadTiming {
  readonly seq: number;
  readonly attachment: number;
  readonly documentId: string;
  readonly generation: number;
  readonly outcome: string;
  readonly parts: number;
  readonly recomputed: number;
  /** Kernel shape cache hits summed over the parts of this recompute. */
  readonly cacheHits: number;
  /** The first kernel round trip of this recompute (it includes a first OCCT load of the Worker). */
  readonly firstKernelMs: number;
  readonly releaseMs: number;
  readonly partsMs: number;
  readonly recomputeMs: number;
  readonly kernelMs: number;
  readonly availabilityMs: number;
  readonly resolveMs: number;
  readonly constraintsMs: number;
  readonly publicationMs: number;
  readonly totalMs: number;
}
type AssemblyLoadTimingDraft = { -readonly [Key in Exclude<keyof AssemblyLoadTiming, 'seq' | 'attachment' | 'documentId' | 'generation' | 'totalMs'>]: AssemblyLoadTiming[Key] };
const assemblyLoadTimings: AssemblyLoadTiming[] = [];
let assemblyLoadTimingSequence = 0;
/** The recompute still running, so a reader sees how far a long one got (a copy; never the live draft). */
let inFlightLoadTiming: { readonly draft: AssemblyLoadTimingDraft; readonly startedAt: number } | null = null;
export function readAssemblyLoadTimings() {
  const running = inFlightLoadTiming;
  return Object.freeze({ timings: Object.freeze(assemblyLoadTimings.slice()),
    inFlight: running === null ? null : Object.freeze({ ...running.draft, elapsedMs: performance.now() - running.startedAt }),
    coverage: 'assembly-recompute-sections-only', acceptanceComplete: false });
}
declare global {
  interface Window {
    pcadAssemblyRecomputeGates?: typeof readAssemblyRecomputeGates;
    pcadAssemblyLoadTimings?: typeof readAssemblyLoadTimings;
  }
}

interface Request extends AssemblySnapshot {
  readonly documentId: string;
  readonly version: number;
  readonly generation: number;
  readonly cancelBaseline: number;
}

interface CachedPart {
  readonly document: PartDocument;
  readonly attachments: EmbeddedPartAttachments | undefined;
  readonly resolved: ResolvedPart;
  readonly result: PartRecomputeResult;
  readonly appearances: AppearanceInput;
  readonly sourceOwner: AssemblySourceMeshOwner;
  readonly resources: AssemblyPartResources;
}

type PartClaim = NonNullable<ReturnType<NonNullable<AssemblyKernelBridge['capturePartReleaseClaim']>>>;
interface AssemblyPartResources {
  readonly bridge: AssemblyKernelBridge;
  readonly ref: string;
  readonly attachment: object;
  claim: PartClaim | null;
  scope: PartRecomputeResult['referenceMeshScope'];
  partDispatched: boolean;
  retired: boolean;
  cleanup: Promise<boolean> | null;
}
const assemblyPartResources = new WeakMap<AssemblyKernelBridge, Map<string, AssemblyPartResources>>();
const retiredAssemblyResources = new Set<AssemblyPartResources>();
let assemblyCleanupTimer: ReturnType<typeof setTimeout> | null = null;

async function returnAssemblyPart(owner: AssemblyPartResources): Promise<boolean> {
  if (owner.cleanup !== null) return owner.cleanup;
  owner.cleanup = (async () => {
    let scopeReturned = owner.scope === undefined;
    try { if (owner.scope !== undefined) scopeReturned = await owner.scope.close(); } catch { /* Actual scope remains reachable. */ }
    let partReturned = !owner.partDispatched;
    if (owner.claim !== null) {
      try {
        const result = await owner.bridge.releasePartClaim?.(owner.claim);
        partReturned = result?.status === 'released' || result?.status === 'absent' || result?.status === 'closed';
      } catch { /* Exact claim retained; no legacy void proof. */ }
    }
    if (scopeReturned) owner.scope = undefined;
    if (partReturned) { owner.claim = null; owner.partDispatched = false; }
    if (!scopeReturned || !partReturned) return false;
    const claims = assemblyPartResources.get(owner.bridge);
    if (claims?.get(owner.ref) === owner) claims.delete(owner.ref);
    retiredAssemblyResources.delete(owner);
    return true;
  })().finally(() => { owner.cleanup = null; });
  return owner.cleanup;
}

function scheduleAssemblyCleanup(): void {
  if (assemblyCleanupTimer !== null || retiredAssemblyResources.size === 0) return;
  assemblyCleanupTimer = setTimeout(() => {
    assemblyCleanupTimer = null;
    void Promise.all([...retiredAssemblyResources].map(returnAssemblyPart)).catch(() => undefined);
  }, 100);
}

async function retireAssemblyPart(owner: AssemblyPartResources): Promise<boolean> {
  owner.retired = true; retiredAssemblyResources.add(owner);
  const returned = await returnAssemblyPart(owner);
  if (!returned) scheduleAssemblyCleanup();
  return returned;
}

type StandardPartSource = Extract<ComponentSource, { readonly kind: 'standardPart' }>;

/** ルートと全サブアセンブリから、実際に形を作る部品参照を重複なく集める。 */
export function collectAssemblyPartSources(
  document: AssemblyDocument,
  library: PartLibrary,
): {
  readonly references: ReadonlySet<string>;
  readonly standardSources: ReadonlyMap<string, StandardPartSource>;
} {
  const references = new Set<string>();
  const standardSources = new Map<string, StandardPartSource>();
  const visitedAssemblies = new Set<string>();

  const visit = (assembly: AssemblyDocument): void => {
    for (const component of assembly.components) {
      if (component.suppressed) continue;
      if (component.source.kind === 'subAssembly') {
        const ref = component.source.assemblyRef;
        if (visitedAssemblies.has(ref)) continue;
        visitedAssemblies.add(ref);
        const nested = library.assemblies?.get(ref);
        if (nested !== undefined) visit(nested);
        continue;
      }
      const key = partKeyOf(component.source);
      references.add(key);
      if (component.source.kind === 'standardPart') standardSources.set(key, component.source);
    }
  };

  visit(document);
  return { references, standardSources };
}

/**
 * 解いた親の配置の中で、各子の組の合致・ジョイントを既存の階層の解き方(resolveConstrainedAssembly)で解き直す。
 * 解けない子は、解いた親の配置へ置き直すだけにして(文書は変えない)、どの配置の組かを添えた理由を返す。
 * 元の入れ子は解く前の親の配置で合成されているので、そのまま公開すると子が古い位置に描かれ、選べなくなる。
 */
async function solveChildOccurrences(document: AssemblyDocument, resolved: ResolvedAssembly,
  bodies: ReadonlyMap<string, readonly SolidBody[]>, options: ResolveAssemblyOptions,
  execute: <T>(steps: Generator<RigidWorkPoint, T, void>) => Promise<CooperativeResult<T>>, budget: RigidWorkBudget,
): Promise<{ readonly resolved: ResolvedAssembly; readonly messages: readonly string[] } | null> {
  const nestedEntries = resolved.subAssemblies;
  if (nestedEntries === undefined || nestedEntries.size === 0 || resolved.errors.length > 0) return { resolved, messages: [] };
  const subAssemblies = new Map(nestedEntries);
  const messages: string[] = [];
  for (const [id, nested] of nestedEntries) {
    const parent = resolved.placements.get(id);
    if (parent === undefined) continue;
    const childOptions = { ...options, parent, depth: 1, ancestors: [nested.assemblyRef] };
    const result = await execute(resolveConstrainedAssembly(nested.assembly, bodies, childOptions, budget));
    if (result.status === 'cancelled') return null;
    const solved = result.value;
    if (solved.ok) {
      subAssemblies.set(id, { ...nested, placement: parent, resolved: solved.resolved });
      continue;
    }
    subAssemblies.set(id, { ...nested, placement: parent, resolved: resolveAssembly(nested.assembly, childOptions) });
    const name = document.components.find((component) => component.id === id)?.name ?? id;
    const reasons = solved.messages.length > 0 ? solved.messages : [t('assembly.mate.incomplete')];
    messages.push(...reasons.map((reason) => `${name}: ${reason}`));
  }
  return { resolved: { ...resolved, subAssemblies }, messages };
}

/** 成立した独立成分だけ更新する。固定部品・新規部品の文書配置を古い解で上書きしない。 */
export function retainSuccessfulPlacements(
  document: AssemblyDocument, outcome: SolveMatesOutcome,
  initial: ReadonlyMap<string, RigidPlacement>, lastGood: Map<string, RigidPlacement>,
): ReadonlyMap<string, RigidPlacement> {
  const fixed = new Set(document.components.filter((component) => component.fixed).map((component) => component.id));
  const failed = new Set(outcome.diagnosis.components.filter((component) => component.status !== 'converged').flatMap((component) => component.componentIds));
  const badMates = new Set([...outcome.skipped.map((item) => item.mateId), ...outcome.branchViolations, ...outcome.diagnosis.constantConflicts]);
  const active = document.mates.filter((mate) => !mate.suppressed);
  for (const mate of active) if (badMates.has(mate.id)) {
    if (!fixed.has(mate.a.componentId)) failed.add(mate.a.componentId);
    if (!fixed.has(mate.b.componentId)) failed.add(mate.b.componentId);
  }
  // 未解決の合致でsolverが分割した場合も、同じ可動成分の途中結果を採用しない。
  let expanded = true;
  while (expanded) {
    expanded = false;
    for (const mate of active) {
      if (fixed.has(mate.a.componentId) || fixed.has(mate.b.componentId)) continue;
      if (failed.has(mate.a.componentId) !== failed.has(mate.b.componentId)) {
        failed.add(mate.a.componentId); failed.add(mate.b.componentId); expanded = true;
      }
    }
  }
  for (const id of lastGood.keys()) if (!initial.has(id)) lastGood.delete(id);
  const placements = new Map<string, RigidPlacement>();
  for (const [id, original] of initial) {
    const successful = fixed.has(id) || !failed.has(id);
    const placement = fixed.has(id) ? original : successful
      ? outcome.placements.get(id) ?? original : lastGood.get(id) ?? original;
    placements.set(id, placement);
    if (successful) lastGood.set(id, placement);
  }
  return placements;
}

/** Same units as joint drive. Scheduling is replaceable for checkpoint tests; the model solve is always real. */
export interface AssemblyConstraintExecution extends CooperativeSchedule {
  readonly budget: RigidWorkBudget;
  /** Counted work, not a percentage; monotone across the whole initial solve, diagnosis and child occurrences. */
  readonly onProgress?: (done: number) => void;
}
export const ASSEMBLY_CONSTRAINT_EXECUTION: AssemblyConstraintExecution = {
  budget: { units: 4096 }, pointsPerSlice: 16,
  schedule: slice => { setTimeout(slice, 0); },
};

/** 部品再計算だけは検査用に差し替えられる。合致は常にmodelの実solverを使う。 */
export function attachAssembly(
  bridge: AssemblyKernelBridge,
  recompute?: PartRecomputer,
  observeGate?: (event: AssemblyGateEvent) => void,
  constraints: AssemblyConstraintExecution = ASSEMBLY_CONSTRAINT_EXECUTION,
): () => void {
  const attachment = ++assemblyGateAttachment;
  const gate = (request: Request, stage: string, reason: string | null = null, count: number | null = null): void => {
    try {
      if (!Number.isSafeInteger(attachment) || !Number.isSafeInteger(assemblyGateSequence + 1)) {
        assemblyGateObserverFailures += 1; return;
      }
      const event = Object.freeze({ seq: ++assemblyGateSequence, attachment,
        documentId: request.documentId.slice(0, 256), version: request.version, generation: request.generation,
        stage, reason: reason?.slice(0, 256) ?? null, count });
      if (request.documentId.length > 256 || reason !== null && reason.length > 256) assemblyGateObserverFailures += 1;
      if (assemblyGateEvents.length === 128) { assemblyGateEvents.shift(); assemblyGateDropped += 1; }
      assemblyGateEvents.push(event);
      try { observeGate?.(event); } catch { assemblyGateObserverFailures += 1; }
    } catch { assemblyGateObserverFailures += 1; }
  };
  if (typeof window !== 'undefined') {
    try { window.pcadAssemblyRecomputeGates = readAssemblyRecomputeGates; window.pcadAssemblyLoadTimings = readAssemblyLoadTimings; }
    catch { assemblyGateObserverFailures += 1; }
  }
  const recordLoadTiming = (request: Request, draft: AssemblyLoadTimingDraft, totalMs: number): void => {
    try {
      if (!Number.isSafeInteger(assemblyLoadTimingSequence + 1)) return;
      if (assemblyLoadTimings.length === 32) assemblyLoadTimings.shift();
      assemblyLoadTimings.push(Object.freeze({ seq: ++assemblyLoadTimingSequence, attachment,
        documentId: request.documentId.slice(0, 256), generation: request.generation, ...draft, totalMs }));
    } catch { /* Diagnostic timing never changes recomputation or publication. */ }
  };
  function refuse(request: Request, stage: string, reason: string): never {
    gate(request, stage, reason); throw new Error(reason);
  }
  let detached = false;
  let running = false;
  let latest: Request | null = null;
  let queued: Request | null = null;
  let documentId: string | null = null;
  let constraintRun: CooperativeRun<unknown> | null = null;
  const cache = new Map<string, CachedPart>();
  const standardDocuments = new Map<string, PartDocument>();
  const retained = new Map<string, AssemblyPartResources>();
  const attachmentOwner = {};
  const claims = assemblyPartResources.get(bridge) ?? new Map<string, AssemblyPartResources>();
  assemblyPartResources.set(bridge, claims);

  async function acquire(ref: string): Promise<AssemblyPartResources> {
    const previous = claims.get(ref);
    if (previous !== undefined) {
      if (previous.attachment === attachmentOwner && !previous.retired) return previous;
      if (!previous.retired || !(await returnAssemblyPart(previous))) throw new Error(t('assembly.recomputeFailed'));
    }
    const owner: AssemblyPartResources = { bridge, ref, attachment: attachmentOwner, claim: null,
      scope: undefined, partDispatched: false, retired: false, cleanup: null };
    claims.set(ref, owner); retained.set(ref, owner);
    return owner;
  }

  async function recomputeOwned(document: PartDocument, options: Parameters<PartRecomputer>[1], owner: AssemblyPartResources,
    timing?: AssemblyLoadTimingDraft): Promise<PartRecomputeResult> {
    const actualBridge: AssemblyKernelBridge = { ...bridge, async recomputeSolids(steps, solidOptions) {
      owner.partDispatched = true;
      const kernelStartedAt = performance.now();
      const outcome = await bridge.recomputeSolids(steps, solidOptions);
      if (timing !== undefined) {
        const kernelMs = performance.now() - kernelStartedAt;
        if (timing.kernelMs === 0) timing.firstKernelMs = kernelMs;
        timing.kernelMs += kernelMs;
      }
      owner.claim = bridge.capturePartReleaseClaim?.(outcome.bodies) ?? null;
      return outcome;
    } };
    const displayOptions = { ...options, localMesh: { ...LOCAL_DISPLAY_MESH_BUDGET } };
    const result = await (recompute === undefined ? recomputePart(document, actualBridge, displayOptions) : recompute(document, displayOptions));
    owner.scope = result.referenceMeshScope;
    const claim = bridge.capturePartReleaseClaim?.(result.bodies);
    if (claim !== undefined && claim !== null) { owner.claim = claim; owner.partDispatched = true; }
    return result;
  }
  let lastGoodPlacements = new Map<string, RigidPlacement>();
  const replacementRunner: AssemblyReplacementRunner = {
    resolve: async (document, attachments, requestId) => {
      const partId = `replacement:${requestId}`;
      const owner = await acquire(partId);
      try {
        const result = await recomputeOwned(document, {
          partId,
          importedShapes: attachments.shapes,
          shouldCancel: () => detached,
        }, owner);
        return result.bodies;
      } finally {
        retained.delete(partId); await retireAssemblyPart(owner);
      }
    },
  };
  useAppStore.getState().setAssemblyReplacementRunner(replacementRunner);

  async function release(ref: string): Promise<void> {
    const owner = retained.get(ref);
    cache.delete(ref); standardDocuments.delete(ref);
    if (owner !== undefined) {
      const returned = await retireAssemblyPart(owner);
      if (returned) retained.delete(ref);
    }
  }

  async function releaseAll(): Promise<void> {
    await Promise.all([...retained.keys()].map(release));
    cache.clear();
  }

  function obsolete(request: Request): boolean {
    const state = useAppStore.getState();
    return detached || latest !== request || state.assembly !== request.document
      || state.assemblyLibrary !== request.library || state.activeDocumentId !== request.documentId
      || state.documentVersion !== request.version || state.requestedGeneration !== request.generation
      || state.cancelRequestCount !== request.cancelBaseline;
  }

  async function calculate(request: Request, timing: AssemblyLoadTimingDraft): Promise<void> {
    let completedWork = 0;
    async function execute<T>(steps: Generator<RigidWorkPoint, T, void>): Promise<CooperativeResult<T>> {
      if (obsolete(request)) return { status: 'cancelled', progress: completedWork };
      const run = runCooperative(steps, {
        pointsPerSlice: constraints.pointsPerSlice,
        schedule: slice => { constraints.schedule(() => {
          if (obsolete(request)) { run.cancel(); return; }
          slice();
          if (!obsolete(request)) constraints.onProgress?.(completedWork + run.progress());
        }); },
      });
      constraintRun = run;
      try {
        const result = await run.result;
        completedWork += run.progress();
        return obsolete(request) ? { status: 'cancelled', progress: completedWork } : result;
      } finally {
        if (constraintRun === run) constraintRun = null;
      }
    }
    gate(request, 'initial');
    const releaseStartedAt = performance.now();
    const { standardSources, references } = collectAssemblyPartSources(
      request.document,
      request.library,
    );
    if (documentId !== request.documentId) {
      // EX12 W02: another document (a re-open of the same file included) recomputes every part, but a part ref it reuses
      // keeps its kernel display part until its own recompute replaces it, so unchanged shapes meet the kernel's
      // content-keyed cache instead of being built again after a release (a re-open of 1,000 distinct definitions).
      // The old Scope still closes (its hidden reference meshes return); refs the new document lacks, retired owners and
      // a Scope that does not close are released first, as before.
      const keep = async (ref: string, owner: AssemblyPartResources): Promise<void> => {
        let closed = owner.scope === undefined;
        try { if (owner.scope !== undefined) closed = await owner.scope.close(); } catch { closed = false; }
        if (closed) owner.scope = undefined; else await release(ref);
      };
      await Promise.all([...retained.entries()].map(([ref, owner]) =>
        references.has(ref) && !owner.retired ? keep(ref, owner) : release(ref)));
      cache.clear(); standardDocuments.clear();
      documentId = request.documentId;
      lastGoodPlacements = new Map();
    }
    for (const ref of [...retained.keys()]) {
      if (!references.has(ref)) await release(ref);
    }
    timing.releaseMs = performance.now() - releaseStartedAt;
    const resolvedParts = new Map<string, ResolvedPart>();
    const bodies = new Map<string, readonly SolidBody[]>();
    const appearances = new Map<string, AppearanceInput>();
    const messages: string[] = [];
    let cacheHits = 0;
    const partsStartedAt = performance.now();
    timing.parts = references.size;
    for (const ref of references) {
      if (obsolete(request)) return;
      const standardSource = standardSources.get(ref);
      let document = standardSource === undefined ? request.library.parts.get(ref) : standardDocuments.get(ref);
      if (document === undefined && standardSource !== undefined) {
        document = buildStandardPartFromSource(standardSource) ?? undefined;
        if (document !== undefined) standardDocuments.set(ref, document);
      }
      if (document === undefined) continue; // resolveAssembly が行ごとの欠落を知らせる。
      const attachments = standardSource === undefined ? request.library.attachments.get(ref) : undefined;
      let found = cache.get(ref);
      if (found !== undefined && (found.document !== document || found.attachments !== attachments || !found.sourceOwner.current())) {
        await release(ref); found = undefined;
      }
      const available = async (entry: CachedPart): Promise<boolean> => {
        const visible = new Set(entry.result.bodies.map((body) => body.featureId));
        const keys = entry.resolved.steps.filter((step) => visible.has(step.featureId)).map((step) => step.key);
        if (keys.length === 0) return true;
        const availabilityStartedAt = performance.now();
        const outcome = await bridge.checkShapeAvailability(ref, keys);
        timing.availabilityMs += performance.now() - availabilityStartedAt;
        return outcome.missingKeys.length === 0;
      };
      if (found !== undefined && !(await available(found))) { await release(ref); found = undefined; }
      if (obsolete(request)) return;
      if (found === undefined) {
        const resources = await acquire(ref);
        const recomputeStartedAt = performance.now();
        // 各部品の覚え書きは recomputePart 内で作る。他の部品へ共有しない。
        const result = await recomputeOwned(document, {
          partId: ref, generation: request.generation,
          importedShapes: attachments?.shapes,
          shouldCancel: () => obsolete(request),
          onResolved: (resolved) => { resolvedParts.set(ref, resolved); },
          onProgress: (progress) => {
            if (!obsolete(request)) useAppStore.getState().setRecomputeProgress(progress);
          },
        }, resources, timing);
        timing.recomputeMs += performance.now() - recomputeStartedAt; timing.recomputed += 1;
        // 形の計算に使うメモリ(NFR-PF-6)。部品ごとの返信でも控え、帯の警告に使う(取消でも控える)。
        if (!detached) useAppStore.getState().recordKernelMemory(result.kernelMemory);
        if (obsolete(request)) { await release(ref); return; }
        if (result.cancelled) {
          await release(ref);
          useAppStore.setState({ isComputing: false, recomputeCancelled: true, recomputeProgress: null });
          useAppStore.getState().recordRecomputeCompletion(request.generation, 'cancelled');
          return;
        }
        const resolved = resolvedParts.get(ref);
        if (resolved === undefined) throw new Error(t('assembly.recomputeFailed'));
        const sourceDocument = document;
        const sourceOwner: AssemblySourceMeshOwner = { document, attachments, result, bodies: result.bodies,
          layouts: result.bodies.map(captureMeshBodyLayout), displayOwner: bridge.meshLedgerOwner?.(result.bodies) ?? null,
          hiddenOwners: result.referenceMeshScope?.owners ?? [], current: () => {
            const state = useAppStore.getState();
            return !detached && !resources.retired && cache.get(ref)?.result === result
              && (standardSource === undefined ? state.assemblyLibrary.parts.get(ref) === sourceDocument
                && state.assemblyLibrary.attachments.get(ref) === attachments : standardDocuments.get(ref) === sourceDocument)
              && (result.referenceMeshScope === undefined || result.referenceMeshScope.current);
          } };
        found = { document, attachments, resolved, result, sourceOwner, resources,
          appearances: buildAppearanceInput(appearanceOf(document), result.appearanceMatches ?? []) };
        // 取得後にも構造化された欠落を確かめる。再取得してなお欠ける場合は有限回で断る。
        if (result.errors.length === 0 && !(await available(found))) {
          messages.push(t('assembly.shapeMissing'));
          await release(ref);
          continue;
        }
        if (result.errors.length === 0) cache.set(ref, found);
      }
      if (obsolete(request)) return;
      resolvedParts.set(ref, found.resolved);
      bodies.set(ref, found.result.bodies);
      appearances.set(ref, found.appearances);
      messages.push(...found.result.errors.map((error) => error.message));
      cacheHits += found.result.cacheHits; timing.cacheHits = cacheHits;
    }
    timing.partsMs = performance.now() - partsStartedAt;
    if (obsolete(request)) return;
    const resolveStartedAt = performance.now();
    let resolved = resolveAssembly(request.document, {
      library: request.library, resolvedParts, standardPart: buildStandardPartFromSource,
      subAssemblies: request.library.assemblies,
    });
    messages.push(...resolved.errors.map((error) => error.message));
    let diagnosis: MateDiagnosis | null = null;
    const mateTargetErrors = new Map<string, readonly string[]>();
    const jointTargetErrors = new Map<string, readonly string[]>();
    const targets = new Map<string, MateResidualTargetPair>();
    const jointFrames = new Map<string, JointFramePair>();
    const resolveReference = createSubShapeReferenceResolver();
    const resolveTarget = (target: MateTarget) => resolveMateTarget(target, resolved, {
      subShape: (partKey, reference) => {
        const body = bodies.get(partKey)?.find((item) => item.featureId === reference.bodyFeatureId);
        const resolution = body === undefined ? null : resolveReference(body, reference);
        return resolution?.status === 'matched' ? resolution.match.geometry : null;
      },
    });
    const activeMates = request.document.mates.filter((mate) => !mate.suppressed);
    for (const mate of activeMates) {
      const errors: string[] = [];
      const a = resolveTarget(mate.a);
      const b = resolveTarget(mate.b);
      if (!a.ok) errors.push(a.message);
      if (!b.ok) errors.push(b.message);
      if (a.ok && b.ok) targets.set(mate.id, { a: a.target, b: b.target });
      if (errors.length > 0) mateTargetErrors.set(mate.id, errors);
    }
    const activeJoints = request.document.joints.filter((joint) => !joint.suppressed);
    for (const joint of activeJoints) {
      const errors: string[] = [];
      const a = resolveTarget(joint.a);
      const b = resolveTarget(joint.b);
      if (!a.ok) errors.push(a.message);
      if (!b.ok) errors.push(b.message);
      if (a.ok && b.ok) {
        const pair = jointFramePairFromTargets(joint, { a: a.target, b: b.target }, resolved.placements);
        if (pair === null) errors.push(t('assembly.joint.invalidTargets'));
        else jointFrames.set(joint.id, pair);
      }
      if (errors.length > 0) jointTargetErrors.set(joint.id, errors);
    }
    const constraintsStartedAt = performance.now();
    timing.resolveMs = constraintsStartedAt - resolveStartedAt;
    let nextGoodPlacements = new Map(lastGoodPlacements);
    if (activeMates.length > 0 || activeJoints.length > 0) {
      gate(request, 'constraints-start', 'solve');
      const solved = await execute(solveMatesSteps(request.document, targets, resolved.placements, { jointFrames }, constraints.budget));
      if (solved.status === 'cancelled' || obsolete(request)) return;
      gate(request, 'constraints-start', 'diagnose');
      const diagnosed = await execute(diagnoseMatesSteps(request.document, solved.value, constraints.budget));
      if (diagnosed.status === 'cancelled' || obsolete(request)) return;
      diagnosis = diagnosed.value;
      resolved = { ...resolved, placements: retainSuccessfulPlacements(request.document, solved.value, resolved.placements, nextGoodPlacements) };
    } else {
      nextGoodPlacements = new Map(resolved.placements);
    }
    const children = await solveChildOccurrences(request.document, resolved, bodies, {
      library: request.library, resolvedParts, standardPart: buildStandardPartFromSource,
      subAssemblies: request.library.assemblies,
    }, execute, constraints.budget);
    if (children === null || obsolete(request)) return;
    const publicationStartedAt = performance.now();
    timing.constraintsMs = publicationStartedAt - constraintsStartedAt;
    resolved = children.resolved;
    messages.push(...children.messages);
    const current = useAppStore.getState();
    const overlay = current.assemblyDragOverlay;
    const handOffOverlay = overlay !== null && overlay.document === request.document
      && overlay.library === request.library && overlay.documentId === request.documentId
      && overlay.version === request.version && overlay.generation === request.generation;
    gate(request, 'solver', diagnosis === null ? 'no-active-mates' : `${diagnosis.converged}:${diagnosis.complete}`, messages.length);
    const lastOutcome = messages.some((message) => message.includes(KERNEL_BROKEN_MESSAGE)) ? 'workerBroken' :
      messages.length > 0 || diagnosis?.converged === false || diagnosis?.complete === false ? 'failed' : 'success';
    const sources = new Map<string, AssemblySourceMeshOwner>();
    for (const [ref, partBodies] of bodies) {
      const entry = cache.get(ref);
      if (entry === undefined || entry.result.bodies !== partBodies || !entry.sourceOwner.current()) {
        // Preserve the actual recompute failure while refusing an unowned display publication.
        refuse(request, 'source-owner-refused', messages.length === 0 ? t('assembly.recomputeFailed') : messages.join('\n'));
      }
      sources.set(ref, entry.sourceOwner);
    }
    gate(request, 'source-owners-admitted', null, sources.size);
    const owners = [...sources.values()].flatMap(source => source.displayOwner === null
      ? source.hiddenOwners : [source.displayOwner, ...source.hiddenOwners]);
    // Cache hits still query the actual current global Worker vector and host epoch.
    const receipt = await bridge.captureCurrentMeshLedger?.({
      observationId: `assembly:${request.documentId}:${request.generation}`, owners,
    });
    gate(request, 'receipt', receipt?.status ?? 'unavailable', receipt?.status === 'unknown' ? null : owners.length);
    if (receipt?.status === 'unknown') gate(request, 'receipt-reason', receipt.reason);
    if (obsolete(request)) return;
    assemblyUiBackings.retryRegistration();
    const uiBuffers = assemblyUiBackings.buffers();
    if (!assemblyUiBackings.known() || uiBuffers.some(buffer => !(buffer instanceof ArrayBuffer))) {
      refuse(request, 'ui-backing-refused', t('assembly.recomputeFailed'));
    }
    const uiInputs = uiBuffers.filter((buffer): buffer is ArrayBuffer => buffer instanceof ArrayBuffer);
    gate(request, 'ui-backing-admitted', null, uiInputs.length);
    const uiEpoch = assemblyUiBackings.epoch();
    const inspection = receipt === undefined ? undefined : await bridge.inspectSourceMeshBackings?.(receipt, uiInputs);
    if (obsolete(request)) return;
    gate(request, 'inspection', inspection?.status ?? 'unavailable');
    if (inspection?.status === 'unknown') gate(request, 'inspection-reason', inspection.reason);
    const publication = useAppStore.getState();
    if (receipt === undefined) refuse(request, 'receipt-unavailable', t('assembly.recomputeFailed'));
    if (receipt.status !== 'known') { gate(request, 'receipt-unknown', receipt.reason); throw new Error(t('assembly.recomputeFailed')); }
    if (bridge.currentMeshLedgerReceipt?.(receipt) !== true) refuse(request, 'receipt-stale', t('assembly.recomputeFailed'));
    gate(request, 'receipt-current');
    if (inspection === undefined) refuse(request, 'inspection-unavailable', t('assembly.recomputeFailed'));
    if (inspection.status !== 'known') { gate(request, 'inspection-unknown', inspection.reason); throw new Error(t('assembly.recomputeFailed')); }
    if (bridge.currentSourceMeshBackingInspection?.(inspection, receipt) !== true) refuse(request, 'inspection-stale', t('assembly.recomputeFailed'));
    gate(request, 'inspection-current');
    if (assemblyUiBackings.epoch() !== uiEpoch) refuse(request, 'ui-epoch-changed', t('assembly.recomputeFailed'));
    if (publication.assembly !== request.document) refuse(request, 'document-changed', t('assembly.recomputeFailed'));
    if (publication.assemblyLibrary !== request.library) refuse(request, 'library-changed', t('assembly.recomputeFailed'));
    if (publication.activeDocumentId !== request.documentId) refuse(request, 'document-id-changed', t('assembly.recomputeFailed'));
    if (publication.documentVersion !== request.version) refuse(request, 'version-changed', t('assembly.recomputeFailed'));
    if (publication.requestedGeneration !== request.generation) refuse(request, 'generation-changed', t('assembly.recomputeFailed'));
    if ([...sources.values()].some(source => !source.current())) refuse(request, 'source-owner-stale', t('assembly.recomputeFailed'));
    gate(request, 'publication-admitted', lastOutcome);
    // Reacquire only the same still-published borrowed Source. No recomputation or resource return.
    const makeOwnership = (
      nextReceipt: Extract<NonNullable<typeof receipt>, { status: 'known' }>,
      nextInspection: Extract<NonNullable<typeof inspection>, { status: 'known' }>,
      inputs: readonly ArrayBuffer[], epoch: number,
    ): AssemblyMeshOwnership => {
      let pendingRefresh: Promise<AssemblyMeshOwnership | null> | null = null;
      const owned: AssemblyMeshOwnership = {
        document: request.document, library: request.library, activeDocumentId: request.documentId,
        documentVersion: request.version, generation: request.generation, cancelRequestCount: request.cancelBaseline,
        outcome: lastOutcome, timelineIndex: publication.timelineIndex, bodies, sources, receipt: nextReceipt,
        backingInspection: nextInspection,
        backingInspectionCurrent: () => bridge.currentSourceMeshBackingInspection?.(nextInspection, nextReceipt) === true,
        uiSnapshot: Object.freeze({ epoch, buffers: Object.freeze(inputs.map(buffer =>
          Object.freeze({ buffer: new WeakRef(buffer), bytes: buffer.byteLength }))) }),
        receiptCurrent: () => bridge.currentMeshLedgerReceipt?.(nextReceipt) === true,
        publicationCurrent: () => {
          const state = useAppStore.getState();
          return !detached && state.assembly === request.document && state.assemblyLibrary === request.library
            && state.activeDocumentId === request.documentId && state.documentVersion === request.version
            && state.requestedGeneration === request.generation && state.completedGeneration === request.generation
            && state.cancelRequestCount === request.cancelBaseline && !state.recomputeCancelled
            && state.lastOutcome === lastOutcome && state.timelineIndex === publication.timelineIndex
            && state.assemblyView?.bodies === bodies && state.assemblyView.meshOwnership === owned;
        },
        refreshOwnership: expected => {
          const initialView = useAppStore.getState().assemblyView;
          const current = () => !detached && latest === request && queued === null
            && !useAppStore.getState().isComputing && initialView !== null
            && useAppStore.getState().assemblyView === initialView
            && currentAssemblyMeshPublication(owned, useAppStore.getState());
          if (expected !== owned || initialView === null || !current()) return Promise.resolve(null);
          if (pendingRefresh !== null) return pendingRefresh;
          const refresh = async (): Promise<AssemblyMeshOwnership | null> => {
            const freshReceipt = await bridge.captureCurrentMeshLedger?.({
              observationId: `assembly-refresh:${request.documentId}:${request.generation}`, owners,
            });
            if (!current() || freshReceipt?.status !== 'known'
              || bridge.currentMeshLedgerReceipt?.(freshReceipt) !== true) return null;
            assemblyUiBackings.retryRegistration();
            const liveBuffers = assemblyUiBackings.buffers();
            if (!assemblyUiBackings.known() || liveBuffers.some(buffer => !(buffer instanceof ArrayBuffer))) return null;
            const freshInputs = liveBuffers.filter((buffer): buffer is ArrayBuffer => buffer instanceof ArrayBuffer);
            const freshEpoch = assemblyUiBackings.epoch();
            const freshInspection = await bridge.inspectSourceMeshBackings?.(freshReceipt, freshInputs);
            if (!current() || assemblyUiBackings.epoch() !== freshEpoch || freshInspection?.status !== 'known'
              || bridge.currentMeshLedgerReceipt?.(freshReceipt) !== true
              || bridge.currentSourceMeshBackingInspection?.(freshInspection, freshReceipt) !== true) return null;
            const fresh = makeOwnership(freshReceipt, freshInspection, freshInputs, freshEpoch);
            // No await between the final exact-publication check and this owner-only publication.
            if (!current()) return null;
            useAppStore.setState({ assemblyView: { ...initialView, meshOwnership: fresh } });
            return currentAssemblyMeshPublication(fresh, useAppStore.getState())
              && fresh.receiptCurrent() && fresh.backingInspectionCurrent() ? fresh : null;
          };
          pendingRefresh = refresh().catch(() => null).finally(() => { pendingRefresh = null; });
          return pendingRefresh;
        },
      };
      return owned;
    };
    const meshOwnership = makeOwnership(receipt, inspection, uiInputs, uiEpoch);
    // Observers can synchronously replace the owner, including at the admission gate.
    if (obsolete(request)) return;
    lastGoodPlacements = nextGoodPlacements;
    useAppStore.setState({
      completedGeneration: request.generation, lastOutcome,
      assemblyView: { sourceDocument: request.document, resolved, bodies, appearances, diagnosis,
        // 解いた入力(resolveAssembly に渡した文書・一式・子の組)を、解と同じ1回の公開で添える。
        source: jointOccurrenceInputsOf(request.document, request.library),
        mateTargetErrors, mateTargets: targets, jointFrames, jointTargetErrors, meshOwnership },
      isComputing: false, recomputeProgress: null, recomputeCancelled: false, cacheHits,
      errorMessage: messages.length === 0 ? null : messages.join('\n'),
      ...(handOffOverlay ? { assemblyDragOverlay: null } : {}),
    });
    useAppStore.getState().recordRecomputeCompletion(request.generation, lastOutcome);
    timing.publicationMs = performance.now() - publicationStartedAt;
    timing.outcome = `published:${lastOutcome}`;
  }

  async function drain(): Promise<void> {
    running = true;
    try {
      while (queued !== null && !detached) {
        const request = queued;
        queued = null;
        const timing: AssemblyLoadTimingDraft = { outcome: 'returned', parts: 0, recomputed: 0, cacheHits: 0, firstKernelMs: 0, releaseMs: 0, partsMs: 0,
          recomputeMs: 0, kernelMs: 0, availabilityMs: 0, resolveMs: 0, constraintsMs: 0, publicationMs: 0 };
        const startedAt = performance.now();
        inFlightLoadTiming = { draft: timing, startedAt };
        try {
          try { await calculate(request, timing); }
          catch (error: unknown) { timing.outcome = 'threw'; throw error; }
          finally {
            if (inFlightLoadTiming?.draft === timing) inFlightLoadTiming = null;
            recordLoadTiming(request, timing, performance.now() - startedAt);
          }
          if (latest === request && obsolete(request) && !detached) {
            useAppStore.setState({ isComputing: false, recomputeCancelled: true, recomputeProgress: null });
            useAppStore.getState().recordRecomputeCompletion(request.generation, 'cancelled');
          }
        } catch (error: unknown) {
          gate(request, 'calculate-threw-before-cleanup', 'unclassified-exception');
          await releaseAll();
          if (!obsolete(request)) {
            const message = error instanceof Error ? error.message : String(error);
            useAppStore.setState({ isComputing: false, errorMessage: message, recomputeProgress: null });
            useAppStore.getState().recordRecomputeCompletion(request.generation,
              message.includes(KERNEL_BROKEN_MESSAGE) ? 'workerBroken' : 'failed');
          }
        }
      }
      if (latest === null || detached) await releaseAll();
    } finally {
      running = false;
      if (queued !== null && !detached) void drain().catch(() => undefined);
    }
  }

  function requestCurrent(): void {
    constraintRun?.cancel();
    const state = useAppStore.getState();
    const active = activeDocument(state);
    if (active.kind !== 'assembly') {
      latest = null;
      queued = null;
      lastGoodPlacements.clear();
    } else {
      const activeIds = new Set(active.document.components.filter((component) => !component.suppressed).map((component) => component.id));
      for (const id of lastGoodPlacements.keys()) if (!activeIds.has(id)) lastGoodPlacements.delete(id);
      const generation = state.requestedGeneration + 1;
      latest = { document: active.document, library: active.library, documentId: active.documentId,
        version: state.documentVersion, generation, cancelBaseline: state.cancelRequestCount };
      queued = latest;
      useAppStore.setState({ requestedGeneration: generation, isComputing: true,
        recomputeCancelled: false, recomputeProgress: null });
    }
    if (!running) void drain().catch(() => undefined); // 解放時の破損も未処理の拒否を残さない。
  }

  const unsubscribe = useAppStore.subscribe((next, previous) => {
    if (next.cancelRequestCount !== previous.cancelRequestCount) constraintRun?.cancel();
    const placementStarted = next.assemblyPlacement !== null && previous.assemblyPlacement === null;
    const mateStarted = next.assemblyMateDraft !== null && previous.assemblyMateDraft === null;
    if (placementStarted && next.assemblyMateDraft !== null) {
      useAppStore.setState({ assemblyMateDraft: null, selection: [], hoveredElementId: null });
    }
    if (next.assemblyDrag !== null && (placementStarted || mateStarted)) {
      useAppStore.setState({ assemblyDrag: null, assemblyDragOverlay: null, assemblyDragNotice: null });
    }
    if (next.assembly !== previous.assembly || next.assemblyLibrary !== previous.assemblyLibrary ||
      next.activeDocumentId !== previous.activeDocumentId || next.documentVersion !== previous.documentVersion) {
      requestCurrent();
    }
  });
  requestCurrent();
  return () => {
    detached = true;
    constraintRun?.cancel();
    latest = null;
    queued = null;
    lastGoodPlacements.clear();
    unsubscribe();
    if (useAppStore.getState().assemblyReplacementRunner === replacementRunner) {
      useAppStore.getState().setAssemblyReplacementRunner(null);
    }
    if (!running) void releaseAll().catch(() => undefined);
  };
}
