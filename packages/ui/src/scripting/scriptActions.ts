import { SCRIPT_LIMITS, type ScriptFile, type ScriptFailure, type PreparedScriptTransaction } from '@pointercad/model/scripting';
import { useAppStore } from '../store/useAppStore.js';
import { activeDocumentKind } from '../store/documentKind.js';
import { placeNewFeatures } from '../shell/timelineMove.js';
import { t, type MessageKey } from '../i18n/t.js';
import { failureMessage, messageText } from '../i18n/failureMessage.js';
import { partErrorMessage } from '../solid/surfaceBodyFailureText.js';
import { draftFromScript, fileFromDraft, newScriptDraft } from './scriptDraft.js';
import { browserScriptStorage, readScriptLibrary } from './scriptLibrary.js';

export async function loadScriptLibrary(): Promise<void> {
  if (useAppStore.getState().scriptLibraryState !== 'unloaded') return;
  useAppStore.setState({ scriptLibraryState: 'loading' });
  const result = await readScriptLibrary(browserScriptStorage());
  useAppStore.setState(result.ok ? { scriptLibrary: result.tools, scriptLibraryState: 'ready' }
    : { scriptLibraryState: 'failed', scriptMessage: t('script.libraryFailed') });
}
export function openScriptPanel(file?: ScriptFile): void {
  const state = useAppStore.getState(); state.setActiveTool('select'); state.closeSheetMetalTool(); state.closeStrength();
  if (file !== undefined) state.cancelScript();
  useAppStore.setState({ scriptPanelOpen: true, scriptDraft: file === undefined ? state.scriptDraft ?? newScriptDraft() : draftFromScript(file),
    ...(file === undefined ? {} : { scriptError: null, scriptConsole: [], scriptPhase: 'idle', scriptRunLog: null }) });
  void loadScriptLibrary();
}
function releasePrepared(prepared: PreparedScriptTransaction): void {
  void prepared.release().catch((error: unknown) => {
    console.error('PointerCAD script release', error);
    useAppStore.setState({ scriptMessage: t('assembly.error.internal') });
  });
}
/** Retain temporary cache until the ordinary owner has completed, including cancellation/failure. */
function handOffPrepared(prepared: PreparedScriptTransaction): void {
  const initial = useAppStore.getState();
  const baseline = initial.completedGeneration;
  useAppStore.getState().applyDocument(prepared.document);
  const applied = useAppStore.getState().document;
  let unsubscribe = (): void => {};
  const check = (): void => {
    const state = useAppStore.getState();
    if (state.scriptExecutor !== initial.scriptExecutor || state.document !== applied || state.completedGeneration > baseline || !state.isComputing) {
      unsubscribe(); releasePrepared(prepared);
    }
  };
  unsubscribe = useAppStore.subscribe(check); check();
}
type ScriptFailureReason = Extract<ScriptFailure, { reason: string }>['reason'];
const reasonKeys = {
  badExecutionInput: 'script.error.badExecutionInput',
  badWorkerInput: 'script.error.badWorkerInput',
  badProgram: 'script.error.badProgram',
  programMismatch: 'script.error.programMismatch',
  snapshotBytes: 'script.error.snapshotBytes',
  runtimeTimeout: 'script.error.runtimeTimeout',
  totalTimeout: 'script.error.totalTimeout',
  heapLimit: 'script.error.heapLimit',
  stackLimit: 'script.error.stackLimit',
  rejectedPromises: 'script.error.rejectedPromises',
  pendingPromise: 'script.error.pendingPromise',
  unreadableGuestError: 'script.error.unreadableGuestError',
  moduleDenied: 'script.error.moduleDenied',
  commandCount: 'script.error.commandCount',
  commandRejected: 'script.error.commandRejected',
  logCount: 'script.error.logCount',
  logBytes: 'script.error.logBytes',
  tooManyCommands: 'script.error.tooManyCommands',
  tooManyCommandBytes: 'script.error.tooManyCommandBytes',
  tooManyLogs: 'script.error.tooManyLogs',
  tooManyLogBytes: 'script.error.tooManyLogBytes',
  referenceSequence: 'script.error.referenceSequence',
  referenceKind: 'script.error.referenceKind',
  finiteLength: 'script.error.finiteLength',
  functionSketch: 'script.error.functionSketch',
  parameterName: 'script.error.parameterName',
  parameterCycle: 'script.error.parameterCycle',
  missingSketch: 'script.error.missingSketch',
  sameSketchPoints: 'script.error.sameSketchPoints',
  sameSketchEdges: 'script.error.sameSketchEdges',
  missingExtrusionFace: 'script.error.missingExtrusionFace',
  holeOutside: 'script.error.holeOutside',
  cancelled: 'script.error.cancelled',
  internal: 'assembly.error.internal',
  unreadableSyntaxError: 'script.error.unreadableGuestError',
} satisfies Record<ScriptFailureReason, MessageKey>;
const reasonParameters = {
  javascriptSeconds: String(SCRIPT_LIMITS.javascriptMs / 1000),
  totalSeconds: String(SCRIPT_LIMITS.totalMs / 1000),
  heapMiB: String(SCRIPT_LIMITS.heapBytes / (1024 * 1024)),
  commands: String(SCRIPT_LIMITS.commands),
  consoleLines: String(SCRIPT_LIMITS.consoleLines),
  commandMiB: String(SCRIPT_LIMITS.commandBytes / (1024 * 1024)),
  consoleMiB: String(SCRIPT_LIMITS.consoleBytes / (1024 * 1024)),
};

