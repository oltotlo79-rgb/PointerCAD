import { beforeAll, describe, expect, it, vi } from 'vitest';

import type { PlacementSpec, ShapeAssemblyNode } from '../types.js';
import type { Allocations, OcctDeletable } from './allocations.js';
import { createAllocations } from './allocations.js';
import { loadOcctForNode } from './loadOcct.node.js';
import { makeBox, type OcctShapeHandle } from './makeBox.js';
import {
  ASSEMBLY_DUPLICATE_DEFINITION_MESSAGE,
  ASSEMBLY_DUPLICATE_NODE_MESSAGE,
  ASSEMBLY_EMPTY_DEFINITION_MESSAGE,
  ASSEMBLY_EMPTY_NODE_MESSAGE,
  ASSEMBLY_MISSING_DEFINITION_MESSAGE,
  ASSEMBLY_NO_SHAPE_MESSAGE,
  writeStepAssembly,
  type XcafAssemblyDefinition,
  type XcafAssemblySpec,
} from './xcafAssembly.js';
import { decodeStepAssemblyOccurrenceName } from './stepAssemblyMetadata.js';

let oc: Awaited<ReturnType<typeof loadOcctForNode>>;

beforeAll(async () => {
  oc = await loadOcctForNode();
});

const IDENTITY: PlacementSpec = { position: [0, 0, 0], rotation: [0, 0, 0, 1] };

function part(id: string, definitionId: string, placement: PlacementSpec = IDENTITY): ShapeAssemblyNode {
  return { kind: 'part', id, name: id, definitionId, placement };
}

function definition(id: string, shape: OcctShapeHandle, name = id): XcafAssemblyDefinition {
  return { id, name, bodies: [{ shape: shape.shape, name, color: null }] };
}

function spec(
  definitions: readonly XcafAssemblyDefinition[],
  children: readonly ShapeAssemblyNode[],
): XcafAssemblySpec {
  return { name: 'Main assembly', definitions, children };
}

