/** 文書の寿命に沿って部品を再計算し、配置と共有形状をストアへ渡す。 */
import {
  appearanceOf, buildStandardPartFromSource, diagnoseMatesSteps, jointFramePairFromTargets,
  partKeyOf,
  resolveAssembly, resolveConstrainedAssembly,
  createBodyMateTargetResolver, solveMatesSteps, runCooperative,
  type AssemblyDocument, type AssemblyKernelBridge, type ComponentSource, type EmbeddedPartAttachments, type PartDocument, type PartLibrary, type SolveMatesOutcome,
  type JointFramePair, type MateDiagnosis, type MateResidualTargetPair,
  type PartRecomputeResult, type CooperativeResult, type CooperativeRun, type CooperativeSchedule, type RigidWorkBudget, type RigidWorkPoint,
  type ResolveAssemblyOptions, type ResolvedAssembly, type ResolvedPart, type RigidPlacement, type SolidBody,
} from '@pointercad/model';
import { buildAppearanceInput } from '../appearance/appearanceCommands.js';
import { failureMessage, mixedFailureMessages } from '../i18n/failureMessage.js';
import { t } from '../i18n/t.js';
import { ensureDocumentCatalogFamilies } from './catalogFamilyLoading.js';
import type { AssemblyFaceProjection, AssemblySnapshot } from '../store/assemblySlice.js';
import type { AppState } from '../store/appState.js';
import { captureMeshBodyLayout, type RecomputeOutcome } from '../store/recomputeSlice.js';
import { assemblyBackgroundLibrary, assemblyCalculation, assemblyCalculationPatch } from '../store/partEditActions.js';
import { assemblyUiBackings, currentAssemblyMeshPublication, type AssemblyMeshOwnership, type AssemblySourceMeshOwner } from '../viewport/assemblyMeshAdmission.js';
import { LOCAL_DISPLAY_MESH_BUDGET, type PartRecomputer } from '../store/attachKernel.js';
import { activeDocument } from '../store/documentKind.js';
import { useAppStore } from '../store/useAppStore.js';
import { jointOccurrenceInputsOf } from '../viewport/pickJointOccurrence.js';
import { recomputePartWithMath as recomputePart } from '../math/recomputePartWithMath.js';
import type { AppearanceInput } from '../viewport/buildSolidGeometry.js';
import type { AssemblyReplacementRunner } from './replaceCommands.js';
import { partErrorMessage } from '../solid/surfaceBodyFailureText.js';

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
 * Diagnostic metadata only: wall-clock milliseconds of the sections of each assembly recompute (release of
 * the previous document, part recompute loop and its kernel/availability round trips, resolve, constraints,
 * publication). Bounded; never a gate, an acceptance or a native/GPU reading.
 */
 interface AssemblyLoadTiming {
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
 function readAssemblyLoadTimings() {
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

function faceProjector(bridge: AssemblyKernelBridge, cache: ReadonlyMap<string, CachedPart>,
  obsolete: () => boolean): AssemblyFaceProjection {
  const project: AssemblyFaceProjection = async (partRef, body, face, plane, stillRequested) => {
    const entry = cache.get(partRef), claim = entry?.resources.claim;
    if (entry === undefined || claim == null || face.bodyFeatureId !== body.featureId || face.origin?.shapeKind !== 'face') return null;
    const view = useAppStore.getState().assemblyView;
    const current = (): boolean => stillRequested() && !obsolete() && useAppStore.getState().assemblyView === view
      && view?.projectContextFace === project && view.meshOwnership?.publicationCurrent() === true
      && entry.sourceOwner.current() && entry.resources.claim === claim && entry.result.bodies.includes(body);
    if (!current()) return null;
    const [step, duplicate] = entry.resolved.steps.filter(item => item.featureId === body.featureId);
    if (step === undefined || duplicate !== undefined || !claim.owner.steps.some(item => item.id === body.featureId && item.key === step.key)) {
      return null;
    }
    try {
      // The worker leases this exact key for each call. The assembly's own claim is returned only by its owner.
      const featureId = 'assembly-context-face';
      const output = await bridge.projectSketchCurves([{ featureId, bodyKey: step.key, source: face, plane, faceBoundaries: true }]);
      const [item] = output.results;
      // Older workers only return curves. Require the explicit inner-wire field, including an empty one.
      return current() && output.failures.length === 0 && output.results.length === 1 && item.featureId === featureId
        && item.holes !== undefined ? item : null;
    } catch {
      return null;
    }
  };
  return project;
}

type PartClaim = NonNullable<ReturnType<NonNullable<AssemblyKernelBridge['capturePartReleaseClaim']>>>;
interface AssemblyPartResources {
  readonly bridge: AssemblyKernelBridge;
  readonly ref: string;
  readonly attachment: object;
  claim: PartClaim | null;
  cancelledPriorClaim: PartClaim | null;
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
        // A cancelled display reply need not have replaced the actual worker Part owner.
        // Only an already-issued predecessor claim may be checked, through the same exact RPC.
        if (result?.status === 'stale-owner' && owner.cancelledPriorClaim !== null) {
          const prior = await owner.bridge.releasePartClaim?.(owner.cancelledPriorClaim);
          partReturned = prior?.status === 'released' || prior?.status === 'absent' || prior?.status === 'closed';
        }
      } catch { /* Exact claim retained; no legacy void proof. */ }
    }
    if (scopeReturned) owner.scope = undefined;
    if (partReturned) { owner.claim = null; owner.cancelledPriorClaim = null; owner.partDispatched = false; }
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
 * collectAssemblyPartSources と同じ物を集め、族の部品(catalogItem)の族の表を登録口から読み込んで待つ
 * (model の組み立ては同期なので、組む前に読む)。読み込みが断られた時は、帯に出す文を catalogFailures に返し、
 * 文書は変えない(その部品は型付きの拒否のまま残る)。
 */
export async function collectLoadedAssemblyPartSources(
  document: AssemblyDocument,
  library: PartLibrary,
): Promise<ReturnType<typeof collectAssemblyPartSources> & { readonly catalogFailures: readonly string[] }> {
  const sources = collectAssemblyPartSources(document, library);
  return { ...sources, catalogFailures: await ensureDocumentCatalogFamilies(sources.standardSources.values()) };
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
    const reasons = solved.messages.length > 0 ? mixedFailureMessages(solved.messages) : [t('assembly.mate.incomplete')];
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
interface AssemblyConstraintExecution extends CooperativeSchedule {
  readonly budget: RigidWorkBudget;
  /** Counted work, not a percentage; monotone across the whole initial solve, diagnosis and child occurrences. */
  readonly onProgress?: (done: number) => void;
}
export const ASSEMBLY_CONSTRAINT_EXECUTION: AssemblyConstraintExecution = {
  budget: { units: 4096 }, pointsPerSlice: 16,
  schedule: slice => { setTimeout(slice, 0); },
};

/** 部品の再計算の失敗が、Worker の破損の符号を持つか(0b-1b)。 */
function isWorkerBroken(error: { readonly code: string }): boolean {
  return error.code === 'workerBroken';
}

/** A refusal naming the gate stage that threw, so the cleanup gate keeps it instead of an unclassified exception. */
class AssemblyRecomputeRefusal extends Error {
  readonly stage: string;
  /** 部品の再計算が Worker の破損の符号(workerBroken)で終わっていた時に真(0b-1b。文では見分けない)。 */
  readonly workerBroken: boolean;
  constructor(stage: string, message: string, workerBroken = false) { super(message); this.stage = stage; this.workerBroken = workerBroken; }
}

interface ObservationGates {
  readonly obsolete: (request: Request) => boolean;
  readonly gate: (request: Request, stage: string, reason?: string | null, count?: number | null) => void;
  readonly refuse: (request: Request, stage: string, reason: string, workerBroken?: boolean) => never;
}

/** At most this many waits for another request's reply clone within one initial observation (a count, not a time). */
const PENDING_REPLY_WAITS = 2;

/**
 * `pending-reply` is another request's reply clone still reserved in the realm ledger (CI 2026-11-12: the startup empty
 * Part request while a new empty assembly observed). It is a precondition to wait for through the bridge's actual
 * settlement, bounded by the ledger's reply reservation deadline, at most PENDING_REPLY_WAITS times. An unsettled or
 * exhausted wait fails closed with its own stage. Returns false when the request became obsolete during the wait.
 */
async function awaitPendingReply(bridge: AssemblyKernelBridge, request: Request, wait: number,
  { obsolete, gate }: ObservationGates): Promise<boolean> {
  const unsettled = (reason: string): never => {
    gate(request, 'pending-reply-unsettled', reason, wait);
    throw new AssemblyRecomputeRefusal('pending-reply-unsettled', t('assembly.recomputeFailed'));
  };
  if (wait > PENDING_REPLY_WAITS) unsettled('wait-limit');
  const settlement = await bridge.awaitMeshReplySettlement?.({ alive: () => !obsolete(request) }) ?? 'unavailable';
  if (obsolete(request)) return false;
  gate(request, 'pending-reply-wait', settlement, wait);
  if (settlement !== 'settled') unsettled(settlement);
  return true;
}

type LedgerReceipt = Awaited<ReturnType<NonNullable<AssemblyKernelBridge['captureCurrentMeshLedger']>>>;
type LedgerInspection = Awaited<ReturnType<NonNullable<AssemblyKernelBridge['inspectSourceMeshBackings']>>>;
interface AssemblyObservation {
  readonly receipt: LedgerReceipt | undefined;
  readonly inspection: LedgerInspection | undefined;
  readonly uiInputs: readonly ArrayBuffer[];
  readonly uiGeneration: number;
}
interface CurrentObservation {
  readonly status: 'current';
  readonly receipt: Extract<LedgerReceipt, { status: 'known' }>;
  readonly inspection: Extract<LedgerInspection, { status: 'known' }>;
  readonly uiInputs: readonly ArrayBuffer[];
  readonly uiGeneration: number;
}
/** Why a taken observation is not current: the refusing stage, the ledger reason if any, and the receipt's host generation. */
interface StaleObservation { readonly status: 'stale'; readonly stage: string; readonly reason: string | null; readonly since: number | null }

/**
 * The synchronous freshness of a taken observation (R6-R9 and the unavailable stages). The observation loop takes it
 * again on a transient refusal; the publication refuses on any, with no await before publishing. One definition serves both.
 */
function checkObservation(bridge: AssemblyKernelBridge, observation: AssemblyObservation): CurrentObservation | StaleObservation {
  const { receipt, inspection, uiInputs, uiGeneration } = observation;
  const inspectionReason = inspection?.status === 'unknown' ? inspection.reason : null;
  const stale = (stage: string, reason: string | null = inspectionReason): StaleObservation =>
    ({ status: 'stale', stage, reason, since: receipt?.status === 'known' ? receipt.hostEpoch : null });
  if (receipt === undefined) return stale('receipt-unavailable');
  if (bridge.currentMeshLedgerReceipt?.(receipt) !== true || receipt.status !== 'known') return stale('receipt-stale');
  if (inspection === undefined) return stale('inspection-unavailable');
  if (inspection.status !== 'known') return stale('inspection-unknown');
  if (bridge.currentSourceMeshBackingInspection?.(inspection, receipt) !== true) return stale('inspection-stale', null);
  if (assemblyUiBackings.epoch() !== uiGeneration) return stale('ui-epoch-changed', null);
  return { status: 'current', receipt, inspection, uiInputs, uiGeneration };
}

/** The publication's refusal of a stale observation, with the gates of the stage-by-stage checks it replaces. */
function refuseStale(request: Request, stale: StaleObservation, gate: ObservationGates['gate']): never {
  const message = t('assembly.recomputeFailed');
  gate(request, stale.stage, stale.stage === 'inspection-unknown' ? stale.reason : message);
  throw new AssemblyRecomputeRefusal(stale.stage, message);
}

/** What one initial observation may still spend on taking itself again (counts, never times). */
interface RestartAllowance { conflictRestarts: number; pendingWaits: number; records: number | null }
/** Concurrent growth changes, and released-only claims without progress: they share the single conflict restart. */
const GROWTH_CONFLICTS: ReadonlySet<string> = new Set(['host-epoch-changed', 'global-epoch-changed', 'receipt-stale',
  'inspection-stale', 'host-backings-released']);
/** Refusals whose cause the ledger can tell as released-only from the receipt's host generation. */
const RELEASE_CLASSIFIED: ReadonlySet<string> = new Set(['host-epoch-changed', 'global-epoch-changed',
  'unissued-or-stale-receipt', 'receipt-stale', 'inspection-stale']);

/**
 * The released-only restart reason, or null. A ledger release counts only while the ledger's releasable record count
 * strictly falls, and a UI release only while the observed UI backings strictly shrink to a subset: each record or
 * backing is released once, so a run of these restarts is finite without spending the conflict restart.
 */
function releasedRestart(bridge: AssemblyKernelBridge, key: string, since: number | null, uiInputs: readonly ArrayBuffer[],
  allowance: RestartAllowance): string | null {
  if (key === 'ui-epoch-changed') {
    const observed = new Set<ArrayBufferLike>(uiInputs), live = assemblyUiBackings.buffers();
    return assemblyUiBackings.known() && live.length < uiInputs.length && live.every(buffer => observed.has(buffer))
      ? 'ui-backings-released' : null;
  }
  const explicit = key === 'host-backings-released';
  if (!explicit && (since === null || !RELEASE_CLASSIFIED.has(key))) return null;
  const reading = bridge.meshLedgerRelease?.(explicit ? null : since);
  if (reading === undefined || (!explicit && !reading.releasedOnly)
    || allowance.records === null || reading.records >= allowance.records) return null;
  allowance.records = reading.records;
  return 'host-backings-released';
}

/**
 * The one place a transient refusal of the initial observation (R1-R9) is classified. Returns the reason it is taken
 * again with, null when the request became obsolete during a wait, or false when it is not taken again:
 * - `pending-reply`: wait for the reply's actual settlement (awaitPendingReply, at most PENDING_REPLY_WAITS waits);
 * - released records or UI backings only: no conflict restart, bounded by real progress (releasedRestart);
 * - a concurrent growth change: the single conflict restart. A second one, or anything else, is not taken again.
 */
async function restartObservation(bridge: AssemblyKernelBridge, request: Request, stale: StaleObservation,
  uiInputs: readonly ArrayBuffer[], allowance: RestartAllowance, gates: ObservationGates): Promise<string | null | false> {
  const key = stale.reason ?? stale.stage;
  if (key === 'pending-reply' && bridge.awaitMeshReplySettlement !== undefined) {
    allowance.pendingWaits += 1;
    if (!(await awaitPendingReply(bridge, request, allowance.pendingWaits, gates))) return null;
    allowance.records = bridge.meshLedgerRelease?.(null).records ?? null;
    return key;
  }
  const released = releasedRestart(bridge, key, stale.since, uiInputs, allowance);
  if (released !== null) return released;
  if (!GROWTH_CONFLICTS.has(key) || allowance.conflictRestarts > 0) return false;
  allowance.conflictRestarts += 1;
  allowance.records = bridge.meshLedgerRelease?.(null).records ?? null;
  return key;
}

/**
 * Takes the initial ledger observation and checks it exactly as the publication does, taking it again from the start
 * whenever restartObservation classifies the refusal as transient. An inspection or freshness refusal that is not
 * taken again is returned for the publication to refuse with its own stage and gates.
 */
async function captureInitialAssemblyObservation(
  bridge: AssemblyKernelBridge, request: Request, sources: ReadonlyMap<string, AssemblySourceMeshOwner>,
  owners: Parameters<NonNullable<AssemblyKernelBridge['captureCurrentMeshLedger']>>[0]['owners'],
  gates: ObservationGates,
): Promise<AssemblyObservation | undefined> {
  const { obsolete, gate, refuse } = gates;
  const allowance: RestartAllowance = { conflictRestarts: 0, pendingWaits: 0,
    records: bridge.meshLedgerRelease?.(null).records ?? null };
  for (let attempt = 0; ; attempt += 1) {
    if (obsolete(request)) return;
    if ([...sources.values()].some(source => !source.current())) refuse(request, 'source-owner-stale', t('assembly.recomputeFailed'));
    // Registration itself may change the host epoch: complete it before capture.
    assemblyUiBackings.retryRegistration();
    const uiBuffers = assemblyUiBackings.buffers();
    if (!assemblyUiBackings.known() || uiBuffers.some(buffer => !(buffer instanceof ArrayBuffer))) {
      refuse(request, 'ui-backing-refused', t('assembly.recomputeFailed'));
    }
    const uiInputs = uiBuffers.filter((buffer): buffer is ArrayBuffer => buffer instanceof ArrayBuffer);
    const uiGeneration = assemblyUiBackings.epoch();
    gate(request, 'ui-backing-admitted', null, uiInputs.length);
    const receipt = await bridge.captureCurrentMeshLedger?.({
      observationId: `assembly:${request.documentId}:${request.generation}:${attempt}`, owners,
    });
    gate(request, 'receipt', receipt?.status ?? 'unavailable', receipt?.status === 'unknown' ? null : owners.length);
    if (receipt?.status === 'unknown') gate(request, 'receipt-reason', receipt.reason);
    if (obsolete(request)) return;
    if ([...sources.values()].some(source => !source.current())) refuse(request, 'source-owner-stale', t('assembly.recomputeFailed'));
    let observation: AssemblyObservation | null = null, stale: StaleObservation;
    if (receipt?.status === 'unknown') {
      gate(request, 'receipt-unknown', receipt.reason);
      stale = { status: 'stale', stage: 'receipt-unknown', reason: receipt.reason, since: null };
    } else {
      const inspection = receipt === undefined ? undefined : await bridge.inspectSourceMeshBackings?.(receipt, uiInputs);
      if (obsolete(request)) return;
      if ([...sources.values()].some(source => !source.current())) refuse(request, 'source-owner-stale', t('assembly.recomputeFailed'));
      gate(request, 'inspection', inspection?.status ?? 'unavailable');
      if (inspection?.status === 'unknown') gate(request, 'inspection-reason', inspection.reason);
      observation = { receipt, inspection, uiInputs, uiGeneration };
      const checked = checkObservation(bridge, observation);
      if (checked.status === 'current') return observation;
      stale = checked;
    }
    const restart = await restartObservation(bridge, request, stale, uiInputs, allowance, gates);
    if (restart === null) return;
    if (restart === false) {
      if (observation === null) throw new AssemblyRecomputeRefusal('receipt-unknown', t('assembly.recomputeFailed'));
      return observation;
    }
    gate(request, 'observation-restarted', restart, attempt + 1);
  }
}

/** Scope for the cached part, its resolved display and its exact native return claim. */
function createAssemblyPartCache(bridge: AssemblyKernelBridge, recompute: PartRecomputer | undefined) {
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
    const owner: AssemblyPartResources = { bridge, ref, attachment: attachmentOwner, claim: null, cancelledPriorClaim: null,
      scope: undefined, partDispatched: false, retired: false, cleanup: null };
    claims.set(ref, owner); retained.set(ref, owner);
    return owner;
  }

  function captureReplyClaim(owner: AssemblyPartResources, bodies: PartRecomputeResult['bodies'], cancelled: boolean): void {
    const claim = bridge.capturePartReleaseClaim?.(bodies);
    if (claim === undefined || claim === null) return;
    if (!cancelled) owner.cancelledPriorClaim = null;
    else if (owner.claim !== null && owner.cancelledPriorClaim === null
      && (owner.claim.owner.dispatchId !== claim.owner.dispatchId || owner.claim.connectionEpoch !== claim.connectionEpoch)) {
      owner.cancelledPriorClaim = owner.claim;
    }
    owner.claim = claim; owner.partDispatched = true;
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
      // A reservation refusal has no issued reply owner. Retain the still-held exact claim;
      // releasePartClaim must prove its current/absent/closed disposition, never infer release here.
      captureReplyClaim(owner, outcome.bodies, outcome.cancelled);
      return outcome;
    } };
    const displayOptions = { ...options, localMesh: { ...LOCAL_DISPLAY_MESH_BUDGET } };
    const result = await (recompute === undefined ? recomputePart(document, actualBridge, displayOptions) : recompute(document, displayOptions));
    owner.scope = result.referenceMeshScope;
    captureReplyClaim(owner, result.bodies, result.cancelled);
    return result;
  }

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

  return { cache, standardDocuments, retained, acquire, recomputeOwned, release, releaseAll };
}

