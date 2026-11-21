/**
 * 梁の静解析の結果の保存(J-03b 段 1)。保存の束へ入れる結果と、開いたファイルの結果を梁の会話へ戻す判定を、店と画面から切り離した純関数で持つ。
 * 結果の指紋(保存した時の入力との結び付け)の計算と照合は io(pcadFile.ts)が行い、指紋が合った結果だけが開いた束に入る。
 * ここでは「開いた文書のまま(同じ物)」かと「結果の解析の id・revision が今の定義と同じ」かだけを見る。部品の文書の結果は段 1 では保存しない。
 */
import { sha256HexSync, type AssemblyDocument } from '@pointercad/model';
import type { BeamAnalysisResult, SavedAnalysisResult } from '@pointercad/model/beam-analysis';
import { currentAppVersion } from '../app/appVersion.js';
import type { BeamDefinition, BeamSession } from './beamSession.js';

/**
 * 文書と組にした解析の結果。形を変える確定で文書が別の物になると使わない(古い結果を今の入力の物と見せない)。
 * origin は出どころ: file は開いたファイルの指紋が合った結果、applied は計算に使った入力のまま「入力を文書に反映」した結果(J-03d)。
 */
export interface OpenedAnalysisResults {
  readonly document: AssemblyDocument;
  readonly results: ReadonlyMap<string, SavedAnalysisResult>;
  /** 保存してあった結果を、指紋の不一致・壊れた中身で io が出さなかった(ファイル自体は開けた)。窓に理由を 1 行出す。 */
  readonly dropped: boolean;
  readonly origin: 'file' | 'applied';
}

/** 開いた束の結果を、開いた文書と組にする。結果も出さなかった結果も無ければ null。 */
export function openedAnalysisResults(document: AssemblyDocument,
  results: ReadonlyMap<string, SavedAnalysisResult> | undefined, dropped = false): OpenedAnalysisResults | null {
  const kept = results ?? new Map<string, SavedAnalysisResult>();
  return kept.size === 0 && !dropped ? null : { document, results: kept, dropped, origin: 'file' };
}

/** 開いた文書のままで、保存してあった結果を出さなかった事を窓に知らせるか。 */
export function savedBeamResultDropped(document: AssemblyDocument | null, opened: OpenedAnalysisResults | null): boolean {
  return document !== null && opened !== null && opened.document === document && opened.dropped;
}

function savedDefinitionRevision(document: AssemblyDocument, analysisId: string): number | null {
  for (const input of document.beamAnalysisInputs?.analyses ?? []) {
    if (input.kind === 'standard-members' && input.definition.id === analysisId) return input.definition.revision;
  }
  return null;
}

function isStaticResult(result: BeamSession['result']): result is BeamAnalysisResult {
  return result !== null && result.kind === 'oofem-linear-beam-3d';
}

/** 今の文書でまだ使える、開いた時の結果(同じ文書の物で、保存した定義と id・revision が合う物だけ)。 */
function currentOpened(document: AssemblyDocument, opened: OpenedAnalysisResults | null): ReadonlyMap<string, SavedAnalysisResult> {
  if (opened === null || opened.document !== document) return new Map();
  return new Map([...opened.results].filter(([id, saved]) => savedDefinitionRevision(document, id) === saved.analysisRevision));
}

/**
 * 保存の束へ入れる梁の結果。会話の結果が、文書に保存した定義と同じ id・revision の静解析で、流し終えた物ならそれを入れる。
 * そうでなく、開いた時の結果がまだ使えるならそれを入れる(開いて流し直さずに保存し直しても結果を落とさない)。版が分からない時は入れない。
 */
