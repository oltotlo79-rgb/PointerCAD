/** 文書の寿命に沿って部品を再計算し、配置と共有形状をストアへ渡す。 */
import {
  appearanceOf, buildStandardPartFromSource, diagnoseMates, jointFramePairFromTargets,
  KERNEL_BROKEN_MESSAGE, partKeyOf,
  recomputePart, resolveAssembly,
  resolveMateTarget, selectMateTargetGeometry, solveMates,
  type AssemblyDocument, type AssemblyKernelBridge, type ComponentSource, type EmbeddedPartAttachments, type PartDocument, type PartLibrary, type SolveMatesOutcome,
  type JointFramePair, type MateDiagnosis, type MateResidualTargetPair, type MateTarget,
  type PartRecomputeResult,
  type ResolvedPart, type RigidPlacement, type SolidBody,
} from '@pointercad/model';
import { buildAppearanceInput } from '../appearance/appearanceCommands.js';
import { t } from '../i18n/t.js';
import type { AssemblySnapshot } from '../store/assemblySlice.js';
import type { PartRecomputer } from '../store/attachKernel.js';
import { activeDocument } from '../store/documentKind.js';
import { useAppStore } from '../store/useAppStore.js';
import type { AppearanceInput } from '../viewport/buildSolidGeometry.js';
import type { AssemblyReplacementRunner } from './replaceCommands.js';

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