interface AssemblyRecomputeLifetime {
  detached: boolean;
  latest: Request | null;
  queued: Request | null;
  documentId: string | null;
  constraintRun: CooperativeRun<unknown> | null;
  lastGoodPlacements: Map<string, RigidPlacement>;
}

interface AssemblyRecomputeExecution {
  readonly bridge: AssemblyKernelBridge;
  readonly constraints: AssemblyConstraintExecution;
  readonly lifetime: AssemblyRecomputeLifetime;
  readonly partCache: ReturnType<typeof createAssemblyPartCache>;
  readonly obsolete: (request: Request) => boolean;
  readonly gate: (request: Request, stage: string, reason?: string | null, count?: number | null) => void;
  readonly refuse: (request: Request, stage: string, reason: string, workerBroken?: boolean) => never;
}

/** Resolve the active assembly constraints and record target failures in document order. */
function prepareAssemblyConstraintTargets(document: Request['document'], resolved: ReturnType<typeof resolveAssembly>,
  bodies: ReadonlyMap<string, readonly SolidBody[]>) {
  const mateTargetErrors = new Map<string, readonly string[]>();
  const jointTargetErrors = new Map<string, readonly string[]>();
  const targets = new Map<string, MateResidualTargetPair>();
  const jointFrames = new Map<string, JointFramePair>();
  const resolveTarget = createBodyMateTargetResolver(resolved, bodies);
  const activeMates = document.mates.filter((mate) => !mate.suppressed);
  for (const mate of activeMates) {
    const errors: string[] = [];
    const a = resolveTarget(mate.a);
    const b = resolveTarget(mate.b);
    if (!a.ok) errors.push(a.message);
    if (!b.ok) errors.push(b.message);
    if (a.ok && b.ok) targets.set(mate.id, { a: a.target, b: b.target });
    if (errors.length > 0) mateTargetErrors.set(mate.id, errors);
  }
  const activeJoints = document.joints.filter((joint) => !joint.suppressed);
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
  return { mateTargetErrors, jointTargetErrors, targets, jointFrames, activeMates, activeJoints };
}

