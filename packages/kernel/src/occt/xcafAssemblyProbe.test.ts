import { beforeAll, describe, expect, it, vi } from 'vitest';

import type { Allocations, OcctDeletable } from './allocations.js';
import { createAllocations } from './allocations.js';
import { loadOcctForNode } from './loadOcct.node.js';
import type { AssemblyProbeReadResult, ProbeOccurrence } from './xcafAssemblyProbe.js';
import { readAssemblyProbe, writeAssemblyProbe } from './xcafAssemblyProbe.js';

let oc: Awaited<ReturnType<typeof loadOcctForNode>>;

beforeAll(async () => {
  oc = await loadOcctForNode();
});

function countingAllocations(): {
  readonly allocations: Allocations;
  readonly counts: { kept: number; deleted: number; errors: number };
} {
  const inner = createAllocations();
  const seen = new Set<OcctDeletable>();
  const counts = { kept: 0, deleted: 0, errors: 0 };
  return {
    counts,
    allocations: {
      keep<T extends OcctDeletable>(item: T): T {
        if (seen.has(item)) {
          throw new Error('The same OCCT wrapper was registered twice');
        }
        seen.add(item);
        counts.kept += 1;
        const original = item.delete.bind(item);
        item.delete = (): void => {
          try {
            original();
            counts.deleted += 1;
          } catch (error) {
            counts.errors += 1;
            throw error;
          }
        };
        return inner.keep(item);
      },
      release: () => inner.release(),
    },
  };
}

function assertReleased(counter: ReturnType<typeof countingAllocations>): void {
  expect(counter.counts.errors).toBe(0);
  expect(counter.counts.deleted).toBe(counter.counts.kept);
  counter.allocations.release();
  expect(counter.counts.deleted).toBe(counter.counts.kept);
}

function occurrence(result: AssemblyProbeReadResult, name: string): ProbeOccurrence {
  const found = result.occurrences.find((item) => item.name === name);
  if (found === undefined) {
    throw new Error(`Missing occurrence: ${name}`);
  }
  return found;
}

function expectCoordinates(actual: readonly number[], expected: readonly number[]): number {
  expect(actual).toHaveLength(expected.length);
  let maximumError = 0;
  for (let index = 0; index < expected.length; index += 1) {
    const error = Math.abs(actual[index] - expected[index]);
    expect(error).toBeLessThanOrEqual(1e-6);
    maximumError = Math.max(maximumError, error);
  }
  return maximumError;
}

