import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import type { OpenCascadeInstance, TopoDS_Shape } from 'opencascade.js/dist/opencascade.full.js';
import { readBrepBytes } from './brepBytes.js';
import { legacyOcctFixtures } from './legacyOcctFixtures.js';

export { legacyOcctFixtures };

/** Fixtures retain old native geometry; all actual geometry operations use the current backend. */
export function readLegacyOcctFixture(oc: OpenCascadeInstance, name: keyof typeof legacyOcctFixtures.shapes): TopoDS_Shape {
  const fixture = legacyOcctFixtures.shapes[name];
  const bytes = Buffer.from(fixture.base64, 'base64');
  if (bytes.length !== fixture.bytes || createHash('sha256').update(bytes).digest('hex') !== fixture.sha256) {
    throw new Error(`Corrupt native fixture: ${name}`);
  }
  return readBrepBytes(oc, bytes);
}
