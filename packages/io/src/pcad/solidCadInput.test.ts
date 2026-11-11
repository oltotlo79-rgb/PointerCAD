import { createEmptyPartDocument } from '@pointercad/model';
import { readSolidCadSavedInput, withBeamAnalysisInputs } from '@pointercad/model/beam-analysis';
import { describe, expect, it } from 'vitest';
import { parseDocument, serializeDocument } from './documentJson.js';
import { serializeBeamAnalysisInputs } from './codecs/beamAnalysis.js';

const writeOptions = { savedAt: '2026-10-14T00:00:00.000Z' };
describe('solid CAD definition document codec', () => {
  it('roundtrips the version and persistent origin keys without results or meshes, including a second save', () => {
    const part = createEmptyPartDocument();
    const definition = readSolidCadSavedInput({ schema: 'pointercad-solid-cad-input/1', id: 'solid-cad',
      source: { documentId: part.id }, bodyFeatureId: 'body', fixedFaces: ['fixed'], loadedFaces: ['loaded'],
      youngMPa: 210000, poisson: 0.3, tractionMPa: [0, -2, 0], linearDeflectionMm: 0.1,
      angularDeflectionRad: 0.3, maximumChordDeviationMm: 0.2, maximumVolumeDeviationMm3: 2 });
    const edited = withBeamAnalysisInputs(part, { schema: 'pointercad-beam-inputs/1', analyses: [{ kind: 'solid-cad', definition }] });
    const text = serializeDocument(edited, writeOptions), opened = parseDocument(text);
    expect(opened.ok).toBe(true);
    if (!opened.ok) throw new Error('Definition roundtrip failed');
    expect(opened.document.beamAnalysisInputs).toEqual(edited.beamAnalysisInputs);
    const second = parseDocument(serializeDocument(opened.document, writeOptions));
    expect(second.ok && second.document.beamAnalysisInputs).toEqual(edited.beamAnalysisInputs);
    expect(JSON.stringify(opened.document.beamAnalysisInputs)).not.toMatch(/"(?:result|mesh|nodes|stressMPa|reactionN)"/u);
    const attachment = edited.beamAnalysisInputs;
    if (!attachment) throw new Error('Missing saved attachment');
    expect(() => serializeBeamAnalysisInputs(attachment, part.id, 'assembly')).toThrow();
    expect(parseDocument(text.replace('pointercad-solid-cad-input/1', 'pointercad-solid-cad-input/2')).ok).toBe(false);
    expect(parseDocument(text.replace(/"youngMPa"\s*:\s*210000/u, '"youngMPa":0')).ok).toBe(false);
    expect(() => withBeamAnalysisInputs({ ...part, id: 'another-document' }, edited.beamAnalysisInputs)).toThrow(/wrong-document/u);
  });
  it('roundtrips a signed pressure definition and refuses a file that mixes it with a traction vector', () => {
    const part = createEmptyPartDocument();
    const definition = readSolidCadSavedInput({ schema: 'pointercad-solid-cad-input/2', id: 'solid-cad',
      source: { documentId: part.id }, bodyFeatureId: 'body', fixedFaces: ['fixed'], loadedFaces: ['loaded'],
      youngMPa: 210000, poisson: 0.3, load: 'pressure', pressureMPa: -1.25, linearDeflectionMm: 0.1,
      angularDeflectionRad: 0.3, maximumChordDeviationMm: 0.2, maximumVolumeDeviationMm3: 2 });
    const edited = withBeamAnalysisInputs(part, { schema: 'pointercad-beam-inputs/1', analyses: [{ kind: 'solid-cad', definition }] });
    const text = serializeDocument(edited, writeOptions), opened = parseDocument(text);
    expect(opened.ok).toBe(true);
    if (!opened.ok) throw new Error('Pressure roundtrip failed');
    expect(opened.document.beamAnalysisInputs).toEqual(edited.beamAnalysisInputs);
    expect(opened.document.beamAnalysisInputs?.analyses[0]).toMatchObject({ definition: { load: 'pressure', pressureMPa: -1.25 } });
    expect(serializeDocument(opened.document, writeOptions)).toBe(text);
    expect(text).not.toContain('tractionMPa');
    expect(parseDocument(text.replace(/"pressureMPa"\s*:\s*-1\.25/u, '"pressureMPa":-1.25,"tractionMPa":[0,0,1]')).ok).toBe(false);
    expect(parseDocument(text.replace(/"load"\s*:\s*"pressure"/u, '"load":"suction"')).ok).toBe(false);
    expect(parseDocument(text.replace(/"pressureMPa"\s*:\s*-1\.25/u, '"pressureMPa":"-1.25"')).ok).toBe(false);
    expect(parseDocument(text.replace('pointercad-solid-cad-input/2', 'pointercad-solid-cad-input/1')).ok).toBe(false);
  });
  it('retains legacy documents with no solid definition', () => {
    const part = createEmptyPartDocument(), opened = parseDocument(serializeDocument(part, writeOptions));
    expect(opened.ok).toBe(true);
    if (!opened.ok) throw new Error('Legacy roundtrip failed');
    expect(opened.document.beamAnalysisInputs).toBeUndefined();
  });
  it.each(['traction', 'pressure'] as const)('roundtrips per-face supports and gravity in a %s file without generated results', load => {
    const part = createEmptyPartDocument();
    const common = { id: 'solid-cad', source: { documentId: part.id }, bodyFeatureId: 'body', fixedFaces: [], loadedFaces: [],
      youngMPa: 210000, poisson: 0.3, supports: [
        { face: 'left-origin', fixed: [true, false, false], prescribedMm: [0.125, 0, 0] },
        { face: 'front-origin', fixed: [false, true, false], prescribedMm: [0, -0.25, 0] },
        { face: 'bottom-origin', fixed: [false, false, true], prescribedMm: [0, 0, 0.5] },
      ], gravity: { accelerationMps2: [1.25, -9.81, 2.5], densityKgM3: 7800 },
      linearDeflectionMm: 0.1, angularDeflectionRad: 0.3, maximumChordDeviationMm: 0.2, maximumVolumeDeviationMm3: 2 };
    const definition = readSolidCadSavedInput(load === 'traction'
      ? { schema: 'pointercad-solid-cad-input/1', ...common, tractionMPa: [0, 0, 0] }
      : { schema: 'pointercad-solid-cad-input/2', ...common, load, pressureMPa: 0 });
    const edited = withBeamAnalysisInputs(part, { schema: 'pointercad-beam-inputs/1', analyses: [{ kind: 'solid-cad', definition }] });
    const text = serializeDocument(edited, writeOptions), opened = parseDocument(text);
    if (!opened.ok) throw new Error('Support/gravity roundtrip failed');
    expect(opened.document.beamAnalysisInputs).toEqual(edited.beamAnalysisInputs);
    expect(serializeDocument(opened.document, writeOptions)).toBe(text);
    expect(JSON.stringify(opened.document.beamAnalysisInputs)).not.toMatch(/"(?:result|mesh|nodes|stressMPa|reactionN)"/u);
    expect(parseDocument(text.replace(/"densityKgM3"\s*:\s*7800/u, '"densityKgM3":0')).ok).toBe(false);
    expect(parseDocument(text.replace(/"face"\s*:\s*"front-origin"/u, '"face":"left-origin"')).ok).toBe(false);
    expect(parseDocument(text.replace(/"densityKgM3"\s*:\s*7800/u, '"densityKgM3":7800,"inferred":true')).ok).toBe(false);
  });
});
