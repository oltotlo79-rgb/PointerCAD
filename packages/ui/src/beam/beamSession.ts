import { exactExpressionValueFromNumber } from '@pointercad/expression';
import type { Parameter } from '@pointercad/model';
import type { CadJointInitialStrain } from '@pointercad/model/beam-analysis';
import type { BeamWeldSpanContactResult, BeamJointInitialStrainResult, FrictionContactResult } from '@pointercad/fem';
import { readBeamAnalysisInputs, type BeamAnalysisResult, type BeamModalResult, type PropertySource,
  type StandardBeamDefinition, type StandardBeamBucklingDefinition, type StandardBeamTransientDefinition,
  type StandardBeamContactDefinition, type StandardBeamContactInput, type StandardBeamImpactDefinition, type StandardBeamFrictionDefinition,
  type CadAxialBolt, type CadWeldLayer, type CadWeldSpanInputs,
  type BeamTransientHistory, type StandardBeamFibreOutline, type Vector3 } from '@pointercad/model/beam-analysis';
import { MAX_BEAM_CONTACTS, MAX_CONTACT_LOAD_FACTORS, type BeamBucklingResult, type BeamContactAnalysisResult, type BeamBoltContactResult, type BeamWeldContactResult, type BeamJointContactResult,
  type BeamTransientResult, type BucklingRestraints, type FemPhase, type TransientAxialResponse,
  type BeamImpactResult, type ImpactMemberResponseSet } from '@pointercad/fem';
import type { MessageKey } from '../i18n/t.js';
import { BEAM_FIELDS, readBeamField, readContactField, readTransientField, type BeamFieldName, type ContactFieldName,
  type TransientFieldName } from './beamFields.js';
import type { BeamOccurrence, BeamSourceSnapshot } from './beamSource.js';
import { emptyImpactDraft, fibreOutlinesFromDraft, impactSettingsFromDraft, type FibreOutlineDraft, type ImpactDraft,
  type ImpactVelocityRowDraft } from './beamImpactDraft.js';

export type BeamProvenance = 'material' | 'section' | 'frame';
export type BucklingAxis = 0 | 1 | 2 | 3 | 4 | 5;
export type BucklingEdges = readonly (readonly [number, number])[];
export interface BeamMemberDraft {
  readonly id: string;
  readonly occurrence: BeamOccurrence;
  readonly values: Readonly<Record<BeamFieldName, string>>;
  readonly startNodeId: string;
  readonly endNodeId: string;
  readonly fixedStart: boolean;
  readonly fixedEnd: boolean;
  readonly startRestraints: BucklingRestraints;
  readonly endRestraints: BucklingRestraints;
  readonly confirmed: boolean;
  readonly material: PropertySource;
  readonly section: PropertySource;
  readonly frame: PropertySource;
}
/** Editable time-history text, parsed only by beamDefinition and then decoded strictly by the model. */
export interface TransientDraft {
  readonly damping: 'none' | 'rayleigh';
  readonly massCoefficientPerS: string;
  readonly stiffnessCoefficientS: string;
  readonly timeStep: string;
  readonly stepCount: string;
  readonly outputEvery: string;
  readonly samples: readonly { readonly time: string; readonly factor: string }[];
}
/** One editable contact. A plane contact uses only nodeIdA; nodes are chosen from the selected members' end nodes
 * and are never inferred from CAD faces. Direction and gap text is parsed only by beamDefinition. */
export interface ContactRowDraft {
  readonly id: string;
  readonly kind: 'node-plane' | 'node-pair';
  readonly nodeIdA: string;
  readonly nodeIdB: string;
  readonly normal: readonly [string, string, string];
  readonly gap: string;
}
export interface ContactDraft {
  readonly nextContact: number;
  readonly rows: readonly ContactRowDraft[];
  readonly loadFactors: readonly string[];
}
export type ContactValueField = 'normalX' | 'normalY' | 'normalZ' | 'gap';
 interface FrictionLoadDraft { readonly id: string; readonly nodeId: string; readonly force: readonly [string, string, string]; readonly moment: readonly [string, string, string] }
 interface FrictionDraft { readonly coefficients: Readonly<Record<string, string>>; readonly solver: 'newton' | 'nsgs'; readonly iterationLimit: string; readonly steps: readonly { readonly loads: readonly FrictionLoadDraft[] }[] }
/** Owned, immutable restored inputs; reused only while the editable geometry and source still match. */
interface FrictionRestoreBaseline { readonly definition: StandardBeamFrictionDefinition; readonly geometryKey: string; readonly openedSource: BeamDefinition['source'] }
export type BeamAnalysisType = 'static' | 'modal' | 'buckling' | 'transient' | 'contact' | 'impact' | 'friction';
export const TRANSIENT_DRAFT_MAXIMUM_SAMPLES = 256;
export interface BeamSession {
  readonly ownerId: string;
  readonly analysisId: string;
  readonly revision: number;
  readonly nextMember: number;
  readonly analysisType: BeamAnalysisType;
  readonly modeCount: number;
  readonly segmentsPerMember: number;
  readonly members: readonly BeamMemberDraft[];
  readonly focusedField: string | null;
  readonly reviewed: BeamSourceSnapshot | null;
  readonly status: 'editing' | 'running' | 'complete' | 'cancelled' | 'failed';
  readonly phase: FemPhase | null;
  readonly transient: TransientDraft;
  /** View-only choice of the displayed transient sample index and original node index; never saved. */
  readonly transientView: { readonly sample: number; readonly node: number };
  readonly contact: ContactDraft;
  readonly friction: FrictionDraft;
  readonly frictionRestoreBaseline?: FrictionRestoreBaseline;
  /** Editable impact text (velocities m/s, stiffness N/m, history s); its fixed planes are the node-plane contact rows. */
  readonly impact: ImpactDraft;
  readonly axialBolts: readonly CadAxialBolt[];
  readonly weldLayers: readonly CadWeldLayer[];
  /** Explicit /2 association and its original source; never a fabricated legacy endpoint. */
  readonly weldSpanLayers: CadWeldSpanInputs | null;
  readonly initialStrain: CadJointInitialStrain | null;
  /** View-only choice of the displayed contact load state; never saved. */
  readonly contactView: { readonly state: number };
  readonly result: BeamAnalysisResult | BeamModalResult | BeamBucklingResult | BeamTransientResult
    | BeamContactAnalysisResult | BeamBoltContactResult | BeamWeldContactResult | BeamJointContactResult | BeamJointInitialStrainResult | BeamWeldSpanContactResult
    | BeamImpactResult | FrictionContactResult | null;
  readonly bucklingEdges: BucklingEdges;
  /** Derived from the accepted transient result and its exact input; shown only while it matches the result. */
  readonly transientAxial: TransientAxialResponse | null;
  /** Derived once from the accepted impact result and its exact input (member means among the emitted samples);
   * shown only while impactMemberResponseMatches binds it to the displayed result. Never saved. */
  readonly impactMembers: ImpactMemberResponseSet | null;
  readonly errorKey: MessageKey | null;
  readonly diagnostic: string | null;
}
export type BeamEdit =
  | { readonly kind: 'friction-coefficient'; readonly contactId: string; readonly source: string }
  | { readonly kind: 'friction-solver'; readonly value: 'newton' | 'nsgs' }
  | { readonly kind: 'friction-iteration-limit'; readonly source: string }
  | { readonly kind: 'friction-step-add' }
  | { readonly kind: 'friction-step-remove'; readonly index: number }
  | { readonly kind: 'friction-load-value'; readonly step: number; readonly load: number; readonly field: 'force' | 'moment'; readonly axis: 0 | 1 | 2; readonly source: string }
  | { readonly kind: 'friction-load-add'; readonly id: string; readonly nodeId: string }
  | { readonly kind: 'friction-load-remove'; readonly index: number }
  | { readonly kind: 'friction-load-node'; readonly index: number; readonly nodeId: string }
  | { readonly kind: 'initial-strain'; readonly value: CadJointInitialStrain | null }
  | { readonly kind: 'weld-layers'; readonly welds: readonly CadWeldLayer[] }
  | { readonly kind: 'weld-span-layers'; readonly value: CadWeldSpanInputs | null }
  | { readonly kind: 'axial-bolts'; readonly bolts: readonly CadAxialBolt[] }
  | { readonly kind: 'analysis-type'; readonly value: BeamAnalysisType }
  | { readonly kind: 'transient-damping'; readonly value: TransientDraft['damping'] }
  | { readonly kind: 'transient-value'; readonly field: 'timeStep' | 'stepCount' | 'outputEvery' | 'massCoefficientPerS' | 'stiffnessCoefficientS'; readonly source: string }
  | { readonly kind: 'transient-sample'; readonly index: number; readonly field: 'time' | 'factor'; readonly source: string }
  | { readonly kind: 'transient-sample-add' }
  | { readonly kind: 'transient-sample-remove'; readonly index: number }
  | { readonly kind: 'transient-view'; readonly sample: number; readonly node: number }
  | { readonly kind: 'contact-add' }
  | { readonly kind: 'contact-remove'; readonly index: number }
  | { readonly kind: 'contact-kind'; readonly index: number; readonly value: ContactRowDraft['kind'] }
  | { readonly kind: 'contact-node'; readonly index: number; readonly end: 'a' | 'b'; readonly nodeId: string }
  | { readonly kind: 'contact-value'; readonly index: number; readonly field: ContactValueField; readonly source: string }
  | { readonly kind: 'contact-factor'; readonly index: number; readonly source: string }
  | { readonly kind: 'contact-factor-add' }
  | { readonly kind: 'contact-factor-remove'; readonly index: number }
  | { readonly kind: 'contact-view'; readonly state: number }
  | { readonly kind: 'impact-value'; readonly field: 'contactStiffness' | 'timeStep' | 'stepCount' | 'outputEvery'; readonly source: string }
  | { readonly kind: 'impact-velocity'; readonly nodeId: string; readonly axis: 0 | 1 | 2; readonly source: string }
  | { readonly kind: 'impact-velocity-remove'; readonly nodeId: string }
  | { readonly kind: 'impact-fibre'; readonly memberId: string; readonly field: 'kind' | 'first' | 'second'; readonly source: string }
  | { readonly kind: 'modal-settings'; readonly modeCount: number; readonly segmentsPerMember: number }
  | { readonly kind: 'select'; readonly occurrence: BeamOccurrence; readonly selected: boolean }
  | { readonly kind: 'value'; readonly id: string; readonly field: BeamFieldName; readonly source: string }
  | { readonly kind: 'source'; readonly id: string; readonly property: BeamProvenance; readonly source: PropertySource }
  | { readonly kind: 'fixed'; readonly id: string; readonly end: 'start' | 'end'; readonly fixed: boolean }
  | { readonly kind: 'buckling-support'; readonly id: string; readonly end: 'start' | 'end'; readonly axis: BucklingAxis; readonly restrained: boolean }
  | { readonly kind: 'connection'; readonly id: string; readonly end: 'start' | 'end'; readonly nodeId: string }
  | { readonly kind: 'confirmed'; readonly id: string; readonly confirmed: boolean }
  | { readonly kind: 'focus'; readonly field: string | null };