function decode(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

function count(text: string, pattern: RegExp): number {
  return text.match(pattern)?.length ?? 0;
}

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
        if (seen.has(item)) throw new Error('duplicate allocation wrapper');
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

describe('XCAF アセンブリ STEP 書き出し(P7 タスク41)', () => {
  it('部品2種・配置3個を、定義2個と参照3個で書く', () => {
    const a = makeBox(oc, { dx: 10, dy: 20, dz: 30 });
    const b = makeBox(oc, { dx: 6, dy: 8, dz: 12 });
    try {
      const text = decode(writeStepAssembly(oc, spec(
        [definition('a', a, 'Part A'), definition('b', b, 'Part B')],
        [part('A1', 'a'), part('A2', 'a', { position: [40, 0, 0], rotation: [0, 0, 0, 1] }), part('B1', 'b')],
      )).bytes);
      expect(text.startsWith('ISO-10303-21;')).toBe(true);
      expect(count(text, /NEXT_ASSEMBLY_USAGE_OCCURRENCE\s*\(/g)).toBe(3);
      expect(count(text, /= PRODUCT\('Part A'/g)).toBe(1);
      expect(count(text, /= PRODUCT\('Part B'/g)).toBe(1);
    } finally {
      b.delete();
      a.delete();
    }
  });

  it('同じ部品50個でもB-repを1回だけ書き、追加参照1個を600バイト以内に収める', () => {
    const box = makeBox(oc, { dx: 20, dy: 20, dz: 20 });
    try {
      const one = writeStepAssembly(oc, spec([definition('box', box)], [part('box-1', 'box')])).bytes;
      const fifty = writeStepAssembly(oc, spec(
        [definition('box', box)],
        Array.from({ length: 50 }, (_, index) => part(`box-${String(index + 1)}`, 'box', {
          position: [index * 25, 0, 0], rotation: [0, 0, 0, 1],
        })),
      )).bytes;
      const text = decode(fifty);
      const bytesPerAdditionalReference = (fifty.byteLength - one.byteLength) / 49;
      expect(count(text, /MANIFOLD_SOLID_BREP/g)).toBe(1);
      expect(count(text, /NEXT_ASSEMBLY_USAGE_OCCURRENCE\s*\(/g)).toBe(50);
      expect(bytesPerAdditionalReference).toBeLessThanOrEqual(600);
      console.log(
        `同一部品STEP: 1個=${one.byteLength}B、50個=${fifty.byteLength}B、` +
          `追加参照=${bytesPerAdditionalReference.toFixed(1)}B/個、全体比=${(
            fifty.byteLength / one.byteLength
          ).toFixed(2)}`,
      );
    } finally {
      box.delete();
    }
  });

  it('日本語のアセンブリ名・定義名・配置名を保つ', () => {
    const box = makeBox(oc, { dx: 4, dy: 5, dz: 6 });
    try {
      const text = decode(writeStepAssembly(oc, {
        name: '主組立', definitions: [definition('body', box, '歯車')],
        children: [{ ...part('gear-1', 'body'), name: '歯車:1' }],
      }).bytes);
      expect(text).toContain('主組立');
      expect(text).toContain('歯車');
      expect(text).toContain('歯車:1');
    } finally {
      box.delete();
    }
  });

  it('入れ子の日本語名と引用符を標準の文字列として書き、参照idを毎回同じ値にする', () => {
    const box = makeBox(oc, { dx: 4, dy: 5, dz: 6 });
    const assembly: ShapeAssemblyNode = {
      kind: 'assembly', id: 'child', name: "子組立 O'Brien", placement: IDENTITY,
      children: [{ ...part('inside', 'body'), name: null }],
    };
    try {
      const first = decode(writeStepAssembly(oc, spec([definition('body', box, '歯車')], [assembly])).bytes);
      const second = decode(writeStepAssembly(oc, spec([definition('body', box, '歯車')], [assembly])).bytes);
      expect(first).toContain("'子組立 O''Brien'");
      expect(first).not.toContain('__POINTERCAD_OCCURRENCE_');
      const ids = (text: string): string[] => [...text.matchAll(
        /NEXT_ASSEMBLY_USAGE_OCCURRENCE\('([^']+)'/g,
      )].map((match) => match[1] ?? '');
      expect(ids(first)).toEqual(ids(second));
      expect(ids(first).map((id) => decodeStepAssemblyOccurrenceName(id)))
        .toEqual([null, "子組立 O'Brien"]);
    } finally {
      box.delete();
    }
  });

  it('入れ子2段を、親参照を含む3本の参照で書く', () => {
    const box = makeBox(oc, { dx: 5, dy: 6, dz: 7 });
    try {
      const nested: ShapeAssemblyNode = {
        kind: 'assembly', id: 'child', name: 'Child', placement: IDENTITY,
        children: [part('inside-1', 'box'), part('inside-2', 'box')],
      };
      const text = decode(writeStepAssembly(oc, spec([definition('box', box)], [nested])).bytes);
      expect(count(text, /NEXT_ASSEMBLY_USAGE_OCCURRENCE\s*\(/g)).toBe(3);
      expect(text).toContain('Child');
    } finally {
      box.delete();
    }
  });

  it('単一定義の色を書き、色なし指定では落とす', () => {
    const box = makeBox(oc, { dx: 5, dy: 6, dz: 7 });
    const colored: XcafAssemblyDefinition = {
      id: 'box', name: 'Box', bodies: [{ shape: box.shape, name: 'Box', color: [0.2, 0.4, 0.6] }],
    };
    try {
      const withColor = writeStepAssembly(oc, spec([colored], [part('one', 'box')]));
      const withoutColor = writeStepAssembly(oc, spec([colored], [part('one', 'box')]), { withColors: false });
      expect(withColor.colorWritten).toBe(true);
      expect(decode(withColor.bytes)).toContain('COLOUR_RGB');
      expect(withoutColor.colorWritten).toBe(false);
      expect(decode(withoutColor.bytes)).not.toContain('COLOUR_RGB');
    } finally {
      box.delete();
    }
  });

  it('複数ボディを1つの共有定義へまとめる', () => {
    const first = makeBox(oc, { dx: 5, dy: 5, dz: 5 });
    const second = makeBox(oc, { dx: 3, dy: 4, dz: 5 });
    try {
      const text = decode(writeStepAssembly(oc, spec([{
        id: 'compound', name: 'Two bodies', bodies: [
          { shape: first.shape, name: 'First', color: null },
          { shape: second.shape, name: 'Second', color: null },
        ],
      }], [part('one', 'compound')])).bytes);
      expect(count(text, /NEXT_ASSEMBLY_USAGE_OCCURRENCE\s*\(/g)).toBe(1);
      expect(count(text, /MANIFOLD_SOLID_BREP/g)).toBe(2);
    } finally {
      second.delete();
      first.delete();
    }
  });

  it('配置が0件なら日本語で断る', () => {
    expect(() => writeStepAssembly(oc, { name: null, definitions: [], children: [] }))
      .toThrow(ASSEMBLY_NO_SHAPE_MESSAGE);
  });

  it('定義idの重複を形へ触れる前に断る', () => {
    const box = makeBox(oc, { dx: 2, dy: 2, dz: 2 });
    try {
      expect(() => writeStepAssembly(oc, spec(
        [definition('same', box), definition('same', box)], [part('one', 'same')],
      ))).toThrow(ASSEMBLY_DUPLICATE_DEFINITION_MESSAGE);
    } finally {
      box.delete();
    }
  });

  it('配置idの重複を断る', () => {
    const box = makeBox(oc, { dx: 2, dy: 2, dz: 2 });
    try {
      expect(() => writeStepAssembly(oc, spec(
        [definition('box', box)], [part('same', 'box'), part('same', 'box')],
      ))).toThrow(ASSEMBLY_DUPLICATE_NODE_MESSAGE);
    } finally {
      box.delete();
    }
  });

  it('存在しない定義への参照を断る', () => {
    expect(() => writeStepAssembly(oc, spec([], [part('one', 'missing')])))
      .toThrow(ASSEMBLY_MISSING_DEFINITION_MESSAGE);
  });

  it('形のない定義と空のサブアセンブリをそれぞれ断る', () => {
    expect(() => writeStepAssembly(oc, spec(
      [{ id: 'empty', name: null, bodies: [] }], [part('one', 'empty')],
    ))).toThrow(ASSEMBLY_EMPTY_DEFINITION_MESSAGE);
    expect(() => writeStepAssembly(oc, spec([], [{
      kind: 'assembly', id: 'empty', name: null, placement: IDENTITY, children: [],
    }]))).toThrow(ASSEMBLY_EMPTY_NODE_MESSAGE);
  });

  it('Writerが失敗してもXCAFの確保を全て返し、次の書き出しが成功する', () => {
    const box = makeBox(oc, { dx: 2, dy: 3, dz: 4 });
    const counter = countingAllocations();
    const writer = vi.spyOn(oc.STEPCAFControl_Writer_1.prototype, 'Perform_2').mockReturnValue(false);
    try {
      try {
        expect(() => writeStepAssembly(oc, spec([definition('box', box)], [part('one', 'box')]), {
          allocations: counter.allocations,
        })).toThrow('STEP ファイルを書き出せませんでした。');
      } finally {
        writer.mockRestore();
      }
      expect(counter.counts.errors).toBe(0);
      expect(counter.counts.deleted).toBe(counter.counts.kept);
      expect(writeStepAssembly(oc, spec([definition('box', box)], [part('next', 'box')])).bytes.length)
        .toBeGreaterThan(1_000);
    } finally {
      box.delete();
    }
  });
});
