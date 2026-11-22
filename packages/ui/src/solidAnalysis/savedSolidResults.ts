/**
 * 部品の立体の静解析の結果の保存と開き直し(J-03b 段 2)。保存の束へ入れる結果と、開いた結果を会話へ戻す判定を、
 * 店と画面から切り離した純関数で持つ(梁の段 1 の beam/savedBeamResults.ts と同じ考え)。
 * 結果の指紋(保存した時の文書との結び付け)の照らしは io(pcadFile.ts)が行う。ここでは、保存した定義と会話の入力が同じか、
 * 保存した解く前の入力の指紋が結果の inputSha256 と合うか(fem の solidInputSha256。io は fem を読めない)だけを見る。
 */
import { decodeSolidAnalysis, solidInputSha256, type CadSolidOutcome } from '@pointercad/fem';
import type { ReadPcadFileResult } from '@pointercad/io';
import type { PartDocument } from '@pointercad/model';
import type { SavedAnalysisResult } from '@pointercad/model/beam-analysis';
import { currentAppVersion } from '../app/appVersion.js';
import type { MessageKey } from '../i18n/t.js';
import { solidSavedInput, type SolidAnalysisSession } from './solidAnalysisSession.js';

type SolidOutcome = Extract<CadSolidOutcome, { readonly kind: 'result' }>;
export type SavedSolid = Extract<SavedAnalysisResult, { readonly kind: 'oofem-linear-solid-tet4' }>;
type ReadIssue = NonNullable<Extract<ReadPcadFileResult, { readonly ok: true }>['analysisResultIssue']>;

/** 保存した結果を出せない理由の符号。io の読みの断りと、ここで断る 2 つと、自動保存の控えから戻した時(控えに結果を入れない)。 */
export type SavedSolidNotice = ReadIssue | 'inputMismatch' | 'noSolverInput' | 'recoveryCopy';

/** 符号ごとの文(利用者の回答 2026-11-20 18:2x (3): 計算部は符号だけを返し、文は画面の側の 1 つの一覧に持つ)。 */
export const SAVED_SOLID_NOTICE_KEYS: Readonly<Record<SavedSolidNotice, MessageKey>> = {
  invalidResult: 'solidAnalysis.savedResult.invalid',
  unknownSchema: 'solidAnalysis.savedResult.newer',
  unknownKind: 'solidAnalysis.savedResult.newer',
  bindingMismatch: 'solidAnalysis.savedResult.changed',
  resultTooLarge: 'solidAnalysis.savedResult.tooLarge',
  inputMismatch: 'solidAnalysis.savedResult.inputMismatch',
  noSolverInput: 'solidAnalysis.savedResult.noSolverInput',
  recoveryCopy: 'solidAnalysis.savedResult.recovery',
};

/** 開いた部品の文書と組にした、開いた時の結果。文書が別の物になれば使わない(古い結果を今の物と見せない)。 */
export interface OpenedSolidResults {
  readonly document: PartDocument;
  readonly results: ReadonlyMap<string, SavedAnalysisResult>;
  /** io が出さなかった結果があった時の符号(ファイル自体は開けた)。 */
  readonly issue: ReadIssue | null;
  /**
   * 出どころ。file は開いたファイル、recovery は自動保存の控え(控えには結果を入れないので、結果が無い理由を窓に出す。
   * 静解析の入力を保存した部品の時だけ。入力の無い部品は解析を使っていないので立てない。統括の決定 2026-11-22 09:04)、
   * kept は窓を閉じる時に残した計算の結果(J-03b の残り。保存すると部品と一緒に残り、窓を開き直すと戻る)。
   */
  readonly origin: 'file' | 'recovery' | 'kept';
}

function savedDefinition(document: PartDocument) {
  const saved = document.beamAnalysisInputs?.analyses.find(value => value.kind === 'solid-cad');
  return saved?.kind === 'solid-cad' ? saved.definition : undefined;
}

export function openedSolidResults(document: PartDocument, results: ReadonlyMap<string, SavedAnalysisResult> | undefined,
  issue: ReadIssue | undefined, origin: 'file' | 'recovery' = 'file'): OpenedSolidResults | null {
  const kept = results ?? new Map<string, SavedAnalysisResult>();
  const from = origin === 'recovery' && savedDefinition(document) === undefined ? 'file' : origin;
  return kept.size === 0 && issue === undefined && from === 'file' ? null
    : { document, results: kept, issue: issue ?? null, origin: from };
}

/** 開いた時の結果が無い時に窓へ出す理由(io の断り、または控えから戻した事)。開いた文書のままの時だけ。 */
export function openedSolidNotice(document: PartDocument, opened: OpenedSolidResults | null): SavedSolidNotice | null {
  if (opened === null || opened.document !== document) return null;
  return opened.issue ?? (opened.origin === 'recovery' ? 'recoveryCopy' : null);
}

/** 今の文書でまだ使える、開いた時の立体の結果(同じ文書の物で、保存した定義の id の物だけ)。 */
export function openedSolidResult(document: PartDocument, opened: OpenedSolidResults | null): SavedSolid | undefined {
  const definition = savedDefinition(document);
  if (opened === null || opened.document !== document || definition === undefined) return undefined;
  const saved = opened.results.get(definition.id);
  return saved?.kind === 'oofem-linear-solid-tet4' ? saved : undefined;
}

/**
 * 会話の今の入力が、文書に保存した定義と同じか。保存の束へ会話の結果を入れる時と、開いた結果を会話へ戻す時の共通の照らし
 * (窓の値を変えた後に、保存した入力の結果を今の入力の結果と見せない)。入力を読めない時と、定義が無い時は同じとしない。
 */