const emptySource = (): PropertySource => ({ kind: 'user-supplied', reference: '', condition: '' });
const freeRestraints = (): BucklingRestraints => [false, false, false, false, false, false];
const copyRestraints = (value: BucklingRestraints): BucklingRestraints => [value[0], value[1], value[2], value[3], value[4], value[5]];
// No time step, duration or load history is invented; only the required time-0 row and one output per step.
const emptyTransient = (): TransientDraft => ({ damping: 'none', massCoefficientPerS: '0', stiffnessCoefficientS: '0',
  timeStep: '', stepCount: '', outputEvery: '1',
  samples: [{ time: '0', factor: '' }, { time: '', factor: '' }] });
// No contact, direction, gap or load factor is invented; the single empty factor row is the required minimum.
const emptyContact = (): ContactDraft => ({ nextContact: 1, rows: [], loadFactors: [''] });
const normalFields: readonly ContactFieldName[] = ['normalX', 'normalY', 'normalZ'];
const names = Object.keys(BEAM_FIELDS) as BeamFieldName[];
const zeroFields = new Set<BeamFieldName>([
  'cx', 'cy', 'principalAngle', 'startFx', 'startFy', 'startFz', 'startMx', 'startMy', 'startMz',
  'endFx', 'endFy', 'endFz', 'endMx', 'endMy', 'endMz',
]);

function frictionGeometryKey(members: readonly BeamMemberDraft[], segmentsPerMember: number): string {
  return JSON.stringify({ segmentsPerMember, members: members.map(member => ({ id: member.id, occurrence: member.occurrence,
    values: member.values, startNodeId: member.startNodeId, endNodeId: member.endNodeId, fixedStart: member.fixedStart,
    fixedEnd: member.fixedEnd, startRestraints: member.startRestraints, endRestraints: member.endRestraints,
    material: member.material, section: member.section, frame: member.frame })) });
}
function freezeOwned<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freezeOwned(child);
    Object.freeze(value);
  }
  return value;
}

function emptyValues(): Record<BeamFieldName, string> {
  return Object.fromEntries(names.map(name => [name, zeroFields.has(name) ? '0' : ''])) as Record<BeamFieldName, string>;
}

export function createBeamSession(ownerId: string, analysisId: string): BeamSession {
  return { ownerId, analysisId, revision: 0, nextMember: 1, analysisType: 'static', modeCount: 6, segmentsPerMember: 8,
    members: [], focusedField: null, transient: emptyTransient(), transientView: { sample: 0, node: 0 },
    contact: emptyContact(), friction: { coefficients: {}, solver: 'newton', iterationLimit: '64', steps: [] }, contactView: { state: 0 }, impact: emptyImpactDraft(), axialBolts: [], weldLayers: [], weldSpanLayers: null, initialStrain: null,
    reviewed: null, status: 'editing', phase: null, result: null, bucklingEdges: [], transientAxial: null, impactMembers: null, errorKey: null, diagnostic: null };
}

export function invalidateBeamSession(session: BeamSession, errorKey: MessageKey | null = null): BeamSession {
  return { ...session, reviewed: null, status: 'editing', phase: null, result: null, bucklingEdges: [], transientAxial: null, impactMembers: null, errorKey, diagnostic: null,
    transientView: { sample: 0, node: 0 }, contactView: { state: 0 } };
}

/** The node ids the contact editor offers: every selected member's start and end node, in member order. */
export interface BeamContactNode {
  readonly nodeId: string;
  readonly label: string;
  readonly end: 'start' | 'end';
}
export function beamContactNodes(session: BeamSession): readonly BeamContactNode[] {
  const nodes: BeamContactNode[] = [];
  for (const member of session.members) {
    for (const [end, nodeId] of [['start', member.startNodeId], ['end', member.endNodeId]] as const) {
      // A shared (rigidly connected) end is one node; it is listed once, under its first member.
      if (!nodes.some(node => node.nodeId === nodeId)) nodes.push({ nodeId, label: member.occurrence.label, end });
    }
  }
  return nodes;
}

/** Every session-invalidating contact edit (contact-view only moves the displayed state). Derived from BeamEdit, so a
 * new 'contact-*' edit joins it and editContact stops compiling until it is handled. */
type ContactEdit = Exclude<Extract<BeamEdit, { readonly kind: `contact-${string}` }>, { readonly kind: 'contact-view' }>;
/** The per-member edits, applied to the member with that id. */
type MemberEdit = Exclude<Extract<BeamEdit, { readonly id: string }>, { readonly kind: 'friction-load-add' }>;

