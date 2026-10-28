import { partKeyOf } from '@pointercad/model';
import { readCadNativeBoltPreloadSavedInput, type CadNativeBoltPreloadSavedInput, type StandardBeamContactDefinition, type PropertySource } from '@pointercad/model/beam-analysis';
import { prepareCadNativeBoltPreload } from '@pointercad/fem';
import type { FemPhase } from '@pointercad/fem';
import { restoreBoltPreloadDraft, editBoltPreloadDraft, confirmBoltPreloadDraft, invalidateBoltPreloadDraft, reviewBoltPreloadDraft, reviewedBoltPreloadWire, boltPreloadDraftSavedInput, type BoltPreloadDraft, type BoltDraftEdit } from '../beam/boltPreloadDraft.js';
import type { StateCreator } from 'zustand';
import { withBeamAnalysisInputs } from '@pointercad/model/beam-analysis';
import { beamDefinition, createBeamSession, editBeamSession, invalidateBeamSession, restoreBeamSession,
  type BeamEdit, type BeamSession } from '../beam/beamSession.js';
import { beamOccurrences, beamSourceIsCurrent, captureBeamSource, type BeamSourceSnapshot } from '../beam/beamSource.js';
import type { AppState } from './appState.js';
import { prepareBeamAnalysis } from '../beam/prepareBeamAnalysis.js';

export interface BeamRunner {
  run(session: BeamSession, source: BeamSourceSnapshot): void;
  cancel(): void;
}
export interface BoltPreloadRunner { run(draft: BoltPreloadDraft): void; cancel(): void }
export type BoltPreloadStatus = 'editing' | 'reviewing' | 'running' | 'complete' | 'cancelled' | 'failed';

export interface BeamSlice {
  readonly boltPreloadOwner: AppState['strengthSession'];
  readonly boltPreloadAuthor: BoltAuthorForm | null;
  readonly beginBoltPreloadAuthor: (templateKey: string, reassociate: boolean) => void;
  readonly editBoltPreloadAuthor: (edit: BoltAuthorEdit) => void;
  readonly previewBoltPreloadAuthor: () => Promise<void>;
  readonly acceptBoltPreloadAuthor: () => void;
  readonly cancelBoltPreloadAuthor: () => void;
  readonly boltPreloadDraft: BoltPreloadDraft | null;
  readonly boltPreloadStatus: BoltPreloadStatus;
  readonly boltPreloadPhase: FemPhase | null;
  readonly boltPreloadError: string | null;
  readonly boltPreloadRunner: BoltPreloadRunner | null;
  readonly setBoltPreloadRunner: (runner: BoltPreloadRunner | null) => void;
  readonly openBoltPreload: (id: string) => void;
  readonly editBoltPreload: (edit: BoltDraftEdit) => void;
  readonly confirmBoltPreload: (confirmed: boolean) => void;
  readonly reviewBoltPreload: () => Promise<void>;
  readonly runBoltPreload: () => void;
  readonly cancelBoltPreload: () => void;
  readonly closeBoltPreload: () => void;
  readonly applyBoltPreloadInputs: () => void;

  readonly beamSession: BeamSession | null;
  readonly beamRunner: BeamRunner | null;
  readonly setBeamRunner: (runner: BeamRunner | null) => void;
  readonly openBeam: () => void;
  readonly closeBeam: () => void;
  readonly editBeam: (edit: BeamEdit) => void;
  readonly reviewBeam: () => void;
  readonly runBeam: () => void;
  readonly cancelBeam: () => void;
  readonly applyBeamInputs: () => void;
}