export function sessionMatchesSavedInput(document: PartDocument, session: SolidAnalysisSession): boolean {
  const definition = savedDefinition(document);
  if (definition === undefined) return false;
  try {
    return JSON.stringify(solidSavedInput(session, document.id, document.parameters)) === JSON.stringify(definition);
  } catch {
    return false;
  }
}

/** 会話の結果が、文書に保存した定義と同じ入力から、今の形で流し終えた物か。 */
function currentSessionResult(document: PartDocument, session: SolidAnalysisSession | null, generation: number): SolidOutcome | null {
  const outcome = session?.result ?? null;
  if (session === null || session.status !== 'complete' || outcome === null
    || outcome.result.source.documentId !== document.id || outcome.result.source.revision !== generation) return null;
  return sessionMatchesSavedInput(document, session) ? outcome : null;
}

interface SolidSaveState {
  readonly solidAnalysisSession: SolidAnalysisSession | null;
  readonly completedGeneration: number;
  readonly solidOpenedResults: OpenedSolidResults | null;
}

/** 会話の今の結果を、保存の束の 1 行の形にする(保存した定義と同じ入力の、今の形の結果だけ。版が分からない時は作らない)。 */
function currentSavedEntry(state: SolidSaveState, document: PartDocument, appVersion: string | null): SavedSolid | null {
  const definition = savedDefinition(document);
  const outcome = currentSessionResult(document, state.solidAnalysisSession, state.completedGeneration);
  if (appVersion === null || definition === undefined || outcome === null) return null;
  return { analysisId: definition.id, kind: outcome.result.kind, analysisRevision: 0, bindingSha256: '',
    appVersion, result: outcome.result, mesh: outcome.mesh, prepared: outcome.prepared };
}

/**
 * 店から、保存の束へ入れる立体の結果を作る(手動の保存の式)。会話の結果が保存した定義と同じ入力の今の結果ならそれを入れ、
 * そうでなく、開いた時の結果(窓を閉じる時に残した結果を含む)がまだ使えるならそれを入れる(開いて流し直さずに保存し直しても
 * 結果を落とさない)。版が分からない時は入れない。
 */
export function solidResultsToSave(state: SolidSaveState, document: PartDocument,
  appVersion = currentAppVersion()): ReadonlyMap<string, SavedAnalysisResult> | undefined {
  const current = currentSavedEntry(state, document, appVersion);
  if (current !== null) return new Map([[current.analysisId, current]]);
  const definition = savedDefinition(document), reopened = openedSolidResult(document, state.solidOpenedResults);
  return appVersion === null || definition === undefined || reopened === undefined ? undefined : new Map([[definition.id, reopened]]);
}

/**
 * 窓を閉じる時に残す結果(J-03b の残り)。会話の今の結果が保存の条件を満たす時だけ、この文書と組にした kept の組を返す。
 * 閉じた後も、保存すれば部品と一緒に残り、文書が同じ物の間に窓を開き直せば、開いたファイルの結果と同じ照らしで戻る。
 */
export function keptSolidResults(state: SolidSaveState, document: PartDocument,
  appVersion = currentAppVersion()): OpenedSolidResults | null {
  const current = currentSavedEntry(state, document, appVersion);
  return current === null ? null : { document, results: new Map([[current.analysisId, current]]), issue: null, origin: 'kept' };
}

/** 開いた結果を会話へ戻した形。保存した世代の数は、開いた後の今の世代に置き換える(文書は io の指紋で同じと確かめ済み)。 */
export type SolidRestore =
  | { readonly kind: 'restored'; readonly outcome: SolidOutcome }
  | { readonly kind: 'refused'; readonly notice: 'inputMismatch' }
  | { readonly kind: 'limited'; readonly notice: 'noSolverInput' };

/**
 * 開いた結果を会話へ戻す。まず保存した解く前の入力の指紋が結果の inputSha256 と合うかを照らし、合わなければ断る。
 * 合えば、世代の数だけを今の世代に置き換えた入力の指紋を取り直し、結果は保存した元の力(nativeElementForcesN)から
 * 計算の後と同じ読み(decodeSolidAnalysis)で作り直す。これで降伏比・CSV・要素の値の読み・疲労が行う照らし
 * (入力の指紋と結果の一致)を、計算し直した時と同じ形で通る。読めない時も断る。
 */
export async function restoreSavedSolid(saved: SavedSolid, generation: number): Promise<SolidRestore> {
  const prepared = saved.prepared;
  // 解く前の入力を持たない形(19 回目の io の段で保存した物)は、絞った表示に落とす。
  if (prepared === undefined) return { kind: 'limited', notice: 'noSolverInput' };
  const refused = { kind: 'refused', notice: 'inputMismatch' } as const;
  const now = <T extends { readonly revision: number }>(source: T): T => ({ ...source, revision: generation });
  try {
    if (await solidInputSha256(prepared.input) !== saved.result.inputSha256) return refused;
    const input = { ...prepared.input, source: now(prepared.input.source) }, hash = await solidInputSha256(input);
    const native = saved.result;
    const result = decodeSolidAnalysis({ schema: 'pointercad-solid-tet4-native/1', source: input.source,
      displacementMm: native.displacementMm, elementForcesN: native.nativeElementForcesN,
      reservedNumericBytes: native.reservedNumericBytes, minimumScaledPivot: native.minimumScaledPivot,
      ...(native.reactionsN === undefined ? {} : { reactionsN: native.reactionsN }) }, input, hash);
    return { kind: 'restored', outcome: { kind: 'result', result, prepared: { ...prepared, input },
      mesh: { ...saved.mesh, input: { ...saved.mesh.input, source: now(saved.mesh.input.source) } } } };
  } catch {
    return refused;
  }
}