function editContact(session: BeamSession, next: BeamSession, edit: ContactEdit): BeamSession {
  const draft = session.contact;
  const rows = (change: (row: ContactRowDraft) => ContactRowDraft, index: number): BeamSession =>
    ({ ...next, contact: { ...draft, rows: draft.rows.map((row, position) => position === index ? change(row) : row) } });
  switch (edit.kind) {
    case 'contact-add': {
      if (draft.rows.length >= MAX_BEAM_CONTACTS) return session;
      let number = draft.nextContact;
      while (draft.rows.some(row => row.id === `contact-${number}`)) number += 1;
      // Keyboard position moves into the new row's first direction field (the shared ExpressionField focuses on mount).
      return { ...next, focusedField: `contact:contact-${number}:normalX`, contact: { ...draft, nextContact: number + 1,
        rows: [...draft.rows, { id: `contact-${number}`, kind: 'node-plane', nodeIdA: '', nodeIdB: '', normal: ['', '', ''], gap: '' }] } };
    }
    case 'contact-remove': {
      const removed = draft.rows[edit.index];
      if (removed === undefined) return session;
      return { ...next, contact: { ...draft, rows: draft.rows.filter((_, index) => index !== edit.index) },
        friction: { ...session.friction, coefficients: Object.fromEntries(Object.entries(session.friction.coefficients)
          .filter(([id]) => id !== removed.id)) } };
    }
    case 'contact-kind':
      return rows(row => ({ ...row, kind: edit.value, nodeIdB: edit.value === 'node-plane' ? '' : row.nodeIdB }), edit.index);
    case 'contact-node':
      return rows(row => edit.end === 'a' ? { ...row, nodeIdA: edit.nodeId } : { ...row, nodeIdB: edit.nodeId }, edit.index);
    case 'contact-value':
      return rows(row => edit.field === 'gap' ? { ...row, gap: edit.source } : { ...row, normal:
        [edit.field === 'normalX' ? edit.source : row.normal[0], edit.field === 'normalY' ? edit.source : row.normal[1],
          edit.field === 'normalZ' ? edit.source : row.normal[2]] }, edit.index);
    case 'contact-factor':
      return { ...next, contact: { ...draft, loadFactors: draft.loadFactors.map((value, index) => index === edit.index ? edit.source : value) } };
    case 'contact-factor-add':
      return draft.loadFactors.length >= MAX_CONTACT_LOAD_FACTORS ? session
        : { ...next, focusedField: `contact:factor:${draft.loadFactors.length}`,
          contact: { ...draft, loadFactors: [...draft.loadFactors, ''] } };
    case 'contact-factor-remove':
      return draft.loadFactors.length <= 1 ? session
        : { ...next, contact: { ...draft, loadFactors: draft.loadFactors.filter((_, index) => index !== edit.index) } };
    default: {
      const exhaustiveCheck: never = edit;
      return exhaustiveCheck;
    }
  }
}

function initialFriction(session: BeamSession): FrictionDraft {
  const loads: FrictionLoadDraft[] = session.members.flatMap(member => (['start', 'end'] as const).map((end): FrictionLoadDraft => ({
    id: `${member.id}-${end}-load`, nodeId: end === 'start' ? member.startNodeId : member.endNodeId,
    force: [member.values[`${end}Fx`], member.values[`${end}Fy`], member.values[`${end}Fz`]],
    moment: [member.values[`${end}Mx`], member.values[`${end}My`], member.values[`${end}Mz`]],
  })));
  return { ...session.friction, steps: [{ loads }] };
}
type FrictionEdit = Extract<BeamEdit, { readonly kind: `friction-${string}` }>;
function editFriction(session: BeamSession, next: BeamSession, edit: FrictionEdit): BeamSession {
  const draft = session.friction;
  switch (edit.kind) {
    case 'friction-coefficient': return { ...next, friction: { ...draft, coefficients: { ...draft.coefficients, [edit.contactId]: edit.source } } };
    case 'friction-solver': return { ...next, friction: { ...draft, solver: edit.value } };
    case 'friction-iteration-limit': return { ...next, friction: { ...draft, iterationLimit: edit.source } };
    case 'friction-step-add': return draft.steps.length === 0 || draft.steps.length >= 32 ? session : { ...next,
      friction: { ...draft, steps: [...draft.steps, { loads: draft.steps[draft.steps.length - 1].loads.map((load): FrictionLoadDraft => ({ ...load, force: [load.force[0], load.force[1], load.force[2]], moment: [load.moment[0], load.moment[1], load.moment[2]] })) }] } };
    case 'friction-step-remove': return draft.steps.length <= 1 || edit.index < 0 || edit.index >= draft.steps.length ? session : { ...next,
      friction: { ...draft, steps: draft.steps.filter((_, index) => index !== edit.index) } };
    case 'friction-load-value': return { ...next, friction: { ...draft, steps: draft.steps.map((step, si) => si !== edit.step ? step : {
      loads: step.loads.map((load, li): FrictionLoadDraft => li !== edit.load ? load : { ...load,
        [edit.field]: [edit.axis === 0 ? edit.source : load[edit.field][0], edit.axis === 1 ? edit.source : load[edit.field][1],
          edit.axis === 2 ? edit.source : load[edit.field][2]] }) }) } };
    case 'friction-load-add': return draft.steps.length === 0 || draft.steps[0].loads.some(load => load.id === edit.id) ? session : { ...next,
      friction: { ...draft, steps: draft.steps.map(step => ({ loads: [...step.loads,
        { id: edit.id, nodeId: edit.nodeId, force: ['0', '0', '0'], moment: ['0', '0', '0'] }] })) } };
    case 'friction-load-remove': return { ...next, friction: { ...draft, steps: draft.steps.map(step => ({ loads: step.loads.filter((_, index) => index !== edit.index) })) } };
    case 'friction-load-node': return { ...next, friction: { ...draft, steps: draft.steps.map(step => ({ loads: step.loads.map((load, index) => index === edit.index ? { ...load, nodeId: edit.nodeId } : load) })) } };
  }
}