export function savedBeamResults(document: AssemblyDocument, session: BeamSession | null, opened: OpenedAnalysisResults | null,
  appVersion: string | null): ReadonlyMap<string, SavedAnalysisResult> | undefined {
  const results = new Map(currentOpened(document, opened));
  const result = session?.result ?? null;
  if (appVersion !== null && session !== null && session.status === 'complete' && isStaticResult(result)
    && result.analysisId === session.analysisId && savedDefinitionRevision(document, result.analysisId) === result.analysisRevision) {
    results.set(result.analysisId, { analysisId: result.analysisId, kind: result.kind, analysisRevision: result.analysisRevision,
      bindingSha256: '', appVersion, result });
  }
  return results.size === 0 ? undefined : results;
}

/** 店から、保存の束へ入れる梁の結果を作る(手動の保存と自動の保存の 2 か所で同じ式)。 */
export function analysisResultsToSave(state: { readonly beamSession: BeamSession | null;
  readonly assemblyOpenedAnalysisResults: OpenedAnalysisResults | null }, document: AssemblyDocument): ReadonlyMap<string, SavedAnalysisResult> | undefined {
  return savedBeamResults(document, state.beamSession, state.assemblyOpenedAnalysisResults, currentAppVersion());
}

/** 梁の窓を開いた会話へ、開いた時の結果を戻す。今の文書のまま・定義の id と revision が合う時だけ。 */
export function withOpenedBeamResult(session: BeamSession, document: AssemblyDocument | null,
  opened: OpenedAnalysisResults | null): BeamSession {
  if (document === null) return session;
  const saved = currentOpened(document, opened).get(session.analysisId);
  return saved === undefined || saved.analysisRevision !== session.revision ? session : { ...session, result: saved.result };
}

/** 窓に「保存した結果」と出す物。会話の結果が、今の文書のまま使える開いた時の結果そのもので、id・revision が会話と合う時だけ。 */
export function shownSavedBeamResult(session: BeamSession, document: AssemblyDocument | null,
  opened: OpenedAnalysisResults | null): SavedAnalysisResult | null {
  if (document === null || session.result === null) return null;
  const saved = currentOpened(document, opened).get(session.analysisId);
  return saved !== undefined && saved.result === session.result && saved.analysisRevision === session.revision ? saved : null;
}

/** 計算した時の入力の指紋(J-03d)。結果と組で店に置き、結果がその入力から出た物かを、数字の revision ではなく中身で照らす。 */
export interface BeamResultDefinition {
  readonly result: NonNullable<BeamSession['result']>;
  readonly definitionSha256: string;
}

/** 解析の定義の中身の指紋(UTF-8 の JSON の SHA-256)。同じ会話と確かめた形から作る定義は、同じ文字になる。 */
export function beamDefinitionFingerprint(definition: BeamDefinition): string {
  return sha256HexSync(new TextEncoder().encode(JSON.stringify(definition)));
}

/**
 * 「入力を文書に反映」の時に残してよい静解析の結果。会話の結果が流し終えた静解析で、計算した時の指紋の組が同じ結果の物で、
 * 反映する定義の中身の指紋・id・revision が計算した時と同じ時だけ返す。版が分からない時は残さない(保存の決まりと同じ)。
 */
export function keptResultOnApply(session: BeamSession, definition: BeamDefinition, recorded: BeamResultDefinition | null,
  appVersion: string | null): SavedAnalysisResult | null {
  const result = session.result;
  if (appVersion === null || session.status !== 'complete' || !isStaticResult(result) || recorded?.result !== result) return null;
  if (result.analysisId !== definition.id || result.analysisRevision !== definition.revision
    || recorded.definitionSha256 !== beamDefinitionFingerprint(definition)) return null;
  return { analysisId: result.analysisId, kind: result.kind, analysisRevision: result.analysisRevision, bindingSha256: '', appVersion, result };
}

/** 反映した後の文書と、残した結果を組にする(文書が別の物になれば、開いた時の結果と同じく使わない)。 */
export function appliedAnalysisResults(document: AssemblyDocument, saved: SavedAnalysisResult): OpenedAnalysisResults {
  return { document, results: new Map([[saved.analysisId, saved]]), dropped: false, origin: 'applied' };
}
