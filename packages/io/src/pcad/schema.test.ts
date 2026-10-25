import { PART_SCHEMA_VERSION, ASSEMBLY_SCHEMA_VERSION } from '@pointercad/model';
import { describe, expect, it } from 'vitest';
import { PCAD_SCHEMA_VERSION, SCHEMA_MIGRATIONS } from './schema.js';
import { migrateToCurrentSchema } from './documentJson.js';

describe('schema22 nested joint compatibility gate', () => {
  it('uses the unified model and file version22', () => {
    expect(PCAD_SCHEMA_VERSION).toBe(22);
    expect(PART_SCHEMA_VERSION).toBe(22);
    expect(ASSEMBLY_SCHEMA_VERSION).toBe(22);
  });

  it.each(['part', 'assembly', 'drawing'])('migrates20 %s envelope and body together without manufacturing provenance', kind => {
    const raw = { schema: 20, kind, document: { schemaVersion: 20, id: 'id/日本:[]', custom: { retained: true } } };
    expect(migrateToCurrentSchema(raw, 20)).toEqual({ ...raw, schema: 22,
      document: { ...raw.document, schemaVersion: 22 } });
    expect(raw.schema).toBe(20);
    expect(raw.document.schemaVersion).toBe(20);
  });

  it('leaves malformed input malformed for the actual reader to reject', () => {
    const migrate = SCHEMA_MIGRATIONS[20];
    if (migrate === undefined) throw new Error('missing migration20');
    expect(migrate(null)).toBeNull();
    expect(migrate({ schema: 20, document: null })).toEqual({ schema: 20, document: null });
  });
});
