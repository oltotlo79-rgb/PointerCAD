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

/** 保存した結果を出せない理由の符号。io の読みの断りと、ここで断る 2 つ。 */
export type SavedSolidNotice = ReadIssue | 'inputMismatch' | 'noSolverInput';

/** 符号ごとの文(利用者の回答 2026-11-20 18:2x (3): 計算部は符号だけを返し、文は画面の側の 1 つの一覧に持つ)。 */
export const SAVED_SOLID_NOTICE_KEYS: Readonly<Record<SavedSolidNotice, MessageKey>> = {
  invalidResult: 'solidAnalysis.savedResult.invalid',
  unknownSchema: 'solidAnalysis.savedResult.newer',
  unknownKind: 'solidAnalysis.savedResult.newer',
  bindingMismatch: 'solidAnalysis.savedResult.changed',
  resultTooLarge: 'solidAnalysis.savedResult.tooLarge',
  inputMismatch: 'solidAnalysis.savedResult.inputMismatch',
  noSolverInput: 'solidAnalysis.savedResult.noSolverInput',
};

/** 開いた部品の文書と組にした、開いた時の結果。文書が別の物になれば使わない(古い結果を今の物と見せない)。 */
export interface OpenedSolidResults {
  readonly document: PartDocument;
  readonly results: ReadonlyMap<string, SavedAnalysisResult>;
  /** io が出さなかった結果があった時の符号(ファイル自体は開けた)。 */
  readonly issue: ReadIssue | null;
}

export function openedSolidResults(document: PartDocument, results: ReadonlyMap<string, SavedAnalysisResult> | undefined,
  issue: ReadIssue | undefined): OpenedSolidResults | null {
  const kept = results ?? new Map<string, SavedAnalysisResult>();
  return kept.size === 0 && issue === undefined ? null : { document, results: kept, issue: issue ?? null };
}

function savedDefinition(document: PartDocument) {
  const saved = document.beamAnalysisInputs?.analyses.find(value => value.kind === 'solid-cad');
  return saved?.kind === 'solid-cad' ? saved.definition : undefined;
}

/** 今の文書でまだ使える、開いた時の立体の結果(同じ文書の物で、保存した定義の id の物だけ)。 */
export function openedSolidResult(document: PartDocument, opened: OpenedSolidResults | null): SavedSolid | undefined {
  const definition = savedDefinition(document);
  if (opened === null || opened.document !== document || definition === undefined) return undefined;
  const saved = opened.results.get(definition.id);
  return saved?.kind === 'oofem-linear-solid-tet4' ? saved : undefined;
}

/** 会話の結果が、文書に保存した定義と同じ入力から、今の形で流し終えた物か。 */
function currentSessionResult(document: PartDocument, session: SolidAnalysisSession | null, generation: number): SolidOutcome | null {
  const definition = savedDefinition(document), outcome = session?.result ?? null;
  if (session === null || session.status !== 'complete' || outcome === null || definition === undefined
    || outcome.result.source.documentId !== document.id || outcome.result.source.revision !== generation) return null;
  try {
    return JSON.stringify(solidSavedInput(session, document.id, document.parameters)) === JSON.stringify(definition) ? outcome : null;
  } catch {
    return null;
  }
}

/**
 * 店から、保存の束へ入れる立体の結果を作る(手動の保存と自動の保存の 2 か所で同じ式)。会話の結果が保存した定義と同じ入力の
 * 今の結果ならそれを入れ、そうでなく、開いた時の結果がまだ使えるならそれを入れる(開いて流し直さずに保存し直しても結果を
 * 落とさない)。版が分からない時は入れない。
 */
export function solidResultsToSave(state: { readonly solidAnalysisSession: SolidAnalysisSession | null;
  readonly completedGeneration: number; readonly solidOpenedResults: OpenedSolidResults | null },
document: PartDocument, appVersion = currentAppVersion()): ReadonlyMap<string, SavedAnalysisResult> | undefined {
  const definition = savedDefinition(document);
  if (appVersion === null || definition === undefined) return undefined;
  const outcome = currentSessionResult(document, state.solidAnalysisSession, state.completedGeneration);
  if (outcome !== null) {
    return new Map([[definition.id, { analysisId: definition.id, kind: outcome.result.kind, analysisRevision: 0, bindingSha256: '',
      appVersion, result: outcome.result, mesh: outcome.mesh, prepared: outcome.prepared }]]);
  }
  const reopened = openedSolidResult(document, state.solidOpenedResults);
  return reopened === undefined ? undefined : new Map([[definition.id, reopened]]);
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
