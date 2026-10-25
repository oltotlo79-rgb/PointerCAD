import type { PropertySource } from './analysisModel.js';
import { fields, InputIssue, number, propertySource, text } from './analysisValidation.js';

export interface CadShankShortening {
  readonly boltId: string;
  /** Stress-free shortening in the reference geometry, not a prescribed final tension or torque. */
  readonly shorteningMm: number;
  readonly source: PropertySource;
}
export interface CadJointInitialStrain {
  readonly schema: 'pointercad-cad-joint-initial-strain/1';
  readonly shortenings: readonly CadShankShortening[];
}

/** Geometry-dependent rest-length validation occurs in the current CAD adapter before solving. */
export function readCadJointInitialStrain(value: unknown, boltIds: readonly string[]): CadJointInitialStrain {
  const root = fields(value, ['schema', 'shortenings'], 'initialStrain');
  if (root.schema !== 'pointercad-cad-joint-initial-strain/1') throw new InputIssue('initial-strain-schema', 'initialStrain', 'Unknown initial-strain schema');
  const rows = root.shortenings;
  if (boltIds.length < 1 || boltIds.length > 64 || !Array.isArray(rows) || rows.length !== boltIds.length
    || Reflect.ownKeys(rows).length !== rows.length+1
    || Array.from({ length: rows.length }, (_, i) => Object.hasOwn(rows, i)).some(present => !present)) {
    throw new InputIssue('initial-strain-count', 'initialStrain', 'One explicit shortening per associated shank is required');
  }
  const seen = new Set<string>();
  const shortenings = rows.map((value: unknown, index): CadShankShortening => {
    const path = `initialStrain.shortenings[${index}]`, row = fields(value, ['boltId', 'shorteningMm', 'source'], path);
    const boltId = text(row.boltId, path, 64), shorteningMm = number(row.shorteningMm, path);
    if (seen.has(boltId) || !boltIds.includes(boltId) || shorteningMm < 0) {
      throw new InputIssue('initial-strain-value', path, 'Expected each exact shank identity and a nonnegative shortening');
    }
    seen.add(boltId);
    return { boltId, shorteningMm, source: propertySource(row.source, `${path}.source`) };
  });
  return { schema: root.schema, shortenings };
}
