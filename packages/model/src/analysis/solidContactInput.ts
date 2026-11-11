import type { Vector3 } from './analysisModel.js';
import { fields, InputIssue, number, text } from './analysisValidation.js';

export const SOLID_CONTACT_SCHEMA = 'pointercad-solid-contact-input/1';
export const SOLID_CONTACT_ID = 'solid-contact';
export const SOLID_CONTACT_LIMITS = Object.freeze({ pairs: 64, idLength: 64, faceKeyLength: 16384,
  sourceIdLength: 256, gapMm: 1e6, unitNormalTolerance: 1e-9 });
/** The native Surface2FESurface_3d route. This declaration is not a solver capability receipt. */
export const SOLID_CONTACT_METHODS = ['surface-to-surface'] as const;
export type SolidContactMethod = typeof SOLID_CONTACT_METHODS[number];
export type SolidContactNormal =
  | { readonly kind: 'master-outward' }
  | { readonly kind: 'explicit'; readonly vector: Vector3 };
export interface SolidContactPair {
  readonly id: string;
  /** Opaque semantic keys produced by solidCadFaceKey; never runtime face indices. */
  readonly masterFace: string;
  readonly slaveFace: string;
  /** Direction points out of the master, towards positive separation. */
  readonly normal: SolidContactNormal;
  /** Declared initial separation, independent of the mesh-centre distance. */
  readonly gapMm: number;
  /** null declares frictionless contact. A numeric zero still needs a source. */
  readonly frictionCoefficient: number | null;
  readonly frictionSourceId: string | null;
  readonly method: SolidContactMethod;
}
/** Definitions for W57 persistence. Meshes, projections, reactions and CAD mates are not saved here. */
export interface SolidContactSavedInput {
  readonly schema: typeof SOLID_CONTACT_SCHEMA;
  readonly id: typeof SOLID_CONTACT_ID;
  readonly source: { readonly documentId: string };
  readonly contacts: readonly SolidContactPair[];
}

function dataFields(value: unknown, names: readonly string[], path: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)
    || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
    || Reflect.ownKeys(value).length !== names.length) {
    throw new InputIssue('shape', path, 'Expected the exact plain data fields');
  }
  for (const name of names) {
    const descriptor = Object.getOwnPropertyDescriptor(value, name);
    if (descriptor === undefined || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
      throw new InputIssue('shape', `${path}.${name}`, 'Expected an own enumerable data field');
    }
  }
  return fields(value, names, path);
}

function denseList(value: unknown, path: string, maximum: number): readonly unknown[] {
  if (!Array.isArray(value) || value.length > maximum) {
    throw new InputIssue('size', path, 'Collection exceeds the supported size');
  }
  if (Object.getPrototypeOf(value) !== Array.prototype || Reflect.ownKeys(value).length !== value.length + 1) {
    throw new InputIssue('shape', path, 'Expected a plain dense list without extra properties');
  }
  for (let index = 0; index < value.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, index);
    if (descriptor === undefined || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
      throw new InputIssue('shape', `${path}[${index}]`, 'Expected an own data element without holes');
    }
  }
  return value;
}

function validateNormal(value: unknown, path: string): void {
  // Inspect the discriminator through a data descriptor before reading a possibly executable property.
  const kind: unknown = value !== null && typeof value === 'object'
    ? Object.getOwnPropertyDescriptor(value, 'kind')?.value : undefined;
  const normal = dataFields(value, kind === 'explicit' ? ['kind', 'vector'] : ['kind'], path);
  if (normal.kind === 'master-outward') return;
  if (normal.kind !== 'explicit') throw new InputIssue('contact-normal', `${path}.kind`, 'Unknown normal convention');
  const components = denseList(normal.vector, `${path}.vector`, 3);
  if (components.length !== 3) throw new InputIssue('contact-normal', `${path}.vector`, 'Expected three unit-vector components');
  const vector = components.map((component, axis) => number(component, `${path}.vector[${axis}]`));
  if (Math.abs(Math.hypot(...vector) - 1) > SOLID_CONTACT_LIMITS.unitNormalTolerance) {
    throw new InputIssue('contact-normal', `${path}.vector`, 'Expected a unit vector within 1e-9; no implicit normalization');
  }
}