export const BOLT_AUTHOR_NUMBERS = ["young0", "shear0", "density0", "area0", "iy0", "iz0", "torsion0", "factor0", "young1", "shear1", "density1", "area1", "iy1", "iz1", "torsion1", "factor1", "boltYoung", "boltArea", "preloadN", "threadCompliance", "headCompliance", "bearingCompliance", "memberCompliance"] as const;
export const BOLT_AUTHOR_EVIDENCE = ["material0", "section0", "material1", "section1", "modelSource", "shankSource", "shorteningSource", "preloadN", "threadCompliance", "headCompliance", "bearingCompliance", "memberCompliance", "loadSource"] as const;
export type BoltAuthorNumber = typeof BOLT_AUTHOR_NUMBERS[number];
export type BoltAuthorEvidence = typeof BOLT_AUTHOR_EVIDENCE[number];
function emptyBoltAuthorNumbers(): Record<BoltAuthorNumber, string> { return { young0: '', shear0: '', density0: '', area0: '', iy0: '', iz0: '', torsion0: '', factor0: '', young1: '', shear1: '', density1: '', area1: '', iy1: '', iz1: '', torsion1: '', factor1: '', boltYoung: '', boltArea: '', preloadN: '', threadCompliance: '', headCompliance: '', bearingCompliance: '', memberCompliance: '' }; }
function emptyBoltAuthorEvidence(): Record<BoltAuthorEvidence, PropertySource> { return { material0: { kind: 'user-supplied', reference: '', condition: '' }, section0: { kind: 'user-supplied', reference: '', condition: '' }, material1: { kind: 'user-supplied', reference: '', condition: '' }, section1: { kind: 'user-supplied', reference: '', condition: '' }, modelSource: { kind: 'user-supplied', reference: '', condition: '' }, shankSource: { kind: 'user-supplied', reference: '', condition: '' }, shorteningSource: { kind: 'user-supplied', reference: '', condition: '' }, preloadN: { kind: 'user-supplied', reference: '', condition: '' }, threadCompliance: { kind: 'user-supplied', reference: '', condition: '' }, headCompliance: { kind: 'user-supplied', reference: '', condition: '' }, bearingCompliance: { kind: 'user-supplied', reference: '', condition: '' }, memberCompliance: { kind: 'user-supplied', reference: '', condition: '' }, loadSource: { kind: 'user-supplied', reference: '', condition: '' } }; }

export interface BoltAuthorForm {
  readonly previous: BoltPreloadDraft | null;
  readonly strength: NonNullable<AppState['strengthSession']>;
  readonly source: BeamSourceSnapshot;
  readonly template: StandardBeamContactDefinition;
  readonly analysisId: string;
  readonly members: readonly [string, string];
  readonly boltComponentId: string;
  readonly contactId: string;
  readonly values: Readonly<Record<BoltAuthorNumber, string>>;
  readonly evidence: Readonly<Record<BoltAuthorEvidence, PropertySource>>;
  readonly loads: string;
  readonly geometryConfirmed: boolean;
  readonly proposal: CadNativeBoltPreloadSavedInput | null;
}
export type BoltAuthorEdit = { readonly kind: 'number'; readonly field: BoltAuthorNumber; readonly text: string }
  | { readonly kind: 'evidence'; readonly field: BoltAuthorEvidence; readonly value: PropertySource }
  | { readonly kind: 'member'; readonly index: 0 | 1; readonly path: string }
  | { readonly kind: 'bolt'; readonly id: string } | { readonly kind: 'contact'; readonly id: string }
  | { readonly kind: 'identity'; readonly id: string } | { readonly kind: 'loads'; readonly text: string }
  | { readonly kind: 'geometry'; readonly confirmed: boolean };

