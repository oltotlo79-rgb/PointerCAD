import { createHash } from 'node:crypto';
import { stdout } from 'node:process';
import { exactExpressionValueFromNumber } from '@pointercad/expression';
import {
  collectVariables, recomputePart, replaceSketch, WORK_PLANES,
  type ConstraintTarget, type KernelBridge, type PartDocument,
  type ResolvedSketch, type SketchConstraint,
} from '@pointercad/model';
import { strToU8, zipSync } from 'fflate';
import { describe, expect, it, vi } from 'vitest';
import {
  connected1000Original, connected1000PointId,
} from '../../../model/src/sketch/constraints/connected1000Fixture.testSupport.js';
import { parseDocument, serializeDocument } from './documentJson.js';
import { readPcadFile, writePcadFile } from './pcadFile.js';
import { PCAD_SCHEMA_VERSION } from './schema.js';
import { currentConnected1000Part as currentPart, legacyConnected1000Part as legacyPart }
  from './connected1000Persistence.testSupport.js';

const savedAt = '2026-10-26T00:00:00.000Z';
const point = (index: number): ConstraintTarget => ({ kind: 'point', pointId: connected1000PointId(index) });
const expression = (source: string, value: number) => ({ source, value, display: String(value) });

function parsed(text: string): PartDocument {
  const result = parseDocument(text);
  if (!result.ok) throw new Error(result.error.message);
  return result.document;
}
function reopened(document: PartDocument): PartDocument {
  const result = readPcadFile(writePcadFile(document, { savedAt }));
  if (!result.ok) throw new Error(result.error.message);
  return result.document;
}
function reedit(document: PartDocument): PartDocument {
  const sketch = document.sketches[0];
  return replaceSketch(document, { ...sketch, constraints: sketch.constraints?.map(constraint =>
    constraint.id === 'distance-0-1' && constraint.kind === 'distance'
      ? { ...constraint, length: expression('6+4', 10) } : constraint) });
}

async function cold(document: PartDocument) {
  const unexpected = vi.fn((): never => { throw new Error('Unexpected kernel request for point/curve fixture'); });
  const bridge: KernelBridge = { tessellateSketchFaces: unexpected, recomputeSolids: unexpected,
    offsetSketchCurves: unexpected, projectSketchCurves: unexpected, sectionSketchCurves: unexpected,
    measure: unexpected, exportShapes: unexpected, importShape: unexpected, inspectPrintability: unexpected,
    dispose: unexpected };
  const result = await recomputePart(document, bridge, { generation: 1 });
  expect(unexpected).not.toHaveBeenCalled();
  return result;
}

function geometry(resolved: ResolvedSketch) {
  const byId = new Map(resolved.points.map(item => [item.id, item.position]));
  let maxCoordinateError = 0, maxDistanceResidual = 0;
  for (let index = 0; index < 1000; index += 1) {
    const actual = byId.get(connected1000PointId(index));
    if (actual === undefined) throw new Error(`Missing point ${index}`);
    const expected = connected1000Original(index);
    for (let axis = 0; axis < 3; axis += 1) {
      const error = Math.abs(actual[axis] - expected[axis]);
      maxCoordinateError = Math.max(maxCoordinateError, error);
      expect(error).toBeLessThanOrEqual(1e-6);
    }
    for (const anchor of index === 1 ? [0] : index > 1 ? [0, 1] : []) {
      const actualAnchor = byId.get(connected1000PointId(anchor));
      if (actualAnchor === undefined) throw new Error('Missing anchor');
      const expectedAnchor = connected1000Original(anchor);
      const length = Math.hypot(expected[0] - expectedAnchor[0], expected[1] - expectedAnchor[1]);
      const residual = Math.abs(Math.hypot(actual[0] - actualAnchor[0], actual[1] - actualAnchor[1]) - length);
      maxDistanceResidual = Math.max(maxDistanceResidual, residual);
      expect(residual).toBeLessThanOrEqual(1e-9);
    }
  }
  const first = byId.get(connected1000PointId(0)), second = byId.get(connected1000PointId(1));
  if (first === undefined || second === undefined) throw new Error('Missing orientation anchors');
  expect(Math.abs(second[1] - first[1] - 6)).toBeLessThanOrEqual(1e-9);
  return { maxCoordinateError, maxDistanceResidual };
}

// Expected transition table: point counts count authored point features, not
// the derived end/centre points of the six legacy auxiliary curves. JSON/ZIP
// preserve every id, reference and expression. Only migration changes schema;
// only the reedit stage changes the first distance's original expression.
const entrances = [
  { name: 'legacy21', make: legacyPart, initialSchema: 21, count: 2010,
    kinds: ['angle', 'coincident', 'concentric', 'diameter', 'distance', 'equal', 'fix', 'horizontal',
      'parallel', 'perpendicular', 'radius', 'symmetric', 'tangent', 'vertical'] },
  { name: 'current', make: currentPart, initialSchema: PCAD_SCHEMA_VERSION, count: 1998,
    kinds: ['distance', 'verticalDistance'] },
] as const;