/** Throws the shared InputIssue (code/path/message); never adds defaults, changes units or infers contacts. */
export function validateSolidContactInput(value: unknown, path = 'solid-contact'): asserts value is SolidContactSavedInput {
  const row = dataFields(value, ['schema', 'id', 'source', 'contacts'], path);
  if (row.schema !== SOLID_CONTACT_SCHEMA || row.id !== SOLID_CONTACT_ID) {
    throw new InputIssue('unsupported-schema', path, 'Unsupported solid contact input version or id');
  }
  const source = dataFields(row.source, ['documentId'], `${path}.source`);
  text(source.documentId, `${path}.source.documentId`);
  const contacts = denseList(row.contacts, `${path}.contacts`, SOLID_CONTACT_LIMITS.pairs);
  const ids = new Set<string>(), pairs = new Set<string>();
  for (const [index, value] of contacts.entries()) {
    const itemPath = `${path}.contacts[${index}]`;
    const pair = dataFields(value, ['id', 'masterFace', 'slaveFace', 'normal', 'gapMm',
      'frictionCoefficient', 'frictionSourceId', 'method'], itemPath);
    const id = text(pair.id, `${itemPath}.id`, SOLID_CONTACT_LIMITS.idLength);
    if (ids.has(id)) throw new InputIssue('duplicate-id', `${itemPath}.id`, 'Contact ids must be unique');
    ids.add(id);
    const master = text(pair.masterFace, `${itemPath}.masterFace`, SOLID_CONTACT_LIMITS.faceKeyLength);
    const slave = text(pair.slaveFace, `${itemPath}.slaveFace`, SOLID_CONTACT_LIMITS.faceKeyLength);
    if (master === slave) throw new InputIssue('contact-self', itemPath, 'Master and slave must be different faces');
    const key = JSON.stringify([master, slave].sort());
    if (pairs.has(key)) throw new InputIssue('contact-duplicate', itemPath, 'A face pair must be unique, including reversed pairs');
    pairs.add(key);
    validateNormal(pair.normal, `${itemPath}.normal`);
    const gapMm = number(pair.gapMm, `${itemPath}.gapMm`);
    if (gapMm < 0 || gapMm > SOLID_CONTACT_LIMITS.gapMm) {
      throw new InputIssue('contact-gap', `${itemPath}.gapMm`, 'Expected an initial gap from 0 to 1000000 mm');
    }
    if (pair.frictionCoefficient === null) {
      if (pair.frictionSourceId !== null) {
        throw new InputIssue('contact-friction-source', `${itemPath}.frictionSourceId`, 'Frictionless contact requires a null source');
      }
    } else {
      const coefficient = number(pair.frictionCoefficient, `${itemPath}.frictionCoefficient`);
      if (coefficient < 0 || coefficient > 1) {
        throw new InputIssue('contact-friction', `${itemPath}.frictionCoefficient`, 'Expected a friction coefficient from 0 to 1');
      }
      if (pair.frictionSourceId === null || pair.frictionSourceId === '') {
        throw new InputIssue('contact-friction-source', `${itemPath}.frictionSourceId`, 'An explicit friction source id is required');
      }
      text(pair.frictionSourceId, `${itemPath}.frictionSourceId`, SOLID_CONTACT_LIMITS.sourceIdLength);
    }
    if (pair.method !== 'surface-to-surface') {
      throw new InputIssue('contact-method', `${itemPath}.method`, 'Unsupported solid contact method');
    }
  }
}

/** Owns all returned data, preserving property order and every saved value for JSON byte round trips. */
export function readSolidContactInput(value: unknown, path = 'solid-contact'): SolidContactSavedInput {
  validateSolidContactInput(value, path);
  return structuredClone(value);
}