export function editBeamSession(session: BeamSession, edit: BeamEdit): BeamSession {
  if (edit.kind === 'focus') return { ...session, focusedField: edit.field };
  if (edit.kind === 'transient-view') return { ...session, transientView: { sample: edit.sample, node: edit.node } };
  if (edit.kind === 'contact-view') return { ...session, contactView: { state: edit.state } };
  const next = { ...invalidateBeamSession(session), revision: session.revision + 1,
    weldSpanLayers: session.weldSpanLayers === null ? null
      : { ...session.weldSpanLayers, analysisRevision: session.revision + 1 } };
  if (edit.kind === 'initial-strain') return { ...next, initialStrain: edit.value };
  if (edit.kind === 'axial-bolts') return { ...next, axialBolts: edit.bolts,
    initialStrain: session.initialStrain === null ? null : { ...session.initialStrain,
      shortenings: edit.bolts.map(bolt => session.initialStrain?.shortenings.find(row => row.boltId === bolt.id)
        ?? { boltId: bolt.id, shorteningMm: NaN, source: emptySource() }) } };
  if (edit.kind === 'weld-layers') return { ...next, weldLayers: edit.welds };
  if (edit.kind === 'weld-span-layers') return { ...next, weldSpanLayers: edit.value === null ? null
    : { ...edit.value, analysisRevision: next.revision } };
  if (edit.kind === 'analysis-type') return { ...next, analysisType: edit.value,
    friction: edit.value === 'friction' && session.friction.steps.length === 0 ? initialFriction(session) : session.friction };
  switch (edit.kind) {
    case 'friction-coefficient': case 'friction-solver': case 'friction-iteration-limit': case 'friction-step-add':
    case 'friction-step-remove': case 'friction-load-value': case 'friction-load-add': case 'friction-load-remove': case 'friction-load-node':
      return editFriction(session, next, edit);
  }
  if (edit.kind === 'modal-settings') return { ...next, modeCount: edit.modeCount, segmentsPerMember: edit.segmentsPerMember };
  if (edit.kind === 'impact-value') return { ...next, impact: { ...session.impact, [edit.field]: edit.source } };
  if (edit.kind === 'impact-velocity') {
    // A new row starts at rest on the other axes, like the member load fields; only the edited component changes.
    const prior = session.impact.velocities.find(row => row.nodeId === edit.nodeId);
    const base = prior?.velocity ?? ['0', '0', '0'];
    const velocity: [string, string, string] = [base[0], base[1], base[2]];
    velocity[edit.axis] = edit.source;
    return { ...next, impact: { ...session.impact, velocities: prior === undefined
      ? [...session.impact.velocities, { nodeId: edit.nodeId, velocity }]
      : session.impact.velocities.map(row => row.nodeId === edit.nodeId ? { ...row, velocity } : row) } };
  }
  if (edit.kind === 'impact-velocity-remove') {
    return { ...next, impact: { ...session.impact, velocities: session.impact.velocities.filter(row => row.nodeId !== edit.nodeId) } };
  }
  if (edit.kind === 'impact-fibre') {
    // Like every input edit this invalidates the result, so a displayed fibre table always uses the outline it was run with.
    const rows = session.impact.fibreSections ?? {};
    const prior: FibreOutlineDraft = Object.hasOwn(rows, edit.memberId) ? rows[edit.memberId] : { kind: 'none', first: '', second: '' };
    const kind: FibreOutlineDraft['kind'] = edit.field !== 'kind' ? prior.kind
      : edit.source === 'rectangle' || edit.source === 'circle' || edit.source === 'tube' ? edit.source : 'none';
    const row: FibreOutlineDraft = { kind, first: edit.field === 'first' ? edit.source : prior.first,
      second: edit.field === 'second' ? edit.source : prior.second };
    return { ...next, impact: { ...session.impact, fibreSections: { ...rows, [edit.memberId]: row } } };
  }
  // Discriminant dispatch narrows `edit`: contact edits never reach the member edits below.
  switch (edit.kind) {
    case 'contact-add': case 'contact-remove': case 'contact-kind': case 'contact-node': case 'contact-value':
    case 'contact-factor': case 'contact-factor-add': case 'contact-factor-remove':
      return editContact(session, next, edit);
  }
  if (edit.kind === 'transient-damping') return { ...next, transient: { ...session.transient, damping: edit.value } };
  if (edit.kind === 'transient-value') return { ...next, transient: { ...session.transient, [edit.field]: edit.source } };
  if (edit.kind === 'transient-sample') {
    return { ...next, transient: { ...session.transient, samples: session.transient.samples.map((row, index) =>
      index === edit.index ? { ...row, [edit.field]: edit.source } : row) } };
  }
  if (edit.kind === 'transient-sample-add') {
    // Keyboard position moves into the new row's time field (the shared ExpressionField focuses on mount).
    return session.transient.samples.length >= TRANSIENT_DRAFT_MAXIMUM_SAMPLES ? session
      : { ...next, focusedField: `transient:sample:${session.transient.samples.length}:time`,
        transient: { ...session.transient, samples: [...session.transient.samples, { time: '', factor: '' }] } };
  }
  if (edit.kind === 'transient-sample-remove') {
    return session.transient.samples.length <= 2 ? session : { ...next, transient: { ...session.transient,
      samples: session.transient.samples.filter((_, index) => index !== edit.index) } };
  }
  if (edit.kind === 'select') {
    const key = JSON.stringify(edit.occurrence.path);
    const found = session.members.some(member => JSON.stringify(member.occurrence.path) === key);
    if (found === edit.selected) return session;
    if (!edit.selected) return { ...next, members: session.members.filter(member => JSON.stringify(member.occurrence.path) !== key) };
    let memberNumber = session.nextMember;
    while (session.members.some(member => member.id === `beam-member-${memberNumber}`)) memberNumber += 1;
    const id = `beam-member-${memberNumber}`;
    return { ...next, nextMember: memberNumber + 1, members: [...session.members, {
      id, occurrence: edit.occurrence, values: emptyValues(), startNodeId: `${id}-start`, endNodeId: `${id}-end`,
      fixedStart: false, fixedEnd: false, confirmed: false,
      startRestraints: freeRestraints(), endRestraints: freeRestraints(),
      material: emptySource(), section: emptySource(), frame: emptySource(),
    }] };
  }
  // Only the per-member edits remain; an edit kind without an id stops compiling here.
  const memberEdit: MemberEdit = edit;
  return { ...next, members: session.members.map(member => {
    if (member.id !== memberEdit.id) return member;
    switch (memberEdit.kind) {
      case 'value': return { ...member, values: { ...member.values, [memberEdit.field]: memberEdit.source },
        confirmed: ['cx', 'cy', 'principalAngle'].includes(memberEdit.field) ? false : member.confirmed };
      case 'source': return { ...member, [memberEdit.property]: memberEdit.source,
        confirmed: memberEdit.property === 'frame' ? false : member.confirmed };
      case 'fixed': return memberEdit.end === 'start' ? { ...member, fixedStart: memberEdit.fixed } : { ...member, fixedEnd: memberEdit.fixed };
      case 'buckling-support': {
        const mask = memberEdit.end === 'start' ? member.startRestraints : member.endRestraints;
        const nextMask: [boolean, boolean, boolean, boolean, boolean, boolean] = [...mask];
        nextMask[memberEdit.axis] = memberEdit.restrained;
        return memberEdit.end === 'start' ? { ...member, startRestraints: nextMask } : { ...member, endRestraints: nextMask };
      }
      case 'connection': return memberEdit.end === 'start' ? { ...member, startNodeId: memberEdit.nodeId } : { ...member, endNodeId: memberEdit.nodeId };
      case 'confirmed': return { ...member, confirmed: memberEdit.confirmed };
      default: {
        const exhaustiveCheck: never = memberEdit;
        return exhaustiveCheck;
      }
    }
  }) };
}

export type BeamDefinition = StandardBeamDefinition | StandardBeamBucklingDefinition | StandardBeamTransientDefinition
  | StandardBeamContactDefinition | StandardBeamImpactDefinition | StandardBeamFrictionDefinition;
/** Schemas 3 to 6 carry explicit six-DOF supports; 3 to 5 also carry reference loads and 6 (impact) carries no load.
 * Schemas 1 and 2 carry fixed clamps and loads instead. */
const savedLoads = (definition: BeamDefinition) => 'referenceLoads' in definition ? definition.referenceLoads
  : 'loads' in definition ? definition.loads : definition.schema === 'pointercad-standard-beam/7' ? definition.stepLoads[0] : [];
const savedSupports = (definition: BeamDefinition) => 'supports' in definition ? definition.supports : [];
const savedClamps = (definition: BeamDefinition) => 'constraints' in definition ? definition.constraints : [];
type TransientDraftCheck = { readonly ok: true; readonly history: BeamTransientHistory }
  | { readonly ok: false; readonly field: string; readonly diagnostic: string | null };

/** Parses the time-history text with the shared beam expression rules; the model decodes it strictly afterwards. */
function transientHistory(draft: TransientDraft, parameters: readonly Parameter[]): TransientDraftCheck {
  const read = (name: TransientFieldName, key: string, source: string, integer: boolean): number | TransientDraftCheck => {
    const parsed = readTransientField(name, key, source, parameters);
    if (parsed.value === null || parsed.error !== null) return { ok: false, field: key, diagnostic: parsed.error?.message ?? null };
    if (integer && !Number.isSafeInteger(parsed.value.value)) return { ok: false, field: key, diagnostic: null };
    return parsed.value.value;
  };
  const timeStepS = read('timeStep', 'transient:timeStep', draft.timeStep, false);
  if (typeof timeStepS !== 'number') return timeStepS;
  const stepCount = read('stepCount', 'transient:stepCount', draft.stepCount, true);
  if (typeof stepCount !== 'number') return stepCount;
  const outputEvery = read('outputEvery', 'transient:outputEvery', draft.outputEvery, true);
  if (typeof outputEvery !== 'number') return outputEvery;
  let damping: BeamTransientHistory['damping'] = 'none';
  if (draft.damping === 'rayleigh') {
    const massCoefficientPerS = read('massCoefficientPerS', 'transient:massCoefficientPerS', draft.massCoefficientPerS, false);
    if (typeof massCoefficientPerS !== 'number') return massCoefficientPerS;
    const stiffnessCoefficientS = read('stiffnessCoefficientS', 'transient:stiffnessCoefficientS', draft.stiffnessCoefficientS, false);
    if (typeof stiffnessCoefficientS !== 'number') return stiffnessCoefficientS;
    damping = { kind: 'rayleigh', massCoefficientPerS, stiffnessCoefficientS };
  }
  const loadFactor: { timeS: number; factor: number }[] = [];
  for (const [index, row] of draft.samples.entries()) {
    const timeS = read('sampleTime', `transient:sample:${index}:time`, row.time, false);
    if (typeof timeS !== 'number') return timeS;
    const factor = read('sampleFactor', `transient:sample:${index}:factor`, row.factor, false);
    if (typeof factor !== 'number') return factor;
    loadFactor.push({ timeS, factor });
  }
  return { ok: true, history: { timeStepS, stepCount, outputEvery, loadFactor, damping, initialConditions: 'zero-at-rest' } };
}
export type BeamDraftCheck = { readonly ok: true; readonly definition: BeamDefinition }
  | { readonly ok: false; readonly key: MessageKey; readonly field: string | null; readonly diagnostic: string | null };