describe('1000-point legacy/current persistence transition table', () => {
  for (const entry of entrances) {
    it.each(['save', 'reopen', 'reedit'] as const)(`${entry.name}: %s preserves all stored input and cold geometry`, async stage => {
      expect(PCAD_SCHEMA_VERSION).toBe(22); // Checked against schema.ts and documentJson's actual migration.
      const original = entry.make(), before = JSON.stringify(original);
      expect(original.schemaVersion).toBe(entry.initialSchema);
      const text = serializeDocument(original, { savedAt });
      const envelope: unknown = JSON.parse(text);
      expect(envelope).toMatchObject({ schema: entry.initialSchema, document: { schemaVersion: entry.initialSchema } });
      // Both the JSON entrance and the true .pcad ZIP entrance must migrate identically.
      const json = parsed(text), file = reopened(original);
      expect(file).toEqual(json);
      const edited = stage === 'reedit' ? reedit(file) : file;
      const actual = stage === 'save' ? json : reopened(edited);
      const expected = stage === 'reedit' ? reedit({ ...original, schemaVersion: PCAD_SCHEMA_VERSION })
        : { ...original, schemaVersion: PCAD_SCHEMA_VERSION };
      expect(actual).toEqual(expected);
      expect(parsed(serializeDocument(actual, { savedAt }))).toEqual(expected);
      const sketch = actual.sketches[0], constraints = sketch.constraints ?? [];
      expect(sketch.features.filter(feature => feature.kind === 'point')).toHaveLength(1000);
      expect(new Set(sketch.features.map(feature => feature.id)).size).toBe(sketch.features.length);
      expect(constraints).toHaveLength(entry.count);
      expect(new Set(constraints.map(constraint => constraint.id)).size).toBe(entry.count);
      expect([...new Set(constraints.map(constraint => constraint.kind))].sort()).toEqual(entry.kinds);
      const distance = constraints.find(constraint => constraint.id === 'distance-0-1');
      expect(distance).toMatchObject({ a: point(0), b: point(1),
        length: stage === 'reedit' ? expression('6+4', 10) : exactExpressionValueFromNumber(10) });
      const inputText = serializeDocument(actual, { savedAt });
      const inputSha256 = createHash('sha256').update(inputText).digest('hex');
      const result = await cold(actual);
      expect(serializeDocument(actual, { savedAt })).toBe(inputText);
      expect(result.generation).toBe(1);
      expect(result.cacheHits).toBe(0);
      expect(result.sketches[0].sketchId).toBe(sketch.id);
      expect(result.errors).toEqual([]);
      expect(result.sketches[0].resolved.errors).toEqual([]);
      expect(result.sketches[0].diagnosis?.skipped).toEqual([]);
      expect(collectVariables(sketch, result.sketches[0].resolved, WORK_PLANES.xy).variables)
        .toHaveLength(entry.initialSchema === 21 ? 1998 : 2000);
      const errors = geometry(result.sketches[0].resolved);
      const derivedSha256 = createHash('sha256').update(JSON.stringify(result.sketches[0].resolved.points)).digest('hex');
      stdout.write(`[persist-proof] ${JSON.stringify({ entrance: entry.name, stage, schema: actual.schemaVersion,
        inputSha256, derivedSha256, generation: result.generation, points: 1000, constraints: constraints.length, ...errors })}\n`);
      expect(JSON.stringify(original)).toBe(before);
    });
  }
});

describe('1000-point persistence negative cases keep the actual IO contract', () => {
  it.each(['horizontalDistance', 'verticalDistance', 'midpoint', 'pointOnCurve'] as const)(
    'rejects %s masquerading as schema21 on JSON/ZIP read and write', kind => {
      const document = currentPart(), sketch = document.sketches[0];
      const newConstraint: SketchConstraint = kind === 'midpoint' || kind === 'pointOnCurve'
        ? { id: 'not-legacy', name: kind, kind, a: point(0), b: point(1) }
        : { id: 'not-legacy', name: kind, kind, a: point(0), b: point(1), length: expression('6', 6) };
      const legacy = { ...replaceSketch(document, { ...sketch, constraints: [newConstraint] }), schemaVersion: 21 };
      expect(() => serializeDocument(legacy)).toThrow('schema22');
      expect(() => writePcadFile(legacy)).toThrow('schema22');
      const raw = serializeDocument(replaceSketch(document, { ...sketch, constraints: [newConstraint] }))
        .replace('"schema": 22', '"schema": 21').replace('"schemaVersion": 22', '"schemaVersion": 21');
      expect(parseDocument(raw)).toMatchObject({ ok: false, error: { code: 'notPcad' } });
      expect(readPcadFile(zipSync({ 'document.json': strToU8(raw) }))).toMatchObject({ ok: false });
    });

  it.each(['dangling', 'non-finite'] as const)('%s input survives IO for repair and cannot silently become valid geometry', async problem => {
    const document = currentPart(), sketch = document.sketches[0];
    const broken = replaceSketch(document, { ...sketch, constraints: sketch.constraints?.map((constraint, index) =>
      index !== 0 || constraint.kind !== 'distance' ? constraint : problem === 'dangling'
        ? { ...constraint, a: { kind: 'point', pointId: 'missing-point' } }
        : { ...constraint, length: expression('1/0', Number.NaN) }) });
    const json = parsed(serializeDocument(broken)), file = reopened(broken);
    expect(file).toEqual(json);
    expect(file.sketches[0].constraints?.[0]).toEqual(broken.sketches[0].constraints?.[0]);
    const result = await cold(file);
    expect(result.errors.length).toBeGreaterThan(0);
    if (problem === 'dangling') expect(result.sketches[0].diagnosis?.skipped)
      .toContainEqual(expect.objectContaining({ constraintId: 'distance-0-1', reason: 'dangling' }));
    else {
      // The model keeps this unevaluable expression repairable and reports an
      // uncertified constraint system, rather than inventing a finite length.
      expect(result.errors).toContainEqual(expect.objectContaining({ featureId: file.sketches[0].id, code: 'constraintUnsolved' }));
      expect(result.sketches[0].diagnosis?.rank).toBeNull();
    }
  });
});
