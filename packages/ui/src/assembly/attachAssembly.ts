/** 文書の寿命に沿って部品を再計算し、配置と共有形状をストアへ渡す。 */
import {
  appearanceOf, KERNEL_BROKEN_MESSAGE, recomputePart, resolveAssembly,
  type AssemblyKernelBridge, type EmbeddedPartAttachments, type PartDocument,
  type PartRecomputeResult, type ResolvedPart, type SolidBody,
} from '@pointercad/model';
import { buildAppearanceInput } from '../appearance/appearanceCommands.js';
import { t } from '../i18n/t.js';
import type { AssemblySnapshot } from '../store/assemblySlice.js';
import type { PartRecomputer } from '../store/attachKernel.js';
import { activeDocument } from '../store/documentKind.js';
import { useAppStore } from '../store/useAppStore.js';
import type { AppearanceInput } from '../viewport/buildSolidGeometry.js';

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

/** 偽の再計算を渡せる。実製品では同じ bridge を使う recomputePart が既定。 */
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
  const retained = new Set<string>();

  async function release(ref: string): Promise<void> {
    retained.delete(ref);
    cache.delete(ref);
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
    }
    if (version !== request.version) {
      cache.clear();
      version = request.version;
    }
    const references = new Set(request.document.components.flatMap((component) =>
      !component.suppressed && component.source.kind === 'part' ? [component.source.partRef] : [],
    ));
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
      const document = request.library.parts.get(ref);
      if (document === undefined) continue; // resolveAssembly が行ごとの欠落を知らせる。
      const attachments = request.library.attachments.get(ref);
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
    const resolved = resolveAssembly(request.document, { library: request.library, resolvedParts });
    messages.push(...resolved.errors.map((error) => error.message));
    useAppStore.setState({
      assemblyView: { resolved, bodies, appearances },
      isComputing: false, recomputeProgress: null, recomputeCancelled: false, cacheHits,
      errorMessage: messages.length === 0 ? null : messages.join('\n'),
    });
    useAppStore.getState().recordRecomputeCompletion(request.generation,
      messages.some((message) => message.includes(KERNEL_BROKEN_MESSAGE)) ? 'workerBroken' :
        messages.length > 0 ? 'failed' : 'success');
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
    if (active.kind === 'part') {
      latest = null;
      queued = null;
    } else {
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
    unsubscribe();
    if (!running) void releaseAll().catch(() => undefined);
  };
}