type ContactDraftCheck = { readonly ok: true; readonly contacts: readonly StandardBeamContactInput[]; readonly loadFactors: readonly number[] }
  | { readonly ok: false; readonly key: MessageKey; readonly field: string; readonly diagnostic: string | null };

/** Parses the contact text with the shared beam expression rules. A node that is no longer one of the selected
 * members' nodes (member removed or reconnected) is refused here, never dropped; the model and the solver input
 * then check directions, ranges, orientation and duplicates. Gaps stay in mm. */
function contactInputs(draft: ContactDraft, nodeIds: ReadonlySet<string>, parameters: readonly Parameter[], withFactors = true): ContactDraftCheck {
  if (draft.rows.length === 0) return { ok: false, key: 'beam.error.contacts', field: 'contact:add', diagnostic: null };
  const read = (name: ContactFieldName, key: string, source: string): number | ContactDraftCheck => {
    const parsed = readContactField(name, key, source, parameters);
    if (parsed.value === null || parsed.error !== null) {
      return { ok: false, key: 'beam.error.inputs', field: key, diagnostic: parsed.error?.message ?? null };
    }
    return parsed.value.value;
  };
  const contacts: StandardBeamContactInput[] = [];
  for (const row of draft.rows) {
    const ends: readonly (readonly ['nodeA' | 'nodeB', string])[] = row.kind === 'node-plane' ? [['nodeA', row.nodeIdA]]
      : [['nodeA', row.nodeIdA], ['nodeB', row.nodeIdB]];
    const missing = ends.find(([, nodeId]) => !nodeIds.has(nodeId));
    if (missing !== undefined) return { ok: false, key: 'beam.error.contactNode', field: `contact:${row.id}:${missing[0]}`, diagnostic: null };
    const normal: number[] = [];
    for (const [axis, name] of normalFields.entries()) {
      const value = read(name, `contact:${row.id}:${name}`, row.normal[axis]);
      if (typeof value !== 'number') return value;
      normal.push(value);
    }
    const gapMm = read('gap', `contact:${row.id}:gap`, row.gap);
    if (typeof gapMm !== 'number') return gapMm;
    if (gapMm < 0) return { ok: false, key: 'beam.error.contactGap', field: `contact:${row.id}:gap`, diagnostic: null };
    const direction: Vector3 = [normal[0], normal[1], normal[2]];
    contacts.push(row.kind === 'node-plane'
      ? { kind: 'node-plane', id: row.id, nodeId: row.nodeIdA, normal: direction, gapMm }
      : { kind: 'node-pair', id: row.id, nodeIdA: row.nodeIdA, nodeIdB: row.nodeIdB, normal: direction, gapMm });
  }
  const loadFactors: number[] = [];
  for (const [index, source] of (withFactors ? draft.loadFactors : []).entries()) {
    const factor = read('loadFactor', `contact:factor:${index}`, source);
    if (typeof factor !== 'number') return factor;
    loadFactors.push(factor);
  }
  return { ok: true, contacts, loadFactors };
}

type FrictionCheck = { readonly ok: true; readonly friction: StandardBeamFrictionDefinition['friction']; readonly stepLoads: StandardBeamFrictionDefinition['stepLoads']; readonly solverOptions: StandardBeamFrictionDefinition['solverOptions'] }
  | { readonly ok: false; readonly field: string; readonly diagnostic: string | null };
function frictionInputs(draft: FrictionDraft, contacts: readonly StandardBeamContactInput[], nodes: ReadonlySet<string>, parameters: readonly Parameter[]): FrictionCheck {
  const fail = (field: string, diagnostic: string | null = null): FrictionCheck => ({ ok: false, field, diagnostic });
  if (Object.keys(draft.coefficients).some(id => !contacts.some(contact => contact.id === id))) return fail('friction:coefficients');
  const friction: Record<string, number> = {};
  for (const contact of contacts) {
    const field = `friction:coefficient:${contact.id}`;
    const value = readContactField('loadFactor', field, draft.coefficients[contact.id] ?? '', parameters);
    if (value.value === null || value.error !== null || value.value.value < 0) return fail(field, value.error?.message ?? null);
    friction[contact.id] = value.value.value;
  }
  const iteration = readTransientField('stepCount', 'friction:iterationLimit', draft.iterationLimit, parameters);
  if (iteration.value === null || iteration.error !== null || !Number.isSafeInteger(iteration.value.value) || iteration.value.value <= 0) return fail('friction:iterationLimit', iteration.error?.message ?? null);
  if (draft.solver !== 'newton' && draft.solver !== 'nsgs') return fail('friction:solver');
  if (draft.steps.length < 1 || draft.steps.length > 32) return fail('friction:steps');
  const fields = { force: ['startFx', 'startFy', 'startFz'], moment: ['startMx', 'startMy', 'startMz'] } as const;
  const stepLoads: { id: string; kind: 'nodal'; nodeId: string; force: [number, number, number]; moment: [number, number, number] }[][] = [];
  for (const [stepIndex, step] of draft.steps.entries()) {
    if (step.loads.length === 0) return fail(`friction:step:${stepIndex}`);
    const rows: typeof stepLoads[number] = [];
    for (const [loadIndex, load] of step.loads.entries()) {
      const field = `friction:step:${stepIndex}:load:${loadIndex}`;
      if (!load.id || !nodes.has(load.nodeId) || rows.some(row => row.id === load.id)) return fail(field);
      const vectors: [number, number, number][] = [];
      for (const name of ['force', 'moment'] as const) {
        const vector: [number, number, number] = [0, 0, 0];
        for (const axis of [0, 1, 2] as const) {
          const parsed = readBeamField(fields[name][axis], load[name][axis], parameters);
          if (parsed.value === null || parsed.error !== null) return fail(`${field}:${name}:${axis}`, parsed.error?.message ?? null);
          vector[axis] = parsed.value.value;
        }
        vectors.push(vector);
      }
      rows.push({ id: load.id, kind: 'nodal', nodeId: load.nodeId, force: vectors[0], moment: vectors[1] });
    }
    if (stepIndex > 0 && (rows.length !== stepLoads[0].length || rows.some((row, i) => row.id !== stepLoads[0][i].id || row.nodeId !== stepLoads[0][i].nodeId))) return fail(`friction:step:${stepIndex}`);
    stepLoads.push(rows);
  }
  if (!stepLoads.some(step => step.some(load => [...load.force, ...load.moment].some(value => value !== 0)))) return fail('friction:steps');
  return { ok: true, friction, stepLoads, solverOptions: { solver: draft.solver, iterationLimit: iteration.value.value } };
}

type ImpactSavedSettings = Omit<StandardBeamImpactDefinition['impact'], 'segmentsPerMember'>;
type ImpactSaveCheck = { readonly ok: true; readonly settings: ImpactSavedSettings }
  | { readonly ok: false; readonly key: MessageKey; readonly field: string; readonly diagnostic: string | null };

