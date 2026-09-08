import { describe, expect, it } from 'vitest';

import type { SolidBody } from '../../kernelBridge.js';
import type { SubShapeRef } from '../../geometry/subShapeRef.js';
import { createAssemblyDocument, DEFAULT_COMPONENT_PLACEMENT } from '../createAssemblyDocument.js';
import type { AssemblyComponent, AssemblyDocument } from '../types.js';
import {
  changeStandardSize, createStandardPartSource, standardPartNominalVolume,
} from './buildStandardPart.js';

function component(source: AssemblyComponent['source']): AssemblyComponent {
  return {
    id: 'component-1', name: 'ボルト:1', source, placement: DEFAULT_COMPONENT_PLACEMENT,
    fixed: true, visible: true, suppressed: false,
  };
}

function assembly(source: AssemblyComponent['source']): AssemblyDocument {
  return { ...createAssemblyDocument('組立'), components: [component(source)] };
}

const REF: SubShapeRef = {
  bodyFeatureId: 'solid-1', index: 0,
  fingerprint: {
    kind: 'face', surfaceKind: 'plane', area: 100, position: [0, 0, 0], axis: [0, 0, 1], radius: null,
  },
};

function body(withFace = true): SolidBody {
  return {
    featureId: 'solid-1', volume: 1, isValid: true,
    mesh: {
      positions: new Float32Array([0, 0, 0]), normals: new Float32Array(3),
      indices: new Uint32Array(), edgePositions: new Float32Array(), triangleCount: 1,
    },
    faces: withFace ? [{
      index: 2, surfaceKind: 'plane', area: 100, centroid: [0, 0, 0], axis: [0, 0, 1],
      radius: null, triangleOffset: 0, triangleCount: 1,
    }] : [],
    edges: [], vertices: [], threadMarks: [],
  };
}

describe('changeStandardSize', () => {
  it('M8からM10へ変えると呼び寸法と体積が変わる', () => {
    const source = createStandardPartSource('hexBolt', 'M8', { length: '30' });
    const plan = changeStandardSize(assembly(source), 'component-1', 'M10', { bodies: [body()] });
    expect(plan?.nextSource).toMatchObject({ kind: 'standardPart', size: 'M10' });
    expect(standardPartNominalVolume('hexBolt', 'M10', source.options)).not.toBe(
      standardPartNominalVolume('hexBolt', 'M8', source.options),
    );
  });

  it('長さ・寸法系列・ねじ系列を保つ', () => {
    const source = createStandardPartSource('hexBolt', 'M8', {
      length: '45', dimensionSeries: 'main', threadSeries: 'fine',
    });
    expect(changeStandardSize(assembly(source), 'component-1', 'M10', { bodies: [body()] })?.nextSource)
      .toMatchObject({ options: source.options });
  });

  it('寸法表と生成台本の版を保つ', () => {
    const source = createStandardPartSource('hexBolt', 'M8');
    expect(changeStandardSize(assembly(source), 'component-1', 'M10', { bodies: [body()] })?.nextSource)
      .toMatchObject({ catalogRevision: source.catalogRevision, generatorRevision: source.generatorRevision });
  });

  it('表に無い呼び寸法なら差し替えない', () => {
    const source = createStandardPartSource('hexBolt', 'M8');
    expect(changeStandardSize(assembly(source), 'component-1', 'M999', { bodies: [body()] })).toBeNull();
  });

  it('通常部品には使わない', () => {
    expect(changeStandardSize(assembly({ kind: 'part', partRef: 'part-1' }), 'component-1', 'M10', { bodies: [body()] })).toBeNull();
  });

  it('対象のidが無ければ差し替えない', () => {
    const source = createStandardPartSource('hexBolt', 'M8');
    expect(changeStandardSize(assembly(source), 'component-9', 'M10', { bodies: [body()] })).toBeNull();
  });

  it('面合致を通常の置換経路で選び直す', () => {
    const source = createStandardPartSource('hexBolt', 'M8');
    const before: AssemblyDocument = {
      ...assembly(source),
      components: [component(source), { ...component({ kind: 'part', partRef: 'part-1' }), id: 'component-2' }],
      mates: [{
        id: 'mate-1', name: '座面', kind: 'coincident',
        a: { kind: 'subShape', componentId: 'component-1', ref: REF },
        b: { kind: 'origin', componentId: 'component-2', element: 'xy' },
        flipped: false, suppressed: false,
      }],
    };
    const plan = changeStandardSize(before, 'component-1', 'M10', { bodies: [body()] });
    expect(plan?.matchedCount).toBe(1);
    expect(plan?.after.mates[0].a).toMatchObject({ ref: { index: 2 } });
  });

  it('選び直せない合致を消さずに残す', () => {
    const source = createStandardPartSource('hexBolt', 'M8');
    const before: AssemblyDocument = {
      ...assembly(source),
      components: [component(source), { ...component({ kind: 'part', partRef: 'part-1' }), id: 'component-2' }],
      mates: [{
        id: 'mate-1', name: '座面', kind: 'coincident',
        a: { kind: 'subShape', componentId: 'component-1', ref: REF },
        b: { kind: 'origin', componentId: 'component-2', element: 'xy' },
        flipped: false, suppressed: false,
      }],
    };
    const plan = changeStandardSize(before, 'component-1', 'M10', { bodies: [body(false)] });
    expect(plan?.unresolvedIds).toEqual(['mate-1']);
    expect(plan?.after.mates).toHaveLength(1);
    expect(before.components[0].source).toBe(source);
  });
});