export function boltAuthorTemplates(state: AppState): readonly { readonly key: string; readonly definition: StandardBeamContactDefinition }[] {
  const list: { key: string; definition: StandardBeamContactDefinition }[] = [];
  for (const entry of state.assembly?.beamAnalysisInputs?.analyses ?? []) {
    if (entry.kind === 'native-bolt-preload') list.push({ key: `saved:${entry.definition.id}`, definition: entry.definition.cadDefinition });
    else if (entry.kind === 'standard-members' && entry.definition.schema === 'pointercad-standard-beam/5') list.push({ key: `standard:${entry.definition.id}`, definition: entry.definition });
  }
  const source = captureBeamSource(state);
  if (state.beamSession !== null && source !== null) {
    const checked = beamDefinition(state.beamSession, source, source.document.parameters);
    if (checked.ok && checked.definition.schema === 'pointercad-standard-beam/5') list.push({ key: 'current', definition: checked.definition });
  }
  return list;
}
function authorNumber(text: string): number {
  if (!/^[+]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/iu.test(text.trim())) throw new Error('Explicit finite nonnegative number required');
  const value = Number(text); if (!Number.isFinite(value)) throw new Error('Finite number required'); return value;
}
function authorIsCurrent(form: BoltAuthorForm, state: AppState): boolean {
  return state.boltPreloadAuthor === form && state.boltPreloadDraft === form.previous
    && state.strengthSession === form.strength && beamSourceIsCurrent(form.source, state);
}
function authoredBoltInput(form: BoltAuthorForm): CadNativeBoltPreloadSavedInput {
  const base = form.template, source = form.source.source, id = form.analysisId.trim();
  if (!form.geometryConfirmed || !id || base.members.length !== 2 || base.axialBolts?.bolts.length !== 1
    || base.contact.contacts.length !== 1 || base.contact.segmentsPerMember !== 1 || base.weldLayers !== undefined || base.initialStrain !== undefined) throw new Error('Explicit supported geometry confirmation required');
  const revision = form.previous === null ? 1 : form.previous.revision + 1;
  if (form.previous !== null && id !== form.previous.saved.id) throw new Error('Reassociation cannot change analysis identity');
  const conflict = form.source.document.beamAnalysisInputs?.analyses.some(row =>
    (row.kind === 'manual' ? row.document.id : row.definition.id) === id
      && !(form.previous !== null && row.kind === 'native-bolt-preload' && row.definition.id === form.previous.saved.id));
  if (conflict) throw new Error('Analysis identity already exists');
  const occurrences = beamOccurrences(form.source.document, form.source.resolved);
  const selected = form.members.map(key => occurrences.find(row => JSON.stringify(row.path) === key));
  const [first, second] = selected;
  if (first === undefined || second === undefined || form.members[0] === form.members[1]) throw new Error('Select two distinct current members');
  const component = form.source.document.components.find(row => row.id === form.boltComponentId && !row.suppressed);
  const originalBolt = base.axialBolts.bolts[0], contact = base.contact.contacts[0];
  if (component === undefined || component.source.kind !== 'standardPart' || component.source.catalog !== 'hexBolt'
    || contact.id !== form.contactId || contact.kind !== 'node-pair') throw new Error('Select the current bolt and declared contact');
  const n = (key: BoltAuthorNumber): number => authorNumber(form.values[key]);
  const makeMaterial = (slot: 0 | 1) => ({ id: `preload-material-${slot}`, youngModulus: n(slot === 0 ? 'young0' : 'young1'),
    shearModulus: n(slot === 0 ? 'shear0' : 'shear1'), densityKgM3: n(slot === 0 ? 'density0' : 'density1'), source: form.evidence[slot === 0 ? 'material0' : 'material1'] });
  const makeSection = (slot: 0 | 1) => ({ id: `preload-section-${slot}`, area: n(slot === 0 ? 'area0' : 'area1'),
    iy: n(slot === 0 ? 'iy0' : 'iy1'), iz: n(slot === 0 ? 'iz0' : 'iz1'), torsionConstant: n(slot === 0 ? 'torsion0' : 'torsion1'),
    shearFactor: n(slot === 0 ? 'factor0' : 'factor1'), source: form.evidence[slot === 0 ? 'section0' : 'section1'] });
  const loads = form.loads.split(/\r?\n/u).map(authorNumber);
  const members = base.members.map((member, i) => ({ ...member, occurrencePath: i === 0 ? first.path : second.path,
    expectedPartKey: i === 0 ? first.partKey : second.partKey, materialId: `preload-material-${i}`, sectionId: `preload-section-${i}`,
    sectionFrame: { ...member.sectionFrame, source: form.evidence[i === 0 ? 'section0' : 'section1'] } }));
  const bolt = { ...originalBolt, boltComponentId: component.id, expectedPartKey: partKeyOf(component.source),
    expectedMaterialId: component.materialId ?? null, youngMPa: n('boltYoung'), effectiveAreaMm2: n('boltArea'), propertySource: form.evidence.shankSource };
  const declaration = { boltId: bolt.id, model: 'coaxial-outer-planes-series-bearing' as const,
    modelSource: form.evidence.modelSource, shankSource: form.evidence.shankSource, shorteningSource: form.evidence.shorteningSource,
    preloadN: { value: n('preloadN'), source: form.evidence.preloadN },
    threadCompliance: { value: n('threadCompliance'), source: form.evidence.threadCompliance },
    headCompliance: { value: n('headCompliance'), source: form.evidence.headCompliance },
    bearingCompliance: { value: n('bearingCompliance'), source: form.evidence.bearingCompliance },
    memberCompliance: { value: n('memberCompliance'), source: form.evidence.memberCompliance }, externalLoadsN: loads, loadSource: form.evidence.loadSource };
  // Rebuild every declared property and association. The old source is not changed in place.
  const cad: StandardBeamContactDefinition = { schema: 'pointercad-standard-beam/5', id, revision, source, units: 'N-mm', members,
    materials: [makeMaterial(0), makeMaterial(1)], sections: [makeSection(0), makeSection(1)],
    supports: base.supports, referenceLoads: base.referenceLoads,
    contact: { segmentsPerMember: 1, contacts: [contact], loadFactors: [0, ...loads] },
    axialBolts: { schema: 'pointercad-cad-axial-bolts/1', source, analysisId: id, analysisRevision: revision, bolts: [bolt] } };
  return readCadNativeBoltPreloadSavedInput({ schema: 'pointercad-cad-native-bolt-preload-saved/1', id, revision, source,
    cadDefinition: cad, input: { schema: 'pointercad-cad-native-bolt-preload/1', source, analysisId: id, analysisRevision: revision,
      boltComponentId: component.id, contactId: contact.id, memberIds: [bolt.first.memberId, bolt.second.memberId], declaration } });
}

