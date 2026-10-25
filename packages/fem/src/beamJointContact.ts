import type { BeamContactInput, BeamContactNumericResult } from './contactModel.js';
import type { OofemContactPlan } from './contactTranslation.js';
import { translateBeamBoltContact, decodeBeamBoltContact, type AxialBoltDefinition, type AxialBoltPlan, type AxialBoltForce } from './beamBoltContact.js';
import { translateBeamWeldContact, decodeBeamWeldContact, type WeldLayerDefinition, type WeldLayerPlan, type WeldLayerWrench } from './beamWeldContact.js';

/** Explicit simultaneous elastic shank/throat load sharing; existing single-connector types stay unchanged. */
export interface BeamJointContactInput {
  readonly schema: 'pointercad-joint-contact/1';
  readonly contact: BeamContactInput;
  readonly bolts: readonly AxialBoltDefinition[];
  readonly welds: readonly WeldLayerDefinition[];
}
export interface BeamJointContactPlan {
  readonly schema: 'pointercad-joint-contact-plan/1';
  readonly contact: OofemContactPlan;
  readonly bolts: readonly AxialBoltPlan[];
  readonly welds: readonly WeldLayerPlan[];
}
export interface BeamJointContactResult {
  readonly kind: 'oofem-beam-joint-contact';
  readonly schema: 'pointercad-joint-contact-result/1';
  readonly inputSha256: string;
  readonly structuralCertification: false;
  readonly contact: BeamContactNumericResult;
  readonly states: readonly { readonly loadFactor: number; readonly bolts: readonly AxialBoltForce[]; readonly welds: readonly WeldLayerWrench[] }[];
}
function fields(value: unknown, names: readonly string[]): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)
    || Reflect.ownKeys(value).length !== names.length || names.some(key => !Object.hasOwn(value, key))) {
    throw new Error('joint-shape: absent or unsupported fields');
  }
  return value as Record<string, unknown>;
}
function dense(value: unknown): value is unknown[] {
  return Array.isArray(value) && Reflect.ownKeys(value).length === value.length + 1
    && Array.from({ length: value.length }, (_, i) => Object.hasOwn(value, i)).every(Boolean);
}
export function translateBeamJointContact(value: unknown): { input: BeamJointContactInput; plan: BeamJointContactPlan } {
  const root = fields(value, ['schema', 'contact', 'bolts', 'welds']);
  if (root.schema !== 'pointercad-joint-contact/1') throw new Error('joint-schema');
  const contact = root.contact;
  const bolt = translateBeamBoltContact({ schema: 'pointercad-bolt-contact/1', contact, bolts: root.bolts });
  const weld = translateBeamWeldContact({ schema: 'pointercad-weld-layer/1', contact, welds: root.welds });
  if (JSON.stringify(bolt.plan.contact) !== JSON.stringify(weld.plan.contact)) throw new Error('joint-contact: one common physical input required');
  const ids = new Set(bolt.input.bolts.map(row => row.id));
  if (weld.input.welds.some(row => ids.has(row.id))) throw new Error('joint-id: connector identities must be distinct');
  return { input: { schema: 'pointercad-joint-contact/1', contact: bolt.input.contact, bolts: bolt.input.bolts, welds: weld.input.welds },
    plan: { schema: 'pointercad-joint-contact-plan/1', contact: bolt.plan.contact, bolts: bolt.plan.bolts, welds: weld.plan.welds } };
}
export async function beamJointContactInputSha256(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(translateBeamJointContact(value).input));
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), byte => byte.toString(16).padStart(2, '0')).join('');
}
/** Both existing constitutive decoders consume the exact same coupled contact response. */
export function decodeBeamJointContact(raw: unknown, value: BeamJointContactInput, hash: string): BeamJointContactResult {
  const { input } = translateBeamJointContact(value), root = fields(raw, ['schema', 'contact', 'states']);
  if (root.schema !== 'pointercad-joint-contact-result/1' || !dense(root.states)) throw new Error('joint-result-schema');
  const states = root.states.map(state => fields(state, ['loadFactor', 'bolts', 'welds']));
  const bolts = decodeBeamBoltContact({ schema: 'pointercad-bolt-contact-result/1', contact: root.contact,
    states: states.map(state => ({ loadFactor: state.loadFactor, bolts: state.bolts })) },
  { schema: 'pointercad-bolt-contact/1', contact: input.contact, bolts: input.bolts }, hash);
  const welds = decodeBeamWeldContact({ schema: 'pointercad-weld-layer-result/1', contact: root.contact,
    states: states.map(state => ({ loadFactor: state.loadFactor, welds: state.welds })) },
  { schema: 'pointercad-weld-layer/1', contact: input.contact, welds: input.welds }, hash);
  return { kind: 'oofem-beam-joint-contact', schema: 'pointercad-joint-contact-result/1', inputSha256: hash,
    structuralCertification: false, contact: welds.contact, states: welds.states.map((state, index) => ({
      loadFactor: state.loadFactor, bolts: bolts.states[index].bolts, welds: state.welds })) };
}