/** 部品再計算だけは検査用に差し替えられる。合致は常にmodelの実solverを使う。 */
export function attachAssembly(
  bridge: AssemblyKernelBridge,
  recompute: PartRecomputer = (document, options) => recomputePart(document, bridge, options),
): () => void {
  let detached = false;
  let running = false;
  let latest: Request | null = null;
  let queued: Request | null = null;
  let documentId: string | null = null;
  let version = -1;
  const cache = new Map<string, CachedPart>();
  const standardDocuments = new Map<string, PartDocument>();
  const retained = new Set<string>();
  let lastGoodPlacements = new Map<string, RigidPlacement>();
  const replacementRunner: AssemblyReplacementRunner = {
    resolve: async (document, attachments, requestId) => {
      const partId = `replacement:${requestId}`;
      try {
        const result = await recompute(document, {
          partId,
          importedShapes: attachments.shapes,
          shouldCancel: () => detached,
        });
        return result.bodies;
      } finally {
        await bridge.releasePart(partId);
      }
    },
  };
  useAppStore.getState().setAssemblyReplacementRunner(replacementRunner);

  async function release(ref: string): Promise<void> {
    retained.delete(ref);
    cache.delete(ref);
    standardDocuments.delete(ref);
    await bridge.releasePart(ref);
  }

  async function releaseAll(): Promise<void> {
    for (const ref of [...retained]) await release(ref);
    cache.clear();
  }

  function obsolete(request: Request): boolean {
    return detached || latest !== request ||
      useAppStore.getState().cancelRequestCount > request.cancelBaseline;
  }

  async function calculate(request: Request): Promise<void> {
    if (documentId !== request.documentId) {
      await releaseAll();
      documentId = request.documentId;
      lastGoodPlacements = new Map();
    }
    if (version !== request.version) {
      cache.clear();
      version = request.version;
    }
    const { standardSources, references } = collectAssemblyPartSources(
      request.document,
      request.library,
    );
    for (const ref of [...retained]) {
      if (!references.has(ref)) await release(ref);
    }
    const resolvedParts = new Map<string, ResolvedPart>();
    const bodies = new Map<string, readonly SolidBody[]>();
    const appearances = new Map<string, AppearanceInput>();
    const messages: string[] = [];
    let cacheHits = 0;
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
      if (found?.document !== document || found.attachments !== attachments) found = undefined;
      const available = async (entry: CachedPart): Promise<boolean> => {
        const visible = new Set(entry.result.bodies.map((body) => body.featureId));
        const keys = entry.resolved.steps.filter((step) => visible.has(step.featureId)).map((step) => step.key);
        if (keys.length === 0) return true;
        const outcome = await bridge.checkShapeAvailability(ref, keys);
        return outcome.missingKeys.length === 0;
      };
      if (found !== undefined && !(await available(found))) found = undefined;
      if (obsolete(request)) return;
      if (found === undefined) {
        retained.add(ref);
        // 各部品の覚え書きは recomputePart 内で作る。他の部品へ共有しない。
        const result = await recompute(document, {
          partId: ref, generation: request.generation,
          importedShapes: attachments?.shapes,
          shouldCancel: () => obsolete(request),
          onResolved: (resolved) => { resolvedParts.set(ref, resolved); },
          onProgress: (progress) => {
            if (!obsolete(request)) useAppStore.getState().setRecomputeProgress(progress);
          },
        });
        if (obsolete(request)) return;
        if (result.cancelled) {
          useAppStore.setState({ isComputing: false, recomputeCancelled: true, recomputeProgress: null });
          useAppStore.getState().recordRecomputeCompletion(request.generation, 'cancelled');
          return;
        }
        const resolved = resolvedParts.get(ref);
        if (resolved === undefined) throw new Error(t('assembly.recomputeFailed'));
        found = { document, attachments, resolved, result,
          appearances: buildAppearanceInput(appearanceOf(document), result.appearanceMatches ?? []) };
        // 取得後にも構造化された欠落を確かめる。再取得してなお欠ける場合は有限回で断る。
        if (result.errors.length === 0 && !(await available(found))) {
          messages.push(t('assembly.shapeMissing'));
          cache.delete(ref);
          continue;
        }
        if (result.errors.length === 0) cache.set(ref, found);
      }
      if (obsolete(request)) return;
      resolvedParts.set(ref, found.resolved);
      bodies.set(ref, found.result.bodies);
      appearances.set(ref, found.appearances);
      messages.push(...found.result.errors.map((error) => error.message));
      cacheHits += found.result.cacheHits;
    }
    if (obsolete(request)) return;
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
    const resolveTarget = (target: MateTarget) => resolveMateTarget(target, resolved, {
      subShape: (partKey, reference) => {
        const body = bodies.get(partKey)?.find((item) => item.featureId === reference.bodyFeatureId);
        return body === undefined ? null : selectMateTargetGeometry(body, reference);
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
    if (activeMates.length > 0 || activeJoints.length > 0) {
      const outcome = solveMates(request.document, targets, resolved.placements, { jointFrames });
      diagnosis = diagnoseMates(request.document, outcome);
      resolved = { ...resolved, placements: retainSuccessfulPlacements(request.document, outcome, resolved.placements, lastGoodPlacements) };
    } else {
      lastGoodPlacements = new Map(resolved.placements);
    }
    const current = useAppStore.getState();
    const overlay = current.assemblyDragOverlay;
    const handOffOverlay = overlay !== null && overlay.document === request.document
      && overlay.library === request.library && overlay.documentId === request.documentId
      && overlay.version === request.version && overlay.generation === request.generation;
    useAppStore.setState({
      assemblyView: { sourceDocument: request.document, resolved, bodies, appearances, diagnosis,
        mateTargetErrors, mateTargets: targets, jointFrames, jointTargetErrors },
      isComputing: false, recomputeProgress: null, recomputeCancelled: false, cacheHits,
      errorMessage: messages.length === 0 ? null : messages.join('\n'),
      ...(handOffOverlay ? { assemblyDragOverlay: null } : {}),
    });
    useAppStore.getState().recordRecomputeCompletion(request.generation,
      messages.some((message) => message.includes(KERNEL_BROKEN_MESSAGE)) ? 'workerBroken' :
        messages.length > 0 || diagnosis?.converged === false || diagnosis?.complete === false ? 'failed' : 'success');
  }

  async function drain(): Promise<void> {
    running = true;
    try {
      while (queued !== null && !detached) {
        const request = queued;
        queued = null;
        try {
          await calculate(request);
          if (latest === request && obsolete(request) && !detached) {
            useAppStore.setState({ isComputing: false, recomputeCancelled: true, recomputeProgress: null });
            useAppStore.getState().recordRecomputeCompletion(request.generation, 'cancelled');
          }
        } catch (error: unknown) {
          cache.clear();
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
