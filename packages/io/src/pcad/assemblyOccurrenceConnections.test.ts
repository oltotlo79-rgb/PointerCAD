import {
  addComponent, createAssemblyDocument, createComponentFor,
  type AssemblyComponent, type AssemblyDocument, type JointOccurrenceConnection,
} from '@pointercad/model';
import { describe, expect, it } from 'vitest';
import { readAssemblyDocument, writeAssemblyDocument } from './assemblyJson.js';
import { PCAD_SCHEMA_VERSION } from './schema.js';

const SAVED_AT = '2026-10-16T00:00:00.000Z';
const FIRST = 'owner/日本:[]';
const SECOND = 'owner:"二"';
const GENERATED = 'generated/ボルト:1';
/** The current versions come from the product (envelope constant and a freshly created document), never literals. */
const CURRENT_ENVELOPE = PCAD_SCHEMA_VERSION;
const CURRENT_BODY = createAssemblyDocument('schema probe').schemaVersion;
const FUTURE = CURRENT_ENVELOPE + 1;
/** Historical versions: 20 is the last body without occurrence provenance, 21 the first that persisted it. */
const LEGACY = 20;
const LEGACY_PROVENANCE = 21;

function fixture(kind: 'bolt' | 'weld'): AssemblyDocument {
  let document = createAssemblyDocument('nested joint');
  for (const id of [FIRST, SECOND]) {
    const owner = createComponentFor(document, { kind: 'subAssembly', assemblyRef: `assembly:${id}` });
    document = addComponent(document, { ...owner, id });
  }
  const generated = createComponentFor(document, { kind: 'standardPart',
    catalog: kind === 'bolt' ? 'hexBolt' : 'filletWeld', size: 'fixture', options: {},
    catalogRevision: 'test-catalog', generatorRevision: 'test-generator' });
  document = addComponent(document, { ...generated, id: GENERATED });
  const connection: JointOccurrenceConnection = { kind,
    firstPath: [FIRST, 'shared/sub:assembly', 'leaf/同じ:[]'],
    secondPath: [SECOND, 'shared/sub:assembly', 'leaf/同じ:[]'], componentIds: [GENERATED] };
  return { ...document, schemaVersion: CURRENT_BODY, jointOccurrenceConnections: [connection] };
}

function saved(document: AssemblyDocument): string {
  return writeAssemblyDocument(document, { savedAt: SAVED_AT });
}

const envelope = (version: number): string => `"schema": ${String(version)}`;

/** Build malformed input at the persisted JSON boundary, not through the guarded writer. */
function persisted(document: AssemblyDocument, records: unknown): string {
  const original = { ...document, jointOccurrenceConnections: undefined };
  // The source document is never mutated; only the file's named provenance field changes.
  const without = saved(original);
  const marker = `"schemaVersion": ${String(CURRENT_BODY)}`;
  if (without.split(marker).length !== 2) throw new Error('fixture schema marker');
  return without.replace(marker, `${marker}, "jointOccurrenceConnections": ${JSON.stringify(records)}`);
}