/** Impact text: velocities (m/s), stiffness (N/m) and history (s) use the impact draft parser with the shared field
 * rules; the fixed planes are the node-plane contact rows, saved with their original direction and gap in mm (the
 * solver route normalizes and converts them). Node pairs and nodes that are no longer selected are refused. */
function impactInputs(session: BeamSession, nodeIds: ReadonlySet<string>, parameters: readonly Parameter[]): ImpactSaveCheck {
  const checked = impactSettingsFromDraft(session.impact, session.contact, parameters);
  if (!checked.ok) return { ok: false, key: checked.key, field: checked.field, diagnostic: null };
  const planes: ImpactSavedSettings['planes'][number][] = [];
  for (const row of session.contact.rows) {
    if (!nodeIds.has(row.nodeIdA)) return { ok: false, key: 'beam.error.contactNode', field: `contact:${row.id}:nodeA`, diagnostic: null };
    const read = (name: ContactFieldName, source: string): number | null =>
      readContactField(name, `contact:${row.id}:${name}`, source, parameters).value?.value ?? null;
    const x = read('normalX', row.normal[0]), y = read('normalY', row.normal[1]), z = read('normalZ', row.normal[2]);
    const gapMm = read('gap', row.gap);
    if (x === null || y === null || z === null || gapMm === null) {
      return { ok: false, key: 'beam.error.inputs', field: `contact:${row.id}:gap`, diagnostic: null };
    }
    planes.push({ id: row.id, nodeId: row.nodeIdA, normal: [x, y, z], gapMm });
  }
  for (const velocity of checked.settings.initialVelocities) {
    if (!nodeIds.has(velocity.nodeId)) {
      return { ok: false, key: 'beam.error.contactNode', field: `impact:velocity:${velocity.nodeId}:0`, diagnostic: null };
    }
  }
  // Outlines of the current members only, saved under the section id beamDefinition gives each member below.
  const outlines = fibreOutlinesFromDraft(session.impact, session.members.map(member => member.id), parameters);
  if (!outlines.ok) return { ok: false, key: outlines.key, field: outlines.field, diagnostic: null };
  const fibreSections = [...outlines.outlines].map(([memberId, outline]) => ({ sectionId: `${memberId}-section`, outline }));
  return { ok: true, settings: { initialVelocities: checked.settings.initialVelocities, planes,
    contactStiffnessNPerM: checked.settings.contactStiffnessNPerM, history: checked.settings.history,
    ...(fibreSections.length === 0 ? {} : { fibreSections }) } };
}

/** Converts explicit form values only. Ground, mates, grade names and mesh measurements are not supports or properties. */
export function beamDefinition(session: BeamSession, source: BeamSourceSnapshot, parameters: readonly Parameter[]): BeamDraftCheck {
  const fail = (key: MessageKey, field: string | null = null, diagnostic: string | null = null): BeamDraftCheck =>
    ({ ok: false, key, field, diagnostic });
  if (session.members.length === 0) return fail('beam.error.selection');
  // Changing analysis mode must not silently discard an active physical connection.
  if ((session.axialBolts.length > 0 || session.weldLayers.length > 0 || session.weldSpanLayers !== null || session.initialStrain !== null)
    && session.analysisType !== 'contact') return fail('beam.error.model');
  const span = session.weldSpanLayers;
  if (span !== null && (session.weldLayers.length > 0 || session.axialBolts.length > 0 || session.initialStrain !== null)) {
    return fail('beam.error.model', null, 'weld-span-mixed: legacy weld, bolt and initial strain combinations are unsupported');
  }
  if (span !== null && (span.analysisId !== session.analysisId || span.analysisRevision !== session.revision
    || span.source.documentId !== source.source.documentId || span.source.documentRevision !== source.source.documentRevision
    || span.source.geometryRevision !== source.source.geometryRevision)) {
    return fail('beam.error.model', null, 'weld-span-stale: current source and analysis identity required');
  }
  const materials: StandardBeamDefinition['materials'][number][] = [];
  const sections: StandardBeamDefinition['sections'][number][] = [];
  const members: StandardBeamDefinition['members'][number][] = [];
  const fixed = new Set<string>();
  const supports = new Map<string, BucklingRestraints>();
  const loads = new Map<string, { force: [number, number, number]; moment: [number, number, number] }>();
  for (const member of session.members) {
    if (!member.confirmed) return fail('beam.error.confirmation');
    const values = new Map<BeamFieldName, number>();
    for (const name of names) {
      const parsed = readBeamField(name, member.values[name], parameters);
      if (parsed.value === null || parsed.error !== null) return fail('beam.error.inputs', `${member.id}:${name}`, parsed.error?.message ?? null);
      values.set(name, parsed.value.value);
    }
    const value = (name: BeamFieldName): number => {
      const number = values.get(name);
      if (number === undefined) throw new Error('Validated beam field disappeared');
      return number;
    };
    const materialId = `${member.id}-material`, sectionId = `${member.id}-section`;
    materials.push({ id: materialId, youngModulus: value('young'), shearModulus: value('shear'),
      densityKgM3: value('density'), source: member.material });
    sections.push({ id: sectionId, area: value('area'), iy: value('iy'), iz: value('iz'),
      torsionConstant: value('torsion'), shearFactor: value('shearFactor'), source: member.section });
    const angle = value('principalAngle') * Math.PI / 180;
    members.push({ id: member.id, occurrencePath: member.occurrence.path, expectedPartKey: member.occurrence.partKey,
      startNodeId: member.startNodeId, endNodeId: member.endNodeId, materialId, sectionId,
      sectionFrame: { centroidMm: [value('cx'), value('cy'), 0], principalY: [Math.cos(angle), Math.sin(angle), 0],
        confirmed: true, shearCenterModel: 'coincident-with-centroid', source: member.frame } });
    if (member.fixedStart) fixed.add(member.startNodeId);
    if (member.fixedEnd) fixed.add(member.endNodeId);
    for (const [nodeId, mask] of [[member.startNodeId, member.startRestraints], [member.endNodeId, member.endRestraints]] as const) {
      const prior = supports.get(nodeId) ?? freeRestraints();
      supports.set(nodeId, [prior[0] || mask[0], prior[1] || mask[1], prior[2] || mask[2],
        prior[3] || mask[3], prior[4] || mask[4], prior[5] || mask[5]]);
    }
    const addLoad = (nodeId: string, force: Vector3, moment: Vector3): void => {
      const prior = loads.get(nodeId) ?? { force: [0, 0, 0], moment: [0, 0, 0] };
      loads.set(nodeId, { force: [prior.force[0] + force[0], prior.force[1] + force[1], prior.force[2] + force[2]],
        moment: [prior.moment[0] + moment[0], prior.moment[1] + moment[1], prior.moment[2] + moment[2]] });
    };
    addLoad(member.startNodeId, [value('startFx'), value('startFy'), value('startFz')], [value('startMx'), value('startMy'), value('startMz')]);
    addLoad(member.endNodeId, [value('endFx'), value('endFy'), value('endFz')], [value('endMx'), value('endMy'), value('endMz')]);
  }
  const history = session.analysisType === 'transient' ? transientHistory(session.transient, parameters) : null;
  if (history !== null && !history.ok) return fail('beam.error.inputs', history.field, history.diagnostic);
  const nodeIds = new Set(members.flatMap(member => [member.startNodeId, member.endNodeId]));
  const contact = session.analysisType === 'contact' || session.analysisType === 'friction' ? contactInputs(session.contact,
    nodeIds, parameters, session.analysisType === 'contact') : null;
  if (contact !== null && !contact.ok) return fail(contact.key, contact.field, contact.diagnostic);
  const friction = session.analysisType === 'friction' && contact !== null && contact.ok
    ? frictionInputs(session.friction, contact.contacts, nodeIds, parameters) : null;
  if (friction !== null && !friction.ok) return fail('beam.error.inputs', friction.field, friction.diagnostic);
  const impact = session.analysisType === 'impact' ? impactInputs(session,
    new Set(members.flatMap(member => [member.startNodeId, member.endNodeId])), parameters) : null;
  if (impact !== null && !impact.ok) return fail(impact.key, impact.field, impact.diagnostic);
  const common = {
    id: session.analysisId, revision: session.revision,
    source: source.source, units: 'N-mm' as const, members, materials, sections,
  };
  const nodalLoads = [...loads].filter(([, load]) => [...load.force, ...load.moment].some(value => value !== 0))
    .map(([nodeId, load], index) => ({ id: `load-${index}`, kind: 'nodal' as const, nodeId, ...load }));
  const explicitSupports = [...supports].filter(([, restrained]) => restrained.some(Boolean))
    .map(([nodeId, restrained]) => ({ nodeId, restrained }));
  const baseline = session.frictionRestoreBaseline;
  const original = session.analysisType === 'friction' && baseline !== undefined
    && baseline.geometryKey === frictionGeometryKey(session.members, session.segmentsPerMember)
    && JSON.stringify(baseline.openedSource) === JSON.stringify(source.source) ? baseline.definition : null;
  // An impact starts from rest with no external load; entered member loads are refused, never silently dropped.
  if (impact !== null && nodalLoads.length > 0) return fail('beam.error.model', null, 'impact: no external load is applied');
  const definition: BeamDefinition = impact !== null ? {
    ...common, schema: 'pointercad-standard-beam/6',
    impact: { segmentsPerMember: session.segmentsPerMember, ...impact.settings },
    supports: explicitSupports,
  } : history !== null ? {
    ...common, schema: 'pointercad-standard-beam/4',
    transient: { segmentsPerMember: session.segmentsPerMember, history: history.history },
    supports: explicitSupports, referenceLoads: nodalLoads,
  } : friction !== null && friction.ok && contact !== null && contact.ok ? {
    ...common, ...(original === null ? {} : { members: original.members, materials: original.materials, sections: original.sections }),
    schema: 'pointercad-standard-beam/7',
    contact: { segmentsPerMember: session.segmentsPerMember, contacts: contact.contacts }, supports: original?.supports ?? explicitSupports,
    friction: friction.friction, stepLoads: friction.stepLoads, solverOptions: friction.solverOptions,
  } : contact !== null ? {
    ...common, schema: 'pointercad-standard-beam/5',
    ...(session.initialStrain === null ? {} : { initialStrain: session.initialStrain }),
    ...(session.axialBolts.length === 0 ? {} : { axialBolts: {
      schema: 'pointercad-cad-axial-bolts/1' as const, source: source.source, analysisId: session.analysisId,
      analysisRevision: session.revision, bolts: session.axialBolts } }),
    ...(session.weldLayers.length === 0 ? {} : { weldLayers: {
      schema: 'pointercad-cad-weld-layers/1' as const, source: source.source, analysisId: session.analysisId,
      analysisRevision: session.revision, welds: session.weldLayers } }),
    ...(span === null ? {} : { weldLayers: span }),
    contact: { segmentsPerMember: session.segmentsPerMember, contacts: contact.contacts, loadFactors: contact.loadFactors },
    supports: explicitSupports, referenceLoads: nodalLoads,
  } : session.analysisType === 'buckling' ? {
    ...common, schema: 'pointercad-standard-beam/3',
    buckling: { modeCount: session.modeCount, segmentsPerMember: session.segmentsPerMember },
    supports: explicitSupports, referenceLoads: nodalLoads,
  } : {
    ...common,
    schema: session.analysisType === 'modal' ? 'pointercad-standard-beam/2' : 'pointercad-standard-beam/1',
    ...(session.analysisType === 'modal'
      ? { modal: { modeCount: session.modeCount, segmentsPerMember: session.segmentsPerMember } } : {}),
    constraints: [...fixed].map((nodeId, index) => ({ id: `support-${index}`, kind: 'fixed', nodeId })),
    loads: nodalLoads,
  };
  const checked = readBeamAnalysisInputs({ schema: 'pointercad-beam-inputs/1', analyses: [{ kind: 'standard-members', definition }] }, source.document.id);
  if (!checked.ok) return fail('beam.error.model', null, `${checked.issue.code}: ${checked.issue.path}: ${checked.issue.message}`);
  return { ok: true, definition };
}

