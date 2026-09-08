import { beforeAll, describe, expect, it, vi } from 'vitest';

import type { PlacementSpec, ShapeAssemblyNode } from '../types.js';
import { loadOcctForNode } from './loadOcct.node.js';
import { makeBox, type OcctShapeHandle } from './makeBox.js';
import {
  readStepAssembly,
  STEP_ASSEMBLY_COMPONENT_MESSAGE,
  type StepAssemblyReadResult,
} from './readStepAssembly.js';
import { STEP_READ_FAILED_MESSAGE } from './readStep.js';
import { measureVolume } from './solidMesh.js';
import { writeStep } from './writeStep.js';
import { writeStepAssembly, type XcafAssemblyDefinition } from './xcafAssembly.js';

let oc: Awaited<ReturnType<typeof loadOcctForNode>>;

beforeAll(async () => {
  oc = await loadOcctForNode();
});

const IDENTITY: PlacementSpec = { position: [0, 0, 0], rotation: [0, 0, 0, 1] };

function definition(id: string, shape: OcctShapeHandle, name = id): XcafAssemblyDefinition {
  return { id, name, bodies: [{ shape: shape.shape, name, color: null }] };
}

function part(id: string, definitionId: string, placement: PlacementSpec = IDENTITY): ShapeAssemblyNode {
  return { kind: 'part', id, name: id, definitionId, placement };
}

function expectNumbers(actual: readonly number[], expected: readonly number[]): void {
  expect(actual).toHaveLength(expected.length);
  expected.forEach((value, index) => expect(actual[index]).toBeCloseTo(value, 6));
}

function leaf(result: StepAssemblyReadResult, name: string): Extract<ShapeAssemblyNode, { kind: 'part' }> {
  const visit = (nodes: readonly ShapeAssemblyNode[]): Extract<ShapeAssemblyNode, { kind: 'part' }> | null => {
    for (const node of nodes) {
      if (node.kind === 'part' && node.name === name) return node;
      if (node.kind === 'assembly') {
        const found = visit(node.children);
        if (found !== null) return found;
      }
    }
    return null;
  };
  const found = visit(result.children);
  if (found === null) throw new Error(`missing leaf: ${name}`);
  return found;
}

function nestedBytes(a: OcctShapeHandle, b: OcctShapeHandle): Uint8Array {
  const child: ShapeAssemblyNode = {
    kind: 'assembly', id: 'child', name: 'Child',
    placement: {
      position: [0, 50, 0],
      rotation: [Math.sin(Math.PI / 12), 0, 0, Math.cos(Math.PI / 12)],
    },
    children: [part('A3', 'a', {
      position: [7, 11, 13],
      rotation: [0, 0, Math.sin(Math.PI / 4), Math.cos(Math.PI / 4)],
    })],
  };
  return writeStepAssembly(oc, {
    name: 'Root',
    definitions: [definition('a', a, 'Part A'), definition('b', b, 'Part B')],
    children: [
      part('A1', 'a', { position: [3, -7, 11], rotation: [0, 0, 0, 1] }),
      part('A2', 'a', {
        position: [100, 0, 0],
        rotation: [0, 0, Math.sin(Math.PI / 4), Math.cos(Math.PI / 4)],
      }),
      part('B1', 'b', { position: [-30, 4, 9], rotation: [0, 0, 0, 1] }),
      child,
    ],
  }).bytes;
}