describe('nested joint provenance IO', () => {
  it('derives current and future schema numbers from the product, so a version bump cannot leave stale fixtures', () => {
    // The body and envelope versions agree, both historical versions are older, and a written file carries the
    // current envelope; the future version is strictly newer than anything this build writes.
    expect(CURRENT_BODY).toBe(CURRENT_ENVELOPE);
    expect(LEGACY).toBeLessThan(LEGACY_PROVENANCE);
    expect(LEGACY_PROVENANCE).toBeLessThan(CURRENT_BODY);
    expect(FUTURE).toBeGreaterThan(CURRENT_BODY);
    expect(saved(fixture('bolt'))).toContain(envelope(CURRENT_ENVELOPE));
  });

  it.each<'bolt' | 'weld'>(['bolt', 'weld'])('roundtrips exact %s occurrence paths and generated ownership deterministically', kind => {
    const original = fixture(kind), text = saved(original);
    const opened = readAssemblyDocument(text);
    if (!opened.ok) throw new Error(JSON.stringify(opened.error));
    expect(opened.document.jointOccurrenceConnections).toEqual(original.jointOccurrenceConnections);
    expect(opened.document.components).toEqual(original.components);
    expect(saved(opened.document)).toBe(text);
    expect(text).toContain(envelope(CURRENT_ENVELOPE));
    expect(text).not.toContain('occurrenceKey');
    expect(text).not.toContain('previewStamp');
  });

  it.each<'bolt' | 'weld'>(['bolt', 'weld'])('migrates legacy21 persisted %s provenance to the current version without loss', kind => {
    const current = fixture(kind);
    const legacy: AssemblyDocument = { ...current, schemaVersion: LEGACY_PROVENANCE };
    const text = saved(legacy);
    expect(text).toContain(envelope(LEGACY_PROVENANCE));
    expect(text).toContain('jointOccurrenceConnections');
    const opened = readAssemblyDocument(text);
    if (!opened.ok) throw new Error(JSON.stringify(opened.error));
    expect(opened.document.schemaVersion).toBe(CURRENT_BODY);
    expect(opened.document.jointOccurrenceConnections).toEqual(current.jointOccurrenceConnections);
    expect(opened.document.components).toEqual(current.components);
    const resaved = saved(opened.document);
    expect(resaved).toContain(envelope(CURRENT_ENVELOPE));
    expect(resaved).toBe(saved(current));
  });

  it('retains reversible suppression of a persisted owner', () => {
    const base = fixture('weld');
    const original = { ...base, components: base.components.map(component => component.id === FIRST
      ? { ...component, suppressed: true } : component) };
    const opened = readAssemblyDocument(saved(original));
    if (!opened.ok) throw new Error(JSON.stringify(opened.error));
    expect(opened.document.jointOccurrenceConnections).toEqual(base.jointOccurrenceConnections);
    expect(opened.document.components.find(component => component.id === FIRST)?.suppressed).toBe(true);
  });

  it('allows separate generated joints between the same pair of occurrences', () => {
    const base = fixture('bolt'), connection = base.jointOccurrenceConnections?.[0];
    const generated = base.components.find(component => component.id === GENERATED);
    if (connection === undefined || generated === undefined) throw new Error('fixture');
    const otherId = 'generated:second';
    const original: AssemblyDocument = { ...base, components: [...base.components, { ...generated, id: otherId }],
      jointOccurrenceConnections: [connection, { ...connection, componentIds: [otherId] }] };
    const opened = readAssemblyDocument(saved(original));
    if (!opened.ok) throw new Error(JSON.stringify(opened.error));
    expect(opened.document.jointOccurrenceConnections).toEqual(original.jointOccurrenceConnections);
  });

  it('writes only durable fields even when a picked record carries transient runtime data', () => {
    const base = fixture('weld'), connection = base.jointOccurrenceConnections?.[0];
    if (connection === undefined) throw new Error('fixture connection');
    const picked = { ...connection, occurrenceKey: 'transient-only-key',
      previewStamp: { source: base }, resolvedGeometry: { positions: [1, 2, 3] } };
    const text = saved({ ...base, jointOccurrenceConnections: [picked] });
    expect(text).not.toContain('transient-only-key');
    expect(text).not.toContain('previewStamp');
    expect(text).not.toContain('resolvedGeometry');
    const opened = readAssemblyDocument(text);
    if (!opened.ok) throw new Error(JSON.stringify(opened.error));
    expect(opened.document.jointOccurrenceConnections).toEqual([connection]);
  });

  it('migrates legacy20 without inventing connections or altering owner identifiers', () => {
    const base = fixture('bolt');
    const legacy: AssemblyDocument = { ...base, schemaVersion: LEGACY, jointOccurrenceConnections: undefined };
    const opened = readAssemblyDocument(saved(legacy));
    if (!opened.ok) throw new Error(JSON.stringify(opened.error));
    expect(opened.document.schemaVersion).toBe(CURRENT_BODY);
    expect(Object.hasOwn(opened.document, 'jointOccurrenceConnections')).toBe(false);
    expect(opened.document.components).toEqual(base.components);
  });

  it('refuses writing occurrence provenance with version20, including an empty declared field', () => {
    expect(() => saved({ ...fixture('bolt'), schemaVersion: LEGACY })).toThrow(RangeError);
    expect(() => saved({ ...fixture('bolt'), schemaVersion: LEGACY, jointOccurrenceConnections: [] })).toThrow(RangeError);
  });

  it('refuses mismatched envelope/body versions before migration', () => {
    const text = saved(fixture('bolt')).replace(envelope(CURRENT_ENVELOPE), envelope(LEGACY));
    const opened = readAssemblyDocument(text);
    expect(opened.ok).toBe(false);
    if (!opened.ok) expect(opened.error.code).toBe('versionMismatch');
  });

  it('refuses a future schema before interpreting a malformed provenance body', () => {
    const text = persisted(fixture('weld'), null).replace(envelope(CURRENT_ENVELOPE), envelope(FUTURE));
    const opened = readAssemblyDocument(text);
    expect(opened.ok).toBe(false);
    if (!opened.ok) expect(opened.error.code).toBe('unsupportedNewVersion');
  });

  it.each([
    ['not an array', null], ['unknown kind', [{ kind: 'rivet', firstPath: [FIRST], secondPath: [SECOND], componentIds: [GENERATED] }]],
    ['empty path', [{ kind: 'bolt', firstPath: [], secondPath: [SECOND], componentIds: [GENERATED] }]],
    ['non-string segment', [{ kind: 'bolt', firstPath: [FIRST, 7], secondPath: [SECOND], componentIds: [GENERATED] }]],
    ['empty segment', [{ kind: 'bolt', firstPath: [FIRST, ''], secondPath: [SECOND], componentIds: [GENERATED] }]],
    ['missing owner', [{ kind: 'bolt', firstPath: ['absent'], secondPath: [SECOND], componentIds: [GENERATED] }]],
    ['missing generated component', [{ kind: 'bolt', firstPath: [FIRST], secondPath: [SECOND], componentIds: ['absent'] }]],
    ['owner as generated', [{ kind: 'bolt', firstPath: [FIRST], secondPath: [SECOND], componentIds: [FIRST] }]],
    ['empty generated list', [{ kind: 'bolt', firstPath: [FIRST], secondPath: [SECOND], componentIds: [] }]],
    ['duplicate generated ID', [{ kind: 'bolt', firstPath: [FIRST], secondPath: [SECOND], componentIds: [GENERATED, GENERATED] }]],
    ['same occurrence', [{ kind: 'bolt', firstPath: [FIRST, 'leaf'], secondPath: [FIRST, 'leaf'], componentIds: [GENERATED] }]],
  ])('rejects malformed persisted %s atomically', (_label, records) => {
    const source = fixture('bolt'), before = saved(source);
    const opened = readAssemblyDocument(persisted(source, records));
    expect(opened.ok).toBe(false);
    if (!opened.ok) {
      expect(opened.error.code).toBe('invalidField');
      expect(opened.error.message).toContain('document.jointOccurrenceConnections');
    }
    expect(saved(source)).toBe(before);
    expect(Object.hasOwn(opened, 'document')).toBe(false);
  });

  it('rejects duplicate/reversed records and generated ownership reused across records', () => {
    const source = fixture('bolt'), record = source.jointOccurrenceConnections?.[0];
    if (record === undefined) throw new Error('fixture connection');
    for (const second of [record, { ...record, firstPath: record.secondPath, secondPath: record.firstPath },
      { ...record, kind: 'weld', firstPath: [FIRST, 'another'] }]) {
      const opened = readAssemblyDocument(persisted(source, [record, second]));
      expect(opened.ok).toBe(false);
      if (!opened.ok) {
        expect(opened.error.code).toBe('invalidField');
        expect(opened.error.message).toContain('document.jointOccurrenceConnections');
      }
    }
  });

  it('rejects nested paths owned by a non-assembly root and non-generated component references', () => {
    const base = fixture('bolt');
    for (const target of [FIRST, GENERATED]) {
      const document = { ...base, components: base.components.map((component): AssemblyComponent => component.id === target
        ? { ...component, source: { kind: 'part', partRef: 'plain-part' } } : component) };
      const record = base.jointOccurrenceConnections;
      const opened = readAssemblyDocument(persisted(document, record));
      expect(opened.ok).toBe(false);
      if (!opened.ok) {
        expect(opened.error.code).toBe('invalidField');
        expect(opened.error.message).toContain('document.jointOccurrenceConnections');
      }
    }
  });
});