/** Restores inputs without results or trust in the saved geometry generation. Shared node loads are not duplicated. */
export function restoreBeamSession(ownerId: string, definition: BeamDefinition, occurrences: readonly BeamOccurrence[], openedSource: BeamDefinition['source'] = definition.source): BeamSession {
  if (definition.schema === 'pointercad-standard-beam/7') {
    const checked = readBeamAnalysisInputs({ schema: 'pointercad-beam-inputs/1', analyses: [{ kind: 'standard-members', definition }] }, definition.source.documentId);
    if (!checked.ok) throw new Error(`friction-input: ${checked.issue.code}: ${checked.issue.path}`);
  }
  if (definition.schema === 'pointercad-standard-beam/5' && definition.weldLayers?.schema === 'pointercad-cad-weld-layers/2') {
    const checked = readBeamAnalysisInputs({ schema: 'pointercad-beam-inputs/1', analyses: [
      { kind: 'standard-members', definition }] }, definition.source.documentId);
    if (!checked.ok) throw new Error(`weld-span-input: ${checked.issue.code}: ${checked.issue.path}`);
    if (definition.axialBolts !== undefined || definition.initialStrain !== undefined) {
      throw new Error('weld-span-mixed: bolt and initial strain combinations are unsupported');
    }
  }
  const source = createBeamSession(ownerId, definition.id);
  // Saved numbers become the shortest exact plain decimal: the same double on reading back, and never exponent text,
  // which the expression grammar has no syntax for (String(1e-7) is '1e-7'). No 12-digit rounding either.
  const exact = (value: number): string => exactExpressionValueFromNumber(value).source;
  const assignedLoads = new Set<string>();
  const members: BeamMemberDraft[] = [];
  for (const member of definition.members) {
    const material = definition.materials.find(row => row.id === member.materialId);
    const section = definition.sections.find(row => row.id === member.sectionId);
    if (material === undefined || section === undefined) continue;
    const label = occurrences.find(row => JSON.stringify(row.path) === JSON.stringify(member.occurrencePath))?.label
      ?? member.occurrencePath.join(' / ');
    const values = emptyValues();
    Object.assign(values, {
      young: exact(material.youngModulus), shear: exact(material.shearModulus), density: exact(material.densityKgM3),
      area: exact(section.area), iy: exact(section.iy), iz: exact(section.iz), torsion: exact(section.torsionConstant),
      shearFactor: exact(section.shearFactor), cx: exact(member.sectionFrame.centroidMm[0]), cy: exact(member.sectionFrame.centroidMm[1]),
      principalAngle: exact(Math.atan2(member.sectionFrame.principalY[1], member.sectionFrame.principalY[0]) * 180 / Math.PI),
    });
    for (const [end, nodeId] of [['start', member.startNodeId], ['end', member.endNodeId]] as const) {
      if (assignedLoads.has(nodeId)) continue;
      assignedLoads.add(nodeId);
      const nodeLoads = savedLoads(definition)
        .filter(load => load.nodeId === nodeId);
      for (const [axis, index] of [['x', 0], ['y', 1], ['z', 2]] as const) {
        values[`${end}F${axis}`] = exact(nodeLoads.reduce((sum, load) => sum + load.force[index], 0));
        values[`${end}M${axis}`] = exact(nodeLoads.reduce((sum, load) => sum + load.moment[index], 0));
      }
    }
    const startRestraints = savedSupports(definition).find(row => row.nodeId === member.startNodeId)?.restrained ?? freeRestraints();
    const endRestraints = savedSupports(definition).find(row => row.nodeId === member.endNodeId)?.restrained ?? freeRestraints();
    members.push({ id: member.id, occurrence: { path: definition.schema === 'pointercad-standard-beam/7'
      ? [...member.occurrencePath] : member.occurrencePath, partKey: member.expectedPartKey, label }, values,
      startNodeId: member.startNodeId, endNodeId: member.endNodeId,
      fixedStart: savedClamps(definition).some(row => row.nodeId === member.startNodeId),
      fixedEnd: savedClamps(definition).some(row => row.nodeId === member.endNodeId),
      startRestraints: definition.schema === 'pointercad-standard-beam/7' ? copyRestraints(startRestraints) : startRestraints,
      endRestraints: definition.schema === 'pointercad-standard-beam/7' ? copyRestraints(endRestraints) : endRestraints,
      confirmed: false,
      material: definition.schema === 'pointercad-standard-beam/7' ? structuredClone(material.source) : material.source,
      section: definition.schema === 'pointercad-standard-beam/7' ? structuredClone(section.source) : section.source,
      frame: definition.schema === 'pointercad-standard-beam/7' ? structuredClone(member.sectionFrame.source) : member.sectionFrame.source });
  }
  let nextMember = 1;
  while (members.some(member => member.id === `beam-member-${nextMember}`)) nextMember += 1;
  const settings = definition.schema === 'pointercad-standard-beam/3' ? definition.buckling
    : definition.schema === 'pointercad-standard-beam/4' ? { modeCount: 6, segmentsPerMember: definition.transient.segmentsPerMember }
    : definition.schema === 'pointercad-standard-beam/5' || definition.schema === 'pointercad-standard-beam/7' ? { modeCount: 6, segmentsPerMember: definition.contact.segmentsPerMember }
    : definition.schema === 'pointercad-standard-beam/6' ? { modeCount: 6, segmentsPerMember: definition.impact.segmentsPerMember }
    : definition.modal;
  // The previous formatter (expressionValueFromNumber) rounded to 12 significant digits, so 1/3 came back as a
  // different double; the exact formatter keeps every saved value. Counts are safe integers and stay String().
  const transient: TransientDraft = definition.schema === 'pointercad-standard-beam/4' ? {
    damping: definition.transient.history.damping === 'none' ? 'none' : 'rayleigh',
    massCoefficientPerS: definition.transient.history.damping === 'none' ? '0' : exact(definition.transient.history.damping.massCoefficientPerS),
    stiffnessCoefficientS: definition.transient.history.damping === 'none' ? '0' : exact(definition.transient.history.damping.stiffnessCoefficientS),
    timeStep: exact(definition.transient.history.timeStepS), stepCount: String(definition.transient.history.stepCount),
    outputEvery: String(definition.transient.history.outputEvery),
    samples: definition.transient.history.loadFactor.map(row => ({ time: exact(row.timeS), factor: exact(row.factor) })),
  } : source.transient;
  // Saved contacts come back with their ids, nodes, exact directions and gaps in mm; nothing is re-derived from CAD.
  const contactRows: ContactRowDraft[] = definition.schema === 'pointercad-standard-beam/5' || definition.schema === 'pointercad-standard-beam/7'
    ? definition.contact.contacts.map(row => ({ id: row.id, kind: row.kind,
      nodeIdA: row.kind === 'node-plane' ? row.nodeId : row.nodeIdA, nodeIdB: row.kind === 'node-plane' ? '' : row.nodeIdB,
      normal: [exact(row.normal[0]), exact(row.normal[1]), exact(row.normal[2])], gap: exact(row.gapMm) }))
    // Impact planes come back as node-plane rows with their original direction and gap in mm (never normalized).
    : definition.schema === 'pointercad-standard-beam/6' ? definition.impact.planes.map((row): ContactRowDraft => ({
      id: row.id, kind: 'node-plane', nodeIdA: row.nodeId, nodeIdB: '',
      normal: [exact(row.normal[0]), exact(row.normal[1]), exact(row.normal[2])], gap: exact(row.gapMm) })) : [];
  let nextContact = 1;
  while (contactRows.some(row => row.id === `contact-${nextContact}`)) nextContact += 1;
  const contact: ContactDraft = definition.schema === 'pointercad-standard-beam/5'
    ? { nextContact, rows: contactRows, loadFactors: definition.contact.loadFactors.map(exact) }
    : definition.schema === 'pointercad-standard-beam/6' || definition.schema === 'pointercad-standard-beam/7' ? { ...source.contact, nextContact, rows: contactRows } : source.contact;
  const friction: FrictionDraft = definition.schema === 'pointercad-standard-beam/7' ? {
    coefficients: Object.fromEntries(Object.entries(definition.friction).map(([id, value]) => [id, exact(value)])),
    solver: definition.solverOptions.solver, iterationLimit: String(definition.solverOptions.iterationLimit),
    steps: definition.stepLoads.map(loads => ({ loads: loads.map(load => ({ id: load.id, nodeId: load.nodeId,
      force: [exact(load.force[0]), exact(load.force[1]), exact(load.force[2])],
      moment: [exact(load.moment[0]), exact(load.moment[1]), exact(load.moment[2])] })) })),
  } : source.friction;
  const impact: ImpactDraft = definition.schema === 'pointercad-standard-beam/6' ? {
    velocities: definition.impact.initialVelocities.map((row): ImpactVelocityRowDraft => ({ nodeId: row.nodeId,
      velocity: [exact(row.velocityMPerS[0]), exact(row.velocityMPerS[1]), exact(row.velocityMPerS[2])] })),
    contactStiffness: exact(definition.impact.contactStiffnessNPerM), timeStep: exact(definition.impact.history.timeStepS),
    stepCount: String(definition.impact.history.stepCount), outputEvery: String(definition.impact.history.outputEvery),
    // Saved outlines come back per member (through its saved section id) as exact mm text.
    ...(definition.impact.fibreSections === undefined ? {} : { fibreSections: Object.fromEntries(
      definition.impact.fibreSections.flatMap(row => {
        const member = definition.members.find(candidate => candidate.sectionId === row.sectionId);
        const outline: StandardBeamFibreOutline = row.outline;
        const text: FibreOutlineDraft = outline.kind === 'rectangle'
          ? { kind: 'rectangle', first: exact(outline.widthYMm), second: exact(outline.depthZMm) }
          : outline.kind === 'circle' ? { kind: 'circle', first: exact(outline.diameterMm), second: '' }
          : { kind: 'tube', first: exact(outline.outsideDiameterMm), second: exact(outline.wallThicknessMm) };
        return member === undefined ? [] : [[member.id, text] as const];
      })) }),
  } : source.impact;
  const restoredSegments = settings?.segmentsPerMember ?? 8;
  const frictionRestoreBaseline: FrictionRestoreBaseline | undefined = definition.schema === 'pointercad-standard-beam/7'
    // Reopening creates a new geometry-generation token. Bind editable inputs to that current opening,
    // while the saved definition and its original IDs remain owned data, never restored results.
    ? freezeOwned({ definition: structuredClone(definition), geometryKey: frictionGeometryKey(members, restoredSegments),
      openedSource: structuredClone(openedSource) }) : undefined;
  return { ...source, revision: definition.revision, nextMember, members, transient, contact, friction, impact,
    ...(frictionRestoreBaseline === undefined ? {} : { frictionRestoreBaseline }),
    axialBolts: definition.schema === 'pointercad-standard-beam/5' ? definition.axialBolts?.bolts ?? [] : [],
    weldLayers: definition.schema === 'pointercad-standard-beam/5' && definition.weldLayers?.schema !== 'pointercad-cad-weld-layers/2' ? definition.weldLayers?.welds ?? [] : [],
    weldSpanLayers: definition.schema === 'pointercad-standard-beam/5'
      && definition.weldLayers?.schema === 'pointercad-cad-weld-layers/2' ? definition.weldLayers : null,
    initialStrain: definition.schema === 'pointercad-standard-beam/5' ? definition.initialStrain ?? null : null,
    analysisType: definition.schema === 'pointercad-standard-beam/7' ? 'friction' : definition.schema === 'pointercad-standard-beam/6' ? 'impact'
      : definition.schema === 'pointercad-standard-beam/5' ? 'contact'
      : definition.schema === 'pointercad-standard-beam/4' ? 'transient'
      : definition.schema === 'pointercad-standard-beam/3' ? 'buckling' : definition.modal === undefined ? 'static' : 'modal',
    modeCount: settings?.modeCount ?? 6, segmentsPerMember: settings?.segmentsPerMember ?? 8 };
}
