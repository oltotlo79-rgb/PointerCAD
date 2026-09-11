import { describe, expect, it } from 'vitest';
import fixtures from './zipDescriptorFixtures.json';
import { readArchive } from './readArchive.js';

function decode(encoded: string): Uint8Array { return Uint8Array.from(atob(encoded), (char) => char.charCodeAt(0)); }

describe('ZIP32/64の署名省略とCRCが署名に等しい場合（R06/R10）', () => {
  for (const fixture of fixtures.fixtures) {
    it(fixture.name, () => {
      const result = readArchive(decode(fixture.zip), { shouldExtract: () => true });
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error(result.error.reason);
      expect(result.entries.get(fixture.entry)).toEqual(decode(fixture.payload));
    });
  }
});