function currentAssemblySources(request: Request, cache: ReadonlyMap<string, CachedPart>,
  bodies: ReadonlyMap<string, readonly SolidBody[]>, messages: readonly string[], workerBroken: boolean,
  refuse: AssemblyRecomputeExecution['refuse']): ReadonlyMap<string, AssemblySourceMeshOwner> {
  const sources = new Map<string, AssemblySourceMeshOwner>();
  for (const [ref, partBodies] of bodies) {
    const entry = cache.get(ref);
    if (entry === undefined || entry.result.bodies !== partBodies || !entry.sourceOwner.current()) {
      // Preserve the actual recompute failure while refusing an unowned display publication.
      refuse(request, 'source-owner-refused', messages.length === 0 ? t('assembly.recomputeFailed') : messages.join('\n'), workerBroken);
    }
    sources.set(ref, entry.sourceOwner);
  }
  return sources;
}

interface AssemblyMeshPublication {
  readonly bridge: AssemblyKernelBridge;
  readonly request: Request;
  readonly lifetime: AssemblyRecomputeLifetime;
  readonly lastOutcome: AssemblyMeshOwnership['outcome'];
  readonly publishedState: ReturnType<typeof useAppStore.getState>;
  readonly bodies: ReadonlyMap<string, readonly SolidBody[]>;
  readonly sources: ReadonlyMap<string, AssemblySourceMeshOwner>;
  readonly owners: Parameters<NonNullable<AssemblyKernelBridge['captureCurrentMeshLedger']>>[0]['owners'];
}

