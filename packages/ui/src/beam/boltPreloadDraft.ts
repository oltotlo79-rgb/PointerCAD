import { readCadNativeBoltPreloadSavedInput, type BoltPreloadDeclaration,
  type CadNativeBoltPreloadSavedInput, type PropertySource } from '@pointercad/model/beam-analysis';
import { prepareCadNativeBoltPreload, type NativeBoltPreloadOwnedResult,
  type NativeBoltPreloadWireInput } from '@pointercad/fem';
import type { AppState } from '../store/appState.js';
import { beamSourceIsCurrent, type BeamSourceSnapshot } from './beamSource.js';

export type BoltDraftNumber = 'preloadN' | 'threadCompliance' | 'headCompliance' | 'bearingCompliance' | 'memberCompliance';
export type BoltDraftSource = BoltDraftNumber | 'modelSource' | 'shankSource' | 'shorteningSource' | 'loadSource';
export interface BoltPreloadDraft {
  readonly saved: CadNativeBoltPreloadSavedInput;
  readonly revision: number;
  /** Exactly N and m/N, respectively. No display-unit conversion or inferred values. */
  readonly values: Readonly<Record<BoltDraftNumber, string>>;
  readonly sources: Readonly<Record<BoltDraftSource, PropertySource>>;
  readonly loadsN: readonly string[];
  readonly confirmed: boolean;
  readonly reviewed: { readonly source: BeamSourceSnapshot; readonly wire: NativeBoltPreloadWireInput; readonly inputSha256: string } | null;
  /** Reserved for a later owning, numeric-decoded Worker completion; this module never accepts replies. */
  readonly result: NativeBoltPreloadOwnedResult | null;
}
export type BoltDraftEdit = { readonly kind: 'number'; readonly field: BoltDraftNumber; readonly text: string }
  | { readonly kind: 'source'; readonly field: BoltDraftSource; readonly value: PropertySource }
  | { readonly kind: 'loads'; readonly valuesN: readonly string[] };

export function restoreBoltPreloadDraft(value: unknown): BoltPreloadDraft {
  const saved = readCadNativeBoltPreloadSavedInput(value), d = saved.input.declaration;
  return { saved, revision: saved.revision,
    values: { preloadN: String(d.preloadN.value), threadCompliance: String(d.threadCompliance.value),
      headCompliance: String(d.headCompliance.value), bearingCompliance: String(d.bearingCompliance.value), memberCompliance: String(d.memberCompliance.value) },
    sources: { preloadN: d.preloadN.source, threadCompliance: d.threadCompliance.source, headCompliance: d.headCompliance.source,
      bearingCompliance: d.bearingCompliance.source, memberCompliance: d.memberCompliance.source,
      modelSource: d.modelSource, shankSource: d.shankSource, shorteningSource: d.shorteningSource, loadSource: d.loadSource },
    loadsN: d.externalLoadsN.map(String), confirmed: false, reviewed: null, result: null };
}
export function invalidateBoltPreloadDraft(session: BoltPreloadDraft): BoltPreloadDraft {
  return { ...session, confirmed: false, reviewed: null, result: null };
}
export function editBoltPreloadDraft(session: BoltPreloadDraft, edit: BoltDraftEdit): BoltPreloadDraft {
  if (!Number.isSafeInteger(session.revision + 1)) throw new Error('bolt-draft-revision');
  const next = { ...invalidateBoltPreloadDraft(session), revision: session.revision + 1 };
  switch (edit.kind) {
    case 'number': return { ...next, values: { ...session.values, [edit.field]: edit.text } };
    case 'source': return { ...next, sources: { ...session.sources, [edit.field]: edit.value } };
    case 'loads': return { ...next, loadsN: [...edit.valuesN] };
    default: { const exhaustive: never = edit; return exhaustive; }
  }
}
function number(text: string): number {
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/iu.test(text.trim())) throw new Error('bolt-draft-number');
  const value = Number(text);
  if (!Number.isFinite(value) || value < 0) throw new Error('bolt-draft-number');
  return value;
}
/** Authored values only. Synchronize revisions and explicit stage order, never geometry or physics. */
export function boltPreloadDraftSavedInput(session: BoltPreloadDraft): CadNativeBoltPreloadSavedInput {
  const base = session.saved, d = base.input.declaration, bolts = base.cadDefinition.axialBolts;
  if (bolts === undefined) throw new Error('bolt-draft-association');
  const sourced = (key: BoltDraftNumber) => ({ value: number(session.values[key]), source: session.sources[key] });
  const declaration: BoltPreloadDeclaration = { ...d, modelSource: session.sources.modelSource,
    shankSource: session.sources.shankSource, shorteningSource: session.sources.shorteningSource,
    preloadN: sourced('preloadN'), threadCompliance: sourced('threadCompliance'), headCompliance: sourced('headCompliance'),
    bearingCompliance: sourced('bearingCompliance'), memberCompliance: sourced('memberCompliance'),
    externalLoadsN: session.loadsN.map(number), loadSource: session.sources.loadSource };
  return readCadNativeBoltPreloadSavedInput({ ...base, revision: session.revision,
    input: { ...base.input, analysisRevision: session.revision, declaration },
    cadDefinition: { ...base.cadDefinition, revision: session.revision,
      contact: { ...base.cadDefinition.contact, loadFactors: [0, ...declaration.externalLoadsN] },
      axialBolts: { ...bolts, analysisRevision: session.revision,
        bolts: bolts.bolts.map(bolt => ({ ...bolt, propertySource: session.sources.shankSource })) } } });
}
export function confirmBoltPreloadDraft(session: BoltPreloadDraft, confirmed: boolean): BoltPreloadDraft {
  if (confirmed) boltPreloadDraftSavedInput(session);
  return { ...session, confirmed, reviewed: null, result: null };
}
/** Getter supplies actual store ownership and the latest session after each asynchronous boundary. */
export async function reviewBoltPreloadDraft(session: BoltPreloadDraft, source: BeamSourceSnapshot,
  current: () => { readonly state: AppState; readonly session: BoltPreloadDraft | null }): Promise<BoltPreloadDraft> {
  const live = () => { const c = current(); return c.session === session && beamSourceIsCurrent(source, c.state); };
  if (!session.confirmed || !live()) throw new Error('bolt-draft-confirmation-or-source');
  const saved = boltPreloadDraftSavedInput(session);
  const prepared = await prepareCadNativeBoltPreload(source.document, saved.cadDefinition, saved.input,
    { currentSource: source.source, bodies: source.ownership.bodies,
      assemblyOptions: { library: source.library, subAssemblies: source.library.assemblies },
      ...(source.jointOccurrence === undefined ? {} : { jointOccurrence: source.jointOccurrence }) });
  if (!live()) throw new Error('bolt-draft-stale-review');
  return { ...session, reviewed: { source, wire: prepared.wire, inputSha256: prepared.inputSha256 }, result: null };
}
export function reviewedBoltPreloadWire(session: BoltPreloadDraft, state: AppState): NativeBoltPreloadWireInput {
  if (!session.confirmed || session.reviewed === null || !beamSourceIsCurrent(session.reviewed.source, state)) throw new Error('bolt-draft-not-reviewed');
  return session.reviewed.wire;
}
