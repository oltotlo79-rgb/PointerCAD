import { expect, it } from 'vitest';
import { createAssemblyDocument } from '../assembly/createAssemblyDocument.js';
import type { AssemblyDocument, JointOccurrenceConnection } from '../assembly/types.js';
import { compareAssemblyDocuments, type AssemblyLibraryDigest } from './compareAssemblyDrawing.js';

it('reports nested joint association changes and treats absent and empty relations equally', () => {
  const before = createAssemblyDocument('Nested joint comparison');
  const library: AssemblyLibraryDigest = { parts: new Map(), assemblies: new Map(), attachmentsDigest: '' };
  const options = { relationship: 'versions' as const, beforeLibrary: library, afterLibrary: library };
  const relation: JointOccurrenceConnection = {
    kind: 'weld', firstPath: ['owner,a', 'leaf'], secondPath: ['other'], componentIds: ['bead'],
  };
  const added: AssemblyDocument = { ...before, jointOccurrenceConnections: [relation] };
  const edited: AssemblyDocument = { ...added, jointOccurrenceConnections: [{ ...relation, secondPath: ['replacement'] }] };
  const snapshots = [before, added, edited].map(value => JSON.stringify(value));
  const changes: readonly (readonly [AssemblyDocument, AssemblyDocument])[] = [[before, added], [added, edited], [edited, before]];
  for (const [left, right] of changes) {
    const result = compareAssemblyDocuments(left, right, options);
    expect(result.changes).toHaveLength(1);
    expect(result.changes[0]).toMatchObject({ group: 'assembly-document', status: 'changed' });
    expect(result.changes[0].differences.length).toBeGreaterThan(0);
    expect(result.changes[0].differences.every(item => item.path[0] === 'jointOccurrenceConnections')).toBe(true);
    expect(result.geometryCompared).toBe(false);
  }
  const empty: AssemblyDocument = { ...before, jointOccurrenceConnections: [] };
  expect(compareAssemblyDocuments(before, empty, options).changes).toEqual([]);
  expect(compareAssemblyDocuments(empty, before, options).changes).toEqual([]);
  expect([before, added, edited].map(value => JSON.stringify(value))).toEqual(snapshots);
});