type KnownAssemblyMeshReceipt = Extract<NonNullable<AssemblyMeshOwnership['receipt']>, { status: 'known' }>;
type KnownAssemblyBackingInspection = Extract<NonNullable<AssemblyMeshOwnership['backingInspection']>, { status: 'known' }>;

function createAssemblyMeshPublication(publication: AssemblyMeshPublication) {
  const { bridge, request, lifetime, lastOutcome, publishedState, bodies, sources, owners } = publication;
  const publishedCalculation = assemblyCalculation(publishedState);
  // Reacquire only the same still-published borrowed Source. No recomputation or resource return.
  const makeOwnership = (
    nextReceipt: KnownAssemblyMeshReceipt,
    nextInspection: KnownAssemblyBackingInspection,
    inputs: readonly ArrayBuffer[], capturedGeneration: number,
  ): AssemblyMeshOwnership => {
    let pendingRefresh: Promise<AssemblyMeshOwnership | null> | null = null;
    const owned: AssemblyMeshOwnership = {
      document: request.document, library: request.library, activeDocumentId: request.documentId,
      documentVersion: request.version, generation: request.generation, cancelRequestCount: request.cancelBaseline,
      outcome: lastOutcome, timelineIndex: publishedCalculation.timelineIndex, bodies, sources, receipt: nextReceipt,
      backingInspection: nextInspection,
      backingInspectionCurrent: () => bridge.currentSourceMeshBackingInspection?.(nextInspection, nextReceipt) === true,
      uiSnapshot: Object.freeze({ epoch: capturedGeneration, buffers: Object.freeze(inputs.map(buffer =>
        Object.freeze({ buffer: new WeakRef(buffer), bytes: buffer.byteLength }))) }),
      receiptCurrent: () => bridge.currentMeshLedgerReceipt?.(nextReceipt) === true,
      publicationCurrent: () => {
        const state = useAppStore.getState();
        const calculation = assemblyCalculation(state);
        return !lifetime.detached && state.assembly === request.document && assemblyBackgroundLibrary(state) === request.library
          && state.activeDocumentId === request.documentId && state.documentVersion === request.version
          && calculation.requestedGeneration === request.generation && calculation.completedGeneration === request.generation
          && calculation.cancelRequestCount === request.cancelBaseline && !calculation.recomputeCancelled
          && calculation.lastOutcome === lastOutcome && calculation.timelineIndex === publishedCalculation.timelineIndex
          && state.assemblyView?.bodies === bodies && state.assemblyView.meshOwnership === owned;
      },
      refreshOwnership: expected => {
        const initialView = useAppStore.getState().assemblyView;
        const current = () => !lifetime.detached && lifetime.latest === request && lifetime.queued === null
          && !assemblyCalculation(useAppStore.getState()).isComputing && initialView !== null
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
          const freshGeneration = assemblyUiBackings.epoch();
          const freshInspection = await bridge.inspectSourceMeshBackings?.(freshReceipt, freshInputs);
          if (!current() || assemblyUiBackings.epoch() !== freshGeneration || freshInspection?.status !== 'known'
            || bridge.currentMeshLedgerReceipt?.(freshReceipt) !== true
            || bridge.currentSourceMeshBackingInspection?.(freshInspection, freshReceipt) !== true) return null;
          const fresh = makeOwnership(freshReceipt, freshInspection, freshInputs, freshGeneration);
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
  return makeOwnership;
}

function assemblyPublicationRefusal(request: Request, state: AppState): string | null {
  if (state.assembly !== request.document) return 'document-changed';
  if (assemblyBackgroundLibrary(state) !== request.library) return 'library-changed';
  if (state.activeDocumentId !== request.documentId) return 'document-id-changed';
  if (state.documentVersion !== request.version) return 'version-changed';
  if (assemblyCalculation(state).requestedGeneration !== request.generation) return 'generation-changed';
  return null;
}

function updateAssemblyCalculation(fields: Parameters<typeof assemblyCalculationPatch>[1]): void {
  useAppStore.setState(state => assemblyCalculationPatch(state, fields));
}

function completeAssemblyCalculation(generation: number, outcome: Exclude<RecomputeOutcome, 'idle'>): void {
  const state = useAppStore.getState();
  if (state.partEdit === null) state.recordRecomputeCompletion(generation, outcome);
  else updateAssemblyCalculation({ completedGeneration: generation, lastOutcome: outcome });
}

function admitAssemblyPublication(request: Request, sources: ReadonlyMap<string, AssemblySourceMeshOwner>,
  lastOutcome: AssemblyMeshOwnership['outcome'], gate: AssemblyRecomputeExecution['gate'],
  refuse: AssemblyRecomputeExecution['refuse']): ReturnType<typeof useAppStore.getState> {
  gate(request, 'receipt-current'); gate(request, 'inspection-current');
  const publication = useAppStore.getState();
  const publicationRefusal = assemblyPublicationRefusal(request, publication);
  if (publicationRefusal !== null) refuse(request, publicationRefusal, t('assembly.recomputeFailed'));
  if ([...sources.values()].some(source => !source.current())) refuse(request, 'source-owner-stale', t('assembly.recomputeFailed'));
  gate(request, 'publication-admitted', lastOutcome);
  return publication;
}

async function calculateAssemblyRequest(request: Request, timing: AssemblyLoadTimingDraft,
  execution: AssemblyRecomputeExecution): Promise<void> {
  const { bridge, constraints, lifetime, partCache, obsolete, gate, refuse } = execution;
  const { cache, standardDocuments, retained, acquire, recomputeOwned, release } = partCache;
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
    lifetime.constraintRun = run;
    try {
      const result = await run.result;
      completedWork += run.progress();
      return obsolete(request) ? { status: 'cancelled', progress: completedWork } : result;
    } finally {
      if (lifetime.constraintRun === run) lifetime.constraintRun = null;
    }
  }
  gate(request, 'initial');
  const releaseStartedAt = performance.now();
  const { standardSources, references, catalogFailures } = await collectLoadedAssemblyPartSources(
    request.document,
    request.library,
  );
  if (lifetime.documentId !== request.documentId) {
    // another document (a re-open of the same file included) recomputes every part, but a part ref it reuses
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
    lifetime.documentId = request.documentId;
    lifetime.lastGoodPlacements = new Map();
  }
  for (const ref of [...retained.keys()]) {
    if (!references.has(ref)) await release(ref);
  }
  timing.releaseMs = performance.now() - releaseStartedAt;
  const resolvedParts = new Map<string, ResolvedPart>();
  const bodies = new Map<string, readonly SolidBody[]>();
  const appearances = new Map<string, AppearanceInput>();
  const messages: string[] = [...catalogFailures];
  let cacheHits = 0, workerBroken = false;
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
          if (!obsolete(request)) updateAssemblyCalculation({ recomputeProgress: progress });
        },
      }, resources, timing);
      timing.recomputeMs += performance.now() - recomputeStartedAt; timing.recomputed += 1;
      // 形の計算に使うメモリ(NFR-PF-6)。部品ごとの返信でも控え、帯の警告に使う(取消でも控える)。
      if (!lifetime.detached) useAppStore.getState().recordKernelMemory(result.kernelMemory);
      if (obsolete(request)) { await release(ref); return; }
      if (result.cancelled) {
        await release(ref);
        updateAssemblyCalculation({ isComputing: false, recomputeCancelled: true, recomputeProgress: null });
        completeAssemblyCalculation(request.generation, 'cancelled');
        return;
      }
      const resolved = resolvedParts.get(ref);
      if (resolved === undefined) throw new Error(t('assembly.recomputeFailed'));
      const sourceDocument = document;
      const sourceOwner: AssemblySourceMeshOwner = { document, attachments, result, bodies: result.bodies,
        layouts: result.bodies.map(captureMeshBodyLayout), displayOwner: bridge.meshLedgerOwner?.(result.bodies) ?? null,
        hiddenOwners: result.referenceMeshScope?.owners ?? [], current: () => {
          const state = useAppStore.getState();
          return !lifetime.detached && !resources.retired && cache.get(ref)?.result === result
            && (standardSource === undefined ? assemblyBackgroundLibrary(state).parts.get(ref) === sourceDocument
              && assemblyBackgroundLibrary(state).attachments.get(ref) === attachments : standardDocuments.get(ref) === sourceDocument)
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
    messages.push(...found.result.errors.map(partErrorMessage));
    cacheHits += found.result.cacheHits; timing.cacheHits = cacheHits; workerBroken ||= found.result.errors.some(isWorkerBroken);
  }
  timing.partsMs = performance.now() - partsStartedAt;
  if (obsolete(request)) return;
  const resolveStartedAt = performance.now();
  let resolved = resolveAssembly(request.document, {
    library: request.library, resolvedParts, standardPart: buildStandardPartFromSource,
    subAssemblies: request.library.assemblies,
  });
  messages.push(...resolved.errors.map((error) => failureMessage(error.text)));
  let diagnosis: MateDiagnosis | null = null;
  const { mateTargetErrors, jointTargetErrors, targets, jointFrames, activeMates, activeJoints }
    = prepareAssemblyConstraintTargets(request.document, resolved, bodies);
  const constraintsStartedAt = performance.now();
  timing.resolveMs = constraintsStartedAt - resolveStartedAt;
  let nextGoodPlacements = new Map(lifetime.lastGoodPlacements);
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
  const lastOutcome = workerBroken ? 'workerBroken' :
    messages.length > 0 || diagnosis?.converged === false || diagnosis?.complete === false ? 'failed' : 'success';
  const sources = currentAssemblySources(request, cache, bodies, messages, workerBroken, refuse);
  gate(request, 'source-owners-admitted', null, sources.size);
  const owners = [...sources.values()].flatMap(source => source.displayOwner === null
    ? source.hiddenOwners : [source.displayOwner, ...source.hiddenOwners]);
  const observation = await captureInitialAssemblyObservation(bridge, request, sources, owners, { obsolete, gate, refuse });
  if (observation === undefined || obsolete(request)) return;
  const checked = checkObservation(bridge, observation);
  if (checked.status === 'stale') refuseStale(request, checked, gate);
  const { receipt, inspection, uiInputs, uiGeneration } = checked;
  const publishedState = admitAssemblyPublication(request, sources, lastOutcome, gate, refuse);
  const makeOwnership = createAssemblyMeshPublication({
    bridge, request, lifetime, lastOutcome, publishedState, bodies, sources, owners,
  });
  const meshOwnership = makeOwnership(receipt, inspection, uiInputs, uiGeneration);
  // Observers can synchronously replace the owner, including at the admission gate.
  if (obsolete(request)) return;
  lifetime.lastGoodPlacements = nextGoodPlacements;
  useAppStore.setState(state => ({
    ...assemblyCalculationPatch(state, { completedGeneration: request.generation, lastOutcome,
      isComputing: false, recomputeProgress: null, recomputeCancelled: false, cacheHits,
      errorMessage: messages.length === 0 ? null : messages.join('\n') }),
    assemblyView: { sourceDocument: request.document, resolved, bodies, appearances, diagnosis,
      // 解いた入力(resolveAssembly に渡した文書・一式・子の組)を、解と同じ1回の公開で添える。
      source: jointOccurrenceInputsOf(request.document, request.library),
      mateTargetErrors, mateTargets: targets, jointFrames, jointTargetErrors, meshOwnership, projectContextFace: faceProjector(bridge, cache, () => lastOutcome !== 'success' || obsolete(request)) },
    ...(handOffOverlay ? { assemblyDragOverlay: null } : {}),
  }));
  if (useAppStore.getState().partEdit === null) completeAssemblyCalculation(request.generation, lastOutcome);
  timing.publicationMs = performance.now() - publicationStartedAt;
  timing.outcome = `published:${lastOutcome}`;
}

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
  function refuse(request: Request, stage: string, reason: string, workerBroken = false): never {
    gate(request, stage, reason); throw new AssemblyRecomputeRefusal(stage, reason, workerBroken);
  }
  let running = false;
  const lifetime: AssemblyRecomputeLifetime = { detached: false, latest: null, queued: null,
    documentId: null, constraintRun: null, lastGoodPlacements: new Map() };
  const partCache = createAssemblyPartCache(bridge, recompute);
  const { retained, acquire, recomputeOwned, releaseAll } = partCache;
  const replacementRunner: AssemblyReplacementRunner = {
    resolve: async (document, attachments, requestId) => {
      const partId = `replacement:${requestId}`;
      const owner = await acquire(partId);
      try {
        const result = await recomputeOwned(document, {
          partId,
          importedShapes: attachments.shapes,
          shouldCancel: () => lifetime.detached,
        }, owner);
        return result.bodies;
      } finally {
        retained.delete(partId); await retireAssemblyPart(owner);
      }
    },
  };
  useAppStore.getState().setAssemblyReplacementRunner(replacementRunner);

  function obsolete(request: Request): boolean {
    const state = useAppStore.getState();
    return lifetime.detached || lifetime.latest !== request || assemblyPublicationRefusal(request, state) !== null
      || assemblyCalculation(state).cancelRequestCount !== request.cancelBaseline;
  }

  async function drain(): Promise<void> {
    running = true;
    try {
      while (lifetime.queued !== null && !lifetime.detached) {
        const request = lifetime.queued;
        lifetime.queued = null;
        const timing: AssemblyLoadTimingDraft = { outcome: 'returned', parts: 0, recomputed: 0, cacheHits: 0, firstKernelMs: 0, releaseMs: 0, partsMs: 0,
          recomputeMs: 0, kernelMs: 0, availabilityMs: 0, resolveMs: 0, constraintsMs: 0, publicationMs: 0 };
        const startedAt = performance.now();
        inFlightLoadTiming = { draft: timing, startedAt };
        try {
          try { await calculateAssemblyRequest(request, timing, { bridge, constraints, lifetime, partCache, obsolete, gate, refuse }); }
          catch (error: unknown) { timing.outcome = 'threw'; throw error; }
          finally {
            if (inFlightLoadTiming?.draft === timing) inFlightLoadTiming = null;
            recordLoadTiming(request, timing, performance.now() - startedAt);
          }
          if (lifetime.latest === request && obsolete(request) && !lifetime.detached) {
            updateAssemblyCalculation({ isComputing: false, recomputeCancelled: true, recomputeProgress: null });
            completeAssemblyCalculation(request.generation, 'cancelled');
          }
        } catch (error: unknown) {
          gate(request, 'calculate-threw-before-cleanup', error instanceof AssemblyRecomputeRefusal ? error.stage : 'unclassified-exception');
          await releaseAll();
          if (!obsolete(request)) {
            const message = error instanceof Error ? error.message : String(error);
            updateAssemblyCalculation({ isComputing: false, errorMessage: message, recomputeProgress: null });
            completeAssemblyCalculation(request.generation,
              error instanceof AssemblyRecomputeRefusal && error.workerBroken ? 'workerBroken' : 'failed');
          }
        }
      }
      if (lifetime.latest === null || lifetime.detached) await releaseAll();
    } finally {
      running = false;
      if (lifetime.queued !== null && !lifetime.detached) void drain().catch(() => undefined);
    }
  }

  function requestCurrent(): void {
    lifetime.constraintRun?.cancel();
    const state = useAppStore.getState();
    const active = activeDocument(state);
    if (active.kind !== 'assembly') {
      lifetime.latest = null;
      lifetime.queued = null;
      lifetime.lastGoodPlacements.clear();
    } else {
      const activeIds = new Set(active.document.components.filter((component) => !component.suppressed).map((component) => component.id));
      for (const id of lifetime.lastGoodPlacements.keys()) if (!activeIds.has(id)) lifetime.lastGoodPlacements.delete(id);
      const calculation = assemblyCalculation(state);
      const generation = Math.max(calculation.requestedGeneration, state.requestedGeneration) + 1;
      lifetime.latest = { document: active.document, library: assemblyBackgroundLibrary(state), documentId: active.documentId,
        version: state.documentVersion, generation, cancelBaseline: calculation.cancelRequestCount };
      lifetime.queued = lifetime.latest;
      updateAssemblyCalculation({ requestedGeneration: generation, isComputing: true,
        recomputeCancelled: false, recomputeProgress: null });
    }
    if (!running) void drain().catch(() => undefined); // 解放時の破損も未処理の拒否を残さない。
  }

  const unsubscribe = useAppStore.subscribe((next, previous) => {
    if (assemblyCalculation(next).cancelRequestCount !== assemblyCalculation(previous).cancelRequestCount) lifetime.constraintRun?.cancel();
    const placementStarted = next.assemblyPlacement !== null && previous.assemblyPlacement === null;
    const mateStarted = next.assemblyMateDraft !== null && previous.assemblyMateDraft === null;
    if (placementStarted && next.assemblyMateDraft !== null) {
      useAppStore.setState({ assemblyMateDraft: null, selection: [], hoveredElementId: null });
    }
    if (next.assemblyDrag !== null && (placementStarted || mateStarted)) {
      useAppStore.setState({ assemblyDrag: null, assemblyDragOverlay: null, assemblyDragNotice: null });
    }
    if (next.assembly !== previous.assembly || assemblyBackgroundLibrary(next) !== assemblyBackgroundLibrary(previous) ||
      next.activeDocumentId !== previous.activeDocumentId || next.documentVersion !== previous.documentVersion) {
      requestCurrent();
    }
  });
  requestCurrent();
  return () => {
    lifetime.detached = true;
    lifetime.constraintRun?.cancel();
    lifetime.latest = null;
    lifetime.queued = null;
    lifetime.lastGoodPlacements.clear();
    unsubscribe();
    if (useAppStore.getState().assemblyReplacementRunner === replacementRunner) {
      useAppStore.getState().setAssemblyReplacementRunner(null);
    }
    if (!running) void releaseAll().catch(() => undefined);
  };
}