describe('XCAF assembly API の先行実証 (P7 タスク51)', () => {
  it('A 1 個を definition と occurrence に分けて STEP へ書ける', () => {
    const text = writeAssemblyProbe(oc, 'single');
    expect(text.startsWith('ISO-10303-21;')).toBe(true);
    expect(text.match(/NEXT_ASSEMBLY_USAGE_OCCURRENCE\s*\(/g)).toHaveLength(1);
    expect(text).toContain('Part A');
    expect(text).toContain('A1');
  });

  it('4 個の葉と子 assembly を 5 本の使用参照で書ける', () => {
    const text = writeAssemblyProbe(oc, 'nested');
    expect(text.match(/NEXT_ASSEMBLY_USAGE_OCCURRENCE\s*\(/g)).toHaveLength(5);
    expect(text.match(/= PRODUCT\('Part A'/g)).toHaveLength(1);
    expect(text.match(/= PRODUCT\('Part B'/g)).toHaveLength(1);
    expect(text).toContain('SI_UNIT(.MILLI.,.METRE.)');
    expect(text).toContain('NAMED_UNIT(*) PLANE_ANGLE_UNIT() SI_UNIT($,.RADIAN.)');
  });

  it('葉4個・部品定義2個・子assembly1個を別々に読み戻せる', () => {
    const result = readAssemblyProbe(oc, writeAssemblyProbe(oc, 'nested'));
    expect(result.roots).toEqual(['Root']);
    expect(result.occurrences.filter((item) => !item.assembly)).toHaveLength(4);
    expect(result.occurrences.filter((item) => item.assembly)).toHaveLength(1);
    expect(result.definitions).toHaveLength(2);
    const a = result.definitions.find((item) => item.name === 'Part A');
    const b = result.definitions.find((item) => item.name === 'Part B');
    expect(a).toBeDefined();
    expect(b).toBeDefined();
    expect(result.occurrences.filter((item) => item.definition === a?.id)).toHaveLength(3);
    expect(result.occurrences.filter((item) => item.definition === b?.id)).toHaveLength(1);
  });

  it('definition と occurrence の名前を両方保ち、子の下に A3 が1個ある', () => {
    const result = readAssemblyProbe(oc, writeAssemblyProbe(oc, 'nested'));
    expect(result.definitions.map((item) => item.name).sort()).toEqual(['Part A', 'Part B']);
    expect(result.occurrences.map((item) => item.name).sort()).toEqual(['A1', 'A2', 'A3', 'B1', 'Child1']);
    const child = occurrence(result, 'Child1');
    expect(child.assembly).toBe(true);
    expect(child.definitionName).toBe('Child definition');
    expect(child.parent).toBeNull();
    expect(result.occurrences.filter((item) => item.parent === child.id).map((item) => item.name))
      .toEqual(['A3']);
    expect(result.occurrences.filter((item) => item.parent === null)).toHaveLength(4);
    for (const name of ['A1', 'A2', 'A3']) {
      expect(occurrence(result, name).definitionName).toBe('Part A');
    }
    expect(occurrence(result, 'B1').definitionName).toBe('Part B');
  });

  it('4個の世界境界箱と重心が独立計算した配置に1e-6 mm以内で一致する', () => {
    const result = readAssemblyProbe(oc, writeAssemblyProbe(oc, 'nested'));
    const c = Math.cos(Math.PI / 6);
    const s = Math.sin(Math.PI / 6);
    // A3: 箱をRz(π/2)して(7,11,13)を足し、Rx(π/6)して(0,50,0)を足す。
    // OCCT の配置関数を期待値の計算に使わない。
    const expected = [
      { name: 'A1', min: [3, -7, 11], max: [13, 13, 51], center: [8, 3, 31] },
      { name: 'A2', min: [80, 0, 0], max: [100, 10, 40], center: [90, 5, 20] },
      { name: 'B1', min: [-30, 4, 9], max: [-24, 12, 21], center: [-27, 8, 15] },
      {
        name: 'A3',
        min: [-13, 50 + 11 * c - 53 * s, 11 * s + 13 * c],
        max: [7, 50 + 21 * c - 13 * s, 21 * s + 53 * c],
        center: [-3, 50 + 16 * c - 33 * s, 16 * s + 33 * c],
      },
    ];
    let maximumError = 0;
    for (const entry of expected) {
      const measured = occurrence(result, entry.name).measurement;
      if (measured === null) {
        throw new Error(`Missing shape measurement: ${entry.name}`);
      }
      for (const field of ['min', 'max', 'center'] as const) {
        maximumError = Math.max(maximumError, expectCoordinates(measured[field], entry[field]));
      }
    }
    console.log('[assembly probe] max world bounds/center error mm:', maximumError);
  });

  it('子と親の回転・移動を1回ずつ合成し、各部品の体積と合計24576 mm³を保つ', () => {
    const result = readAssemblyProbe(oc, writeAssemblyProbe(oc, 'nested'));
    const c = Math.cos(Math.PI / 6);
    const s = Math.sin(Math.PI / 6);
    const a3 = occurrence(result, 'A3');
    expectCoordinates(a3.location, [0, -1, 0, 7, 1, 0, 0, 11, 0, 0, 1, 13]);
    expectCoordinates(a3.worldLocation, [0, -1, 0, 7, c, 0, -s, 50 + 11 * c - 13 * s, s, 0, c, 11 * s + 13 * c]);
    let volume = 0;
    for (const item of result.occurrences.filter((item) => !item.assembly)) {
      if (item.measurement === null) {
        throw new Error('Missing leaf measurement');
      }
      const expected = item.name === 'B1' ? 6 * 8 * 12 : 10 * 20 * 40;
      expect(Math.abs(item.measurement.volume - expected)).toBeLessThanOrEqual(1e-6);
      volume += item.measurement.volume;
    }
    expect(Math.abs(volume - (3 * 10 * 20 * 40 + 6 * 8 * 12))).toBeLessThanOrEqual(1e-6);
    console.log('[assembly probe] total volume mm3:', volume);
  });

  it('成功→空入力→壊れたテキスト→無関係な箱を3回連続で扱って全て解放する', () => {
    for (let iteration = 0; iteration < 3; iteration += 1) {
      const written = countingAllocations();
      const text = writeAssemblyProbe(oc, 'nested', written.allocations);
      assertReleased(written);
      const read = countingAllocations();
      expect(readAssemblyProbe(oc, text, read.allocations).occurrences).toHaveLength(5);
      assertReleased(read);
      const rejected = [];
      for (const input of ['', 'ISO-10303-21;\nHEADER;\nBROKEN_STEP_TEXT']) {
        const failed = countingAllocations();
        expect(() => readAssemblyProbe(oc, input, failed.allocations))
          .toThrow('Assembly probe: STEPCAFControl_Reader.Perform_2 returned false');
        assertReleased(failed);
        rejected.push(failed.counts);
      }
      const next = countingAllocations();
      const maker = next.allocations.keep(new oc.BRepPrimAPI_MakeBox_2(17 + iteration, 9, 13));
      const shape = next.allocations.keep(maker.Shape());
      const props = next.allocations.keep(new oc.GProp_GProps_1());
      try {
        oc.BRepGProp.VolumeProperties_1(shape, props, true, false, false);
        expect(Math.abs(props.Mass() - (17 + iteration) * 9 * 13)).toBeLessThanOrEqual(1e-6);
      } finally {
        next.allocations.release();
      }
      assertReleased(next);
      console.log('[assembly probe] ownership iteration', iteration + 1,
        JSON.stringify({ written: written.counts, read: read.counts, rejected, next: next.counts }));
    }
  });

  it('空rootをassemblyとして読めないことを明示して断り、3回とも解放と次の往復が成功する', () => {
    for (let iteration = 0; iteration < 3; iteration += 1) {
      const counter = countingAllocations();
      const text = writeAssemblyProbe(oc, 'empty', counter.allocations);
      assertReleased(counter);
      expect(text.match(/NEXT_ASSEMBLY_USAGE_OCCURRENCE\s*\(/g) ?? []).toHaveLength(0);
      expect(text).toContain("PRODUCT('Root','Root'");
      const read = countingAllocations();
      expect(() => readAssemblyProbe(oc, text, read.allocations))
        .toThrow('Assembly probe: root is not an assembly');
      assertReleased(read);
      const nextWrite = countingAllocations();
      const nextText = writeAssemblyProbe(oc, 'single', nextWrite.allocations);
      assertReleased(nextWrite);
      const nextRead = countingAllocations();
      const next = readAssemblyProbe(oc, nextText, nextRead.allocations);
      assertReleased(nextRead);
      expect(next.definitions).toHaveLength(1);
      expect(next.occurrences).toHaveLength(1);
      expectCoordinates(occurrence(next, 'A1').measurement?.center ?? [], [8, 3, 31]);
      console.log('[assembly probe] empty root iteration', iteration + 1,
        JSON.stringify({ written: counter.counts, read: read.counts,
          nextWrite: nextWrite.counts, nextRead: nextRead.counts }));
    }
  });

  it('AddComponent の途中失敗後でも全て解放し、次の書き読みを3回とも成功させる', () => {
    for (let iteration = 0; iteration < 3; iteration += 1) {
      const failed = countingAllocations();
      const spy = vi.spyOn(oc.XCAFDoc_ShapeTool.prototype, 'AddComponent_1')
        .mockImplementation(() => { throw new Error('probe injected AddComponent failure'); });
      try {
        expect(() => writeAssemblyProbe(oc, 'nested', failed.allocations))
          .toThrow('probe injected AddComponent failure');
      } finally {
        spy.mockRestore();
      }
      assertReleased(failed);
      const next = readAssemblyProbe(oc, writeAssemblyProbe(oc, 'single'));
      expect(next.definitions).toHaveLength(1);
      expect(next.occurrences).toHaveLength(1);
      expectCoordinates(occurrence(next, 'A1').measurement?.center ?? [], [8, 3, 31]);
      console.log('[assembly probe] build failure ownership', iteration + 1, JSON.stringify(failed.counts));
    }
  });

  it('Writer.Perform_2 のfalse後でも全て解放し、次の書き読みを3回とも成功させる', () => {
    for (let iteration = 0; iteration < 3; iteration += 1) {
      const failed = countingAllocations();
      const spy = vi.spyOn(oc.STEPCAFControl_Writer_1.prototype, 'Perform_2').mockReturnValue(false);
      try {
        expect(() => writeAssemblyProbe(oc, 'nested', failed.allocations))
          .toThrow('Assembly probe: STEPCAFControl_Writer.Perform_2 returned false');
      } finally {
        spy.mockRestore();
      }
      assertReleased(failed);
      const next = readAssemblyProbe(oc, writeAssemblyProbe(oc, 'single'));
      expect(next.definitions).toHaveLength(1);
      expect(next.occurrences).toHaveLength(1);
      expectCoordinates(occurrence(next, 'A1').measurement?.center ?? [], [8, 3, 31]);
      console.log('[assembly probe] transfer failure ownership', iteration + 1, JSON.stringify(failed.counts));
    }
  });
});