export function scriptErrorText(error: ScriptFailure): string {
  if ('partError' in error) return partErrorMessage(error.partError);
  if ('text' in error) return failureMessage(error.text);
  if ('message' in error) return error.message;
  return messageText({ key: reasonKeys[error.reason], parameters: reasonParameters });
}
function fail(error: ScriptFailure): void { useAppStore.setState({ scriptPhase: 'failed', scriptError: error, scriptRequestId: null, scriptController: null }); }
export async function runScript(file?: ScriptFile): Promise<void> {
  const initial = useAppStore.getState();
  if (initial.scriptRequestId !== null) return;
  if (activeDocumentKind(initial) !== 'part') {
    openScriptPanel(file); fail({ kind: 'cad', message: t('script.partOnly'), location: null }); return;
  }
  const executor = initial.scriptExecutor;
  if (executor === null) { fail({ kind: 'worker', message: t('script.unavailable'), location: null }); return; }
  if (file !== undefined) openScriptPanel(file);
  const start = useAppStore.getState(), draft = start.scriptDraft;
  if (draft === null) return;
  const requestId = crypto.randomUUID(), controller = new AbortController();
  useAppStore.setState({ scriptRequestId: requestId, scriptController: controller, scriptPhase: 'validating', scriptError: null,
    scriptConsole: [], scriptRunLog: null, scriptMessage: null });
  const stale = (): boolean => {
    const current = useAppStore.getState();
    return current.document !== start.document || current.activeDocumentId !== start.activeDocumentId || current.documentVersion !== start.documentVersion
      || current.timelineIndex !== start.timelineIndex || activeDocumentKind(current) !== 'part' || current.scriptDraft !== draft
      || current.displaySettings.lengthUnit !== start.displaySettings.lengthUnit || current.importedShapes !== start.importedShapes;
  };
  const unsubscribe = useAppStore.subscribe(() => {
    if (!stale() || useAppStore.getState().scriptRequestId !== requestId) return;
    controller.abort(); fail({ kind: 'stale', message: t('script.stale'), location: null });
  });
  try {
    const checked = file === undefined ? await fileFromDraft(draft) : { ok: true, file };
    if (controller.signal.aborted || useAppStore.getState().scriptRequestId !== requestId) return;
    if (!checked.ok || !('file' in checked)) { fail({ kind: 'source', message: t('script.invalidInput'), location: null }); return; }
    const script = checked.file;
    const result = await executor({ requestId, documentEpoch: `${start.activeDocumentId}:${start.documentVersion}`, document: start.document,
      program: script.program, lengthUnit: start.displaySettings.lengthUnit, seed: script.seed, timeMs: script.timeMs, importedShapes: start.importedShapes,
      placeDocument: document => placeNewFeatures(start.document, document, start.timelineIndex).document }, controller.signal,
    phase => { if (useAppStore.getState().scriptRequestId === requestId) useAppStore.setState({ scriptPhase: phase }); });
    if (controller.signal.aborted || stale() || useAppStore.getState().scriptRequestId !== requestId) {
      if (result.ok && result.prepared !== null) releasePrepared(result.prepared); return;
    }
    unsubscribe();
    if (!result.ok) { fail(result.error); useAppStore.setState({ scriptConsole: result.console }); return; }
    if (result.prepared !== null) handOffPrepared(result.prepared);
    useAppStore.setState({ scriptRequestId: null, scriptController: null, scriptPhase: 'succeeded', scriptConsole: result.console,
      scriptRunLog: { seed: script.seed, timeMs: script.timeMs, apiVersion: script.program.apiVersion, sha256: script.program.sha256,
        commandCount: result.commandCount, initializationMs: result.initializationMs, javascriptMs: result.javascriptMs, cadMs: result.cadMs } });
  } catch (error) {
    if (useAppStore.getState().scriptRequestId === requestId) {
      console.error('PointerCAD script', error);
      fail({ kind: 'worker', reason: 'internal', location: null });
    }
  } finally { unsubscribe(); }
}