/** Legacy standard-member entry points preserve native preload inputs and refuse to edit or execute them. */
function refuseSavedNativePreload(state: AppState): boolean {
  if (!state.assembly?.beamAnalysisInputs?.analyses.some(input => input.kind === 'native-bolt-preload')) return false;
  state.closeBeam();
  state.setFileMessage({ key: 'beam.error.model', failed: true,
    detail: '保存済みのボルト締付け段階入力は、この画面ではまだ編集・実行できません。保存内容は保持されています。' });
  return true;
}

export const createBeamSlice: StateCreator<AppState, [], [], BeamSlice> = (set, get, store) => {
  // 保存文書idと、開く単位のidは別。開いた時の所有を保持して失効させる。
  let preloadOpeningId: string | null = null;
  store.subscribe(state => {
    if (state.boltPreloadOwner !== null && (state.strengthSession !== state.boltPreloadOwner
      || state.activeDocumentId !== preloadOpeningId || state.assembly === null
      || (state.boltPreloadDraft !== null && state.assembly.id !== state.boltPreloadDraft.saved.source.documentId))) {
      preloadOpeningId = null;
      const runner = state.boltPreloadRunner;
      set({ boltPreloadOwner: null, boltPreloadAuthor: null, boltPreloadDraft: null,
        boltPreloadStatus: 'editing', boltPreloadPhase: null, boltPreloadError: null });
      runner?.cancel();
    }
  });
  return ({
  boltPreloadOwner: null,
  boltPreloadAuthor: null,
  beginBoltPreloadAuthor: (key, reassociate) => {
    const state = get(), source = captureBeamSource(state), strength = state.strengthSession;
    const template = boltAuthorTemplates(state).find(row => row.key === key)?.definition;
    state.boltPreloadRunner?.cancel(); state.beamRunner?.cancel();
    const previous = reassociate && state.boltPreloadDraft !== null ? invalidateBoltPreloadDraft(state.boltPreloadDraft) : null;
    if (source === null || strength === null || template === undefined || template.source.documentId !== source.document.id
      || (reassociate && previous === null) || (previous !== null && previous.saved.source.documentId !== source.document.id)) {
      set({ boltPreloadAuthor: null, boltPreloadError: 'Current association owner unavailable' }); return;
    }
    preloadOpeningId = state.activeDocumentId;
    set({ boltPreloadOwner: strength, boltPreloadDraft: previous, boltPreloadStatus: 'editing', boltPreloadPhase: null, boltPreloadError: null,
      boltPreloadAuthor: { previous, strength, source, template, analysisId: previous?.saved.id ?? '', members: ['', ''],
        boltComponentId: '', contactId: '', values: emptyBoltAuthorNumbers(), evidence: emptyBoltAuthorEvidence(),
        loads: '', geometryConfirmed: false, proposal: null } });
  },
  editBoltPreloadAuthor: edit => {
    const state = get(), form = state.boltPreloadAuthor; if (form === null) return;
    const base = { ...form, proposal: null };
    switch (edit.kind) {
      case 'number': set({ boltPreloadAuthor: { ...base, values: { ...form.values, [edit.field]: edit.text } } }); break;
      case 'evidence': set({ boltPreloadAuthor: { ...base, evidence: { ...form.evidence, [edit.field]: edit.value } } }); break;
      case 'member': set({ boltPreloadAuthor: { ...base, members: edit.index === 0 ? [edit.path, form.members[1]] : [form.members[0], edit.path] } }); break;
      case 'bolt': set({ boltPreloadAuthor: { ...base, boltComponentId: edit.id } }); break;
      case 'contact': set({ boltPreloadAuthor: { ...base, contactId: edit.id } }); break;
      case 'identity': if (form.previous === null) set({ boltPreloadAuthor: { ...base, analysisId: edit.id } }); break;
      case 'loads': set({ boltPreloadAuthor: { ...base, loads: edit.text } }); break;
      case 'geometry': set({ boltPreloadAuthor: { ...base, geometryConfirmed: edit.confirmed } }); break;
      default: { const exhaustive: never = edit; return exhaustive; }
    }
    set({ boltPreloadError: null });
  },
  previewBoltPreloadAuthor: async () => {
    const form = get().boltPreloadAuthor; if (form === null) return;
    try {
      if (!authorIsCurrent(form, get())) throw new Error('Current association is stale');
      const saved = authoredBoltInput(form), source = form.source;
      await prepareCadNativeBoltPreload(source.document, saved.cadDefinition, saved.input,
        { currentSource: source.source, bodies: source.ownership.bodies,
          assemblyOptions: { library: source.library, subAssemblies: source.library.assemblies },
          ...(source.jointOccurrence === undefined ? {} : { jointOccurrence: source.jointOccurrence }) });
      if (!authorIsCurrent(form, get())) return;
      set({ boltPreloadAuthor: { ...form, proposal: saved }, boltPreloadError: null });
    } catch (error) {
      if (get().boltPreloadAuthor === form) set({ boltPreloadAuthor: { ...form, proposal: null },
        boltPreloadError: error instanceof Error ? error.message : 'Association validation failed' });
    }
  },
  acceptBoltPreloadAuthor: () => {
    const form = get().boltPreloadAuthor;
    if (form === null || form.proposal === null || !authorIsCurrent(form, get())) {
      set({ boltPreloadError: 'A current reviewed proposal and separate consent are required' }); return;
    }
    // Adoption is a distinct explicit operation; no document write or inherited review/result.
    set({ boltPreloadDraft: restoreBoltPreloadDraft(form.proposal), boltPreloadAuthor: null,
      boltPreloadStatus: 'editing', boltPreloadPhase: null, boltPreloadError: null });
  },
  cancelBoltPreloadAuthor: () => { set({ boltPreloadAuthor: null, boltPreloadError: null }); },

  boltPreloadDraft: null, boltPreloadStatus: 'editing', boltPreloadPhase: null, boltPreloadError: null,
  boltPreloadRunner: null,
  setBoltPreloadRunner: boltPreloadRunner => { set({ boltPreloadRunner }); },
  openBoltPreload: id => {
    set({ boltPreloadAuthor: null });
    const state = get(), saved = state.assembly?.beamAnalysisInputs?.analyses.find(input => input.kind === 'native-bolt-preload' && input.definition.id === id);
    state.beamRunner?.cancel();
    if (state.strengthSession === null || state.assembly === null || saved?.kind !== 'native-bolt-preload' || saved.definition.source.documentId !== state.assembly.id) {
      set({ boltPreloadDraft: null, boltPreloadStatus: 'failed', boltPreloadError: 'Saved preload owner not available', boltPreloadPhase: null }); return;
    }
    preloadOpeningId = state.activeDocumentId;
    try { set({ boltPreloadOwner: state.strengthSession, boltPreloadDraft: restoreBoltPreloadDraft(saved.definition), boltPreloadStatus: 'editing', boltPreloadError: null, boltPreloadPhase: null }); }
    catch (error) { set({ boltPreloadDraft: null, boltPreloadStatus: 'failed', boltPreloadError: error instanceof Error ? error.message : 'Invalid preload input', boltPreloadPhase: null }); }
  },
  editBoltPreload: edit => {
    const state = get(), draft = state.boltPreloadDraft; if (draft === null) return;
    state.boltPreloadRunner?.cancel();
    set({ boltPreloadDraft: editBoltPreloadDraft(draft, edit), boltPreloadStatus: 'editing', boltPreloadPhase: null, boltPreloadError: null });
  },
  confirmBoltPreload: confirmed => {
    const state = get(), draft = state.boltPreloadDraft; if (draft === null) return;
    state.boltPreloadRunner?.cancel();
    try { set({ boltPreloadDraft: confirmBoltPreloadDraft(draft, confirmed), boltPreloadStatus: 'editing', boltPreloadError: null, boltPreloadPhase: null }); }
    catch (error) { set({ boltPreloadDraft: invalidateBoltPreloadDraft(draft), boltPreloadStatus: 'failed', boltPreloadError: error instanceof Error ? error.message : 'Invalid explicit values', boltPreloadPhase: null }); }
  },
  reviewBoltPreload: async () => {
    const state = get(), draft = state.boltPreloadDraft, source = captureBeamSource(state);
    if (draft === null) return;
    state.boltPreloadRunner?.cancel();
    if (source === null) { set({ boltPreloadDraft: invalidateBoltPreloadDraft(draft), boltPreloadStatus: 'failed', boltPreloadError: 'Current source unavailable', boltPreloadPhase: null }); return; }
    set({ boltPreloadStatus: 'reviewing', boltPreloadPhase: null, boltPreloadError: null });
    try {
      const reviewed = await reviewBoltPreloadDraft(draft, source, () => ({ state: get(), session: get().boltPreloadDraft }));
      if (get().boltPreloadDraft === draft) set({ boltPreloadDraft: reviewed, boltPreloadStatus: 'editing', boltPreloadError: null });
    } catch (error) {
      if (get().boltPreloadDraft === draft) set({ boltPreloadDraft: invalidateBoltPreloadDraft(draft), boltPreloadStatus: 'failed', boltPreloadError: error instanceof Error ? error.message : 'Preload review failed' });
    }
  },
  runBoltPreload: () => {
    const state = get(), draft = state.boltPreloadDraft; if (draft === null || state.boltPreloadRunner === null) return;
    state.boltPreloadRunner.run(draft);
  },
  cancelBoltPreload: () => {
    const state = get(); state.boltPreloadRunner?.cancel();
    set({ boltPreloadDraft: state.boltPreloadDraft === null ? null : invalidateBoltPreloadDraft(state.boltPreloadDraft), boltPreloadStatus: 'cancelled', boltPreloadPhase: null });
  },
  closeBoltPreload: () => {
    preloadOpeningId = null;
    set({ boltPreloadOwner: null, boltPreloadAuthor: null });
    get().boltPreloadRunner?.cancel();
    set({ boltPreloadDraft: null, boltPreloadStatus: 'editing', boltPreloadPhase: null, boltPreloadError: null });
  },
  applyBoltPreloadInputs: () => {
    const state = get(), draft = state.boltPreloadDraft; if (draft === null) return;
    try {
      reviewedBoltPreloadWire(draft, state);
      const source = draft.reviewed?.source; if (source === undefined) return;
      const saved = boltPreloadDraftSavedInput(draft);
      const analyses = source.document.beamAnalysisInputs?.analyses.filter(input =>
        !(input.kind === 'native-bolt-preload' && input.definition.id === saved.id)) ?? [];
      const document = withBeamAnalysisInputs(source.document, { schema: 'pointercad-beam-inputs/1', analyses: [...analyses, { kind: 'native-bolt-preload', definition: saved }] });
      state.boltPreloadRunner?.cancel();
      set({ boltPreloadDraft: invalidateBoltPreloadDraft(draft), boltPreloadStatus: 'editing', boltPreloadPhase: null, boltPreloadError: null });
      state.applyAssembly(document, source.library);
    } catch (error) { set({ boltPreloadError: error instanceof Error ? error.message : 'Preload inputs not reviewed' }); }
  },
  beamSession: null,
  beamRunner: null,
  setBeamRunner: beamRunner => { set({ beamRunner }); },
  openBeam: () => {
    const state = get();
    if (state.assembly === null || state.strengthSession === null) return;
    if (refuseSavedNativePreload(state)) return;
    state.beamRunner?.cancel();
    const saved = state.assembly.beamAnalysisInputs?.analyses.find(input => input.kind === 'standard-members');
    const occurrences = state.assemblyView?.sourceDocument === state.assembly
      ? beamOccurrences(state.assembly, state.assemblyView.resolved) : [];
    set({ beamSession: saved?.kind === 'standard-members'
      ? restoreBeamSession(state.activeDocumentId, saved.definition, occurrences)
      : createBeamSession(state.activeDocumentId, crypto.randomUUID()) });
  },
  closeBeam: () => {
    get().beamRunner?.cancel();
    set({ beamSession: null });
  },
  editBeam: edit => {
    const state = get();
    if (state.beamSession === null) return;
    // Focus and the transient/contact result views are view-only: they neither cancel a run nor invalidate a result.
    if (edit.kind !== 'focus' && edit.kind !== 'transient-view' && edit.kind !== 'contact-view') state.beamRunner?.cancel();
    set({ beamSession: editBeamSession(state.beamSession, edit) });
  },
  reviewBeam: () => {
    const state = get(), session = state.beamSession;
    if (refuseSavedNativePreload(state)) return;
    if (session === null) return;
    state.beamRunner?.cancel();
    const source = captureBeamSource(state);
    if (source === null) {
      set({ beamSession: { ...session, reviewed: null, result: null, bucklingEdges: [], transientAxial: null, impactMembers: null, status: 'editing', errorKey: 'beam.error.geometry', diagnostic: null } });
      return;
    }
    const draft = beamDefinition(session, source, source.document.parameters);
    if (!draft.ok) {
      set({ beamSession: { ...session, reviewed: null, result: null, bucklingEdges: [], transientAxial: null, impactMembers: null, status: 'editing',
        errorKey: draft.key, diagnostic: draft.diagnostic, focusedField: draft.field } });
      return;
    }
    const checked = prepareBeamAnalysis(source, draft.definition);
    set({ beamSession: { ...session, reviewed: checked.ok ? source : null, result: null, bucklingEdges: [], transientAxial: null, impactMembers: null, status: 'editing',
      errorKey: checked.ok ? null : 'beam.error.model',
      diagnostic: checked.ok ? null : `${checked.issue.code}: ${checked.issue.path}: ${checked.issue.message}` } });
  },
  runBeam: () => {
    const state = get(), session = state.beamSession;
    if (refuseSavedNativePreload(state)) return;
    if (session === null) return;
    if (session.reviewed === null || !beamSourceIsCurrent(session.reviewed, state) || state.beamRunner === null) {
      set({ beamSession: { ...session, result: null, bucklingEdges: [], transientAxial: null, impactMembers: null, status: 'editing', errorKey: 'beam.error.review' } });
      return;
    }
    state.beamRunner.run(session, session.reviewed);
  },
  cancelBeam: () => {
    const state = get();
    state.beamRunner?.cancel();
    if (state.beamSession !== null) set({ beamSession: { ...state.beamSession, result: null,
      phase: null, status: 'cancelled', bucklingEdges: [], transientAxial: null, impactMembers: null, errorKey: null, diagnostic: null } });
  },
  applyBeamInputs: () => {
    const state = get(), session = state.beamSession;
    if (refuseSavedNativePreload(state)) return;
    if (session === null || session.reviewed === null || !beamSourceIsCurrent(session.reviewed, state)) return;
    const source = session.reviewed;
    const draft = beamDefinition(session, source, source.document.parameters);
    if (!draft.ok) return;
    state.beamRunner?.cancel();
    // Existing assembly history owns the edit. Results and derived world endpoints never enter the document.
    // Saving is an intentional input edit, not stale geometry. Release review before subscribers see the document edit.
    set({ beamSession: invalidateBeamSession(session) });
    const analyses = source.document.beamAnalysisInputs?.analyses.filter(input =>
      (input.kind === 'manual' ? input.document.id : input.definition.id) !== draft.definition.id) ?? [];
    state.applyAssembly(withBeamAnalysisInputs(source.document, {
      schema: 'pointercad-beam-inputs/1', analyses: [...analyses, { kind: 'standard-members', definition: draft.definition }],
    }), source.library);
  },
});
};