describe('XCAF アセンブリ STEP 読み込み(P7 タスク42)', () => {
  it('部品2種・葉4個を共有定義と参照へ戻す', () => {
    const a = makeBox(oc, { dx: 10, dy: 20, dz: 40 });
    const b = makeBox(oc, { dx: 6, dy: 8, dz: 12 });
    const read = readStepAssembly(oc, nestedBytes(a, b));
    try {
      expect(read.name).toBe('Root');
      expect(read.definitions).toHaveLength(2);
      expect(read.children).toHaveLength(4);
      expect([leaf(read, 'A1'), leaf(read, 'A2'), leaf(read, 'A3')]
        .map((node) => node.definitionId)).toEqual([
          leaf(read, 'A1').definitionId,
          leaf(read, 'A1').definitionId,
          leaf(read, 'A1').definitionId,
        ]);
      expect(leaf(read, 'B1').definitionId).not.toBe(leaf(read, 'A1').definitionId);
    } finally {
      read.delete();
      b.delete();
      a.delete();
    }
  });

  it('位置と90度回転を1e-6以内で戻す', () => {
    const a = makeBox(oc, { dx: 10, dy: 20, dz: 40 });
    const b = makeBox(oc, { dx: 6, dy: 8, dz: 12 });
    const read = readStepAssembly(oc, nestedBytes(a, b));
    try {
      expectNumbers(leaf(read, 'A1').placement.position, [3, -7, 11]);
      expectNumbers(leaf(read, 'A2').placement.position, [100, 0, 0]);
      const q = leaf(read, 'A2').placement.rotation;
      expectNumbers(q, [0, 0, Math.SQRT1_2, Math.SQRT1_2]);
    } finally {
      read.delete();
      b.delete();
      a.delete();
    }
  });

  it('各共有定義の体積を1e-6以内で保つ', () => {
    const a = makeBox(oc, { dx: 10, dy: 20, dz: 40 });
    const b = makeBox(oc, { dx: 6, dy: 8, dz: 12 });
    const read = readStepAssembly(oc, nestedBytes(a, b));
    try {
      const volumes = read.definitions.map((item) => measureVolume(oc, item.shape)).sort((x, y) => x - y);
      expect(volumes[0]).toBeCloseTo(6 * 8 * 12, 6);
      expect(volumes[1]).toBeCloseTo(10 * 20 * 40, 6);
    } finally {
      read.delete();
      b.delete();
      a.delete();
    }
  });

  it('入れ子2段とその局所配置を保つ', () => {
    const a = makeBox(oc, { dx: 10, dy: 20, dz: 40 });
    const b = makeBox(oc, { dx: 6, dy: 8, dz: 12 });
    const read = readStepAssembly(oc, nestedBytes(a, b));
    try {
      const child = read.children.find((node) => node.kind === 'assembly');
      expect(child?.kind).toBe('assembly');
      if (child?.kind !== 'assembly') throw new Error('nested assembly missing');
      expect(child.name).toBe('Child');
      expect(child.children).toHaveLength(1);
      expectNumbers(child.placement.position, [0, 50, 0]);
      expectNumbers(child.placement.rotation, [Math.sin(Math.PI / 12), 0, 0, Math.cos(Math.PI / 12)]);
      expectNumbers(leaf(read, 'A3').placement.position, [7, 11, 13]);
    } finally {
      read.delete();
      b.delete();
      a.delete();
    }
  });

  it('入れ子参照の日本語名と引用符をそのまま読み戻す', () => {
    const box = makeBox(oc, { dx: 4, dy: 5, dz: 6 });
    try {
      const bytes = writeStepAssembly(oc, {
        name: '主組立',
        definitions: [definition('box', box, '歯車')],
        children: [{
          kind: 'assembly', id: 'child', name: "子組立 O'Brien", placement: IDENTITY,
          children: [{ ...part('inside', 'box'), name: null }],
        }],
      }).bytes;
      const read = readStepAssembly(oc, bytes);
      try {
        const child = read.children[0];
        expect(child?.kind).toBe('assembly');
        if (child?.kind !== 'assembly') throw new Error('nested assembly missing');
        expect(child.name).toBe("子組立 O'Brien");
        expect(child.children[0]?.name).toBe('歯車');
      } finally {
        read.delete();
      }
    } finally {
      box.delete();
    }
  });

  it('P6の平らなSTEPを恒等配置の1部品として読む', () => {
    const box = makeBox(oc, { dx: 20, dy: 10, dz: 5 });
    try {
      const bytes = writeStep(oc, [{ shape: box.shape, name: 'Flat box', color: null }]).bytes;
      const read = readStepAssembly(oc, bytes);
      try {
        expect(read.definitions).toHaveLength(1);
        expect(read.children).toHaveLength(1);
        expect(read.children[0]?.kind).toBe('part');
        expect(read.children[0]?.name).toBe('Flat box');
        expectNumbers(read.children[0]?.placement.position ?? [], [0, 0, 0]);
        expectNumbers(read.children[0]?.placement.rotation ?? [], [0, 0, 0, 1]);
      } finally {
        read.delete();
      }
    } finally {
      box.delete();
    }
  });

  it('P6の複数自由形も各定義を失わずに読む', () => {
    const first = makeBox(oc, { dx: 2, dy: 3, dz: 4 });
    const second = makeBox(oc, { dx: 5, dy: 6, dz: 7 });
    try {
      const bytes = writeStep(oc, [
        { shape: first.shape, name: 'First', color: null },
        { shape: second.shape, name: 'Second', color: null },
      ]).bytes;
      const read = readStepAssembly(oc, bytes);
      try {
        expect(read.definitions.map((item) => item.name)).toEqual(['First', 'Second']);
        expect(read.children).toHaveLength(2);
      } finally {
        read.delete();
      }
    } finally {
      second.delete();
      first.delete();
    }
  });

  it('名前・色・mm単位を読み戻す', () => {
    const box = makeBox(oc, { dx: 2, dy: 3, dz: 4 });
    try {
      const bytes = writeStepAssembly(oc, {
        name: 'Colored',
        definitions: [{ id: 'box', name: 'Red box', bodies: [{
          shape: box.shape, name: 'Red box', color: [0.8, 0.2, 0.1],
        }] }],
        children: [part('instance', 'box')],
      }).bytes;
      const read = readStepAssembly(oc, bytes);
      try {
        expect(read.unit).toBe('mm');
        expect(read.unitNames[0]?.toLowerCase()).toContain('metre');
        expect(read.definitions[0]?.name).toBe('Red box');
        expectNumbers(read.definitions[0]?.color ?? [], [0.8, 0.2, 0.1]);
      } finally {
        read.delete();
      }
    } finally {
      box.delete();
    }
  });

  it('色を読まない指定なら定義色をnullにする', () => {
    const box = makeBox(oc, { dx: 2, dy: 3, dz: 4 });
    try {
      const bytes = writeStep(oc, [{ shape: box.shape, name: 'Box', color: [0.1, 0.2, 0.3] }]).bytes;
      const read = readStepAssembly(oc, bytes, { withColors: false });
      try {
        expect(read.definitions[0]?.color).toBeNull();
      } finally {
        read.delete();
      }
    } finally {
      box.delete();
    }
  });

  it('壊れたSTEPと0バイトを同じ日本語の理由で断る', () => {
    for (const bytes of [new Uint8Array(), new TextEncoder().encode('ISO-10303-21; BROKEN')]) {
      expect(() => readStepAssembly(oc, bytes)).toThrow(STEP_READ_FAILED_MESSAGE);
    }
  });

  it('GetComponentsの失敗を日本語で断り、次の読み込みは成功する', () => {
    const box = makeBox(oc, { dx: 2, dy: 3, dz: 4 });
    try {
      const bytes = writeStepAssembly(oc, {
        name: 'Root', definitions: [definition('box', box)], children: [part('one', 'box')],
      }).bytes;
      const failed = vi.spyOn(oc.XCAFDoc_ShapeTool, 'GetComponents').mockReturnValue(false);
      try {
        expect(() => readStepAssembly(oc, bytes)).toThrow(STEP_ASSEMBLY_COMPONENT_MESSAGE);
      } finally {
        failed.mockRestore();
      }
      const next = readStepAssembly(oc, bytes);
      try {
        expect(next.children).toHaveLength(1);
      } finally {
        next.delete();
      }
    } finally {
      box.delete();
    }
  });

  it('3回連続で読み、解放後も同じ定義・配置を返す', () => {
    const box = makeBox(oc, { dx: 7, dy: 8, dz: 9 });
    try {
      const bytes = writeStepAssembly(oc, {
        name: 'Repeat', definitions: [definition('box', box)],
        children: [part('one', 'box', { position: [12, 34, 56], rotation: [0, 0, 0, 1] })],
      }).bytes;
      for (let iteration = 0; iteration < 3; iteration += 1) {
        const read = readStepAssembly(oc, bytes);
        try {
          expect(read.definitions).toHaveLength(1);
          expectNumbers(leaf(read, 'one').placement.position, [12, 34, 56]);
        } finally {
          read.delete();
        }
      }
    } finally {
      box.delete();
    }
  });
});
