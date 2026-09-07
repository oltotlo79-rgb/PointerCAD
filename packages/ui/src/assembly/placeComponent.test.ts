import { expressionValueFromNumber } from '@pointercad/expression';
import {
  addComponent,
  createAssemblyDocument,
  createComponentFor,
  DEFAULT_APPEARANCE,
  type Parameter,
} from '@pointercad/model';
import { describe, expect, it } from 'vitest';
import {
  duplicateComponent,
  placePart,
  placementFromSources,
  removeComponents,
} from './placeComponent.js';

describe('placementFromSources', () => {
  it('空欄3つを原点・無回転として確定する', () => {
    const result = placementFromSources(createAssemblyDocument('組立'), ['', '', '']);
    expect(result).toEqual({
      ok: true,
      placement: {
        position: [
          { source: '0', value: 0, display: '0' },
          { source: '0', value: 0, display: '0' },
          { source: '0', value: 0, display: '0' },
        ],
        rotation: [0, 0, 0, 1],
      },
    });
  });

  it('式文字列と評価値を両方残す', () => {
    const result = placementFromSources(createAssemblyDocument('組立'), ['10*2', '3', '-4']);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.placement.position[0]).toMatchObject({ source: '10*2', value: 20 });
    }
  });

  it('アセンブリのパラメータを参照する', () => {
    const parameter: Parameter = {
      name: '幅', value: expressionValueFromNumber(12), unit: 'mm', description: '',
    };
    const assembly = { ...createAssemblyDocument('組立'), parameters: [parameter] };
    const result = placementFromSources(assembly, ['幅*2', '', '']);
    expect(result.ok && result.placement.position[0].value).toBe(24);
  });

  it('不正な欄の理由を返して配置を作らない', () => {
    const result = placementFromSources(createAssemblyDocument('組立'), ['1/', '', '']);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors[0]?.message).not.toBe('');
  });
});

describe('component edits', () => {
  it('1個目だけを固定して置く', () => {
    const assembly = createAssemblyDocument('組立');
    const input = placementFromSources(assembly, ['', '', '']);
    expect(input.ok).toBe(true);
    if (!input.ok) return;
    const first = placePart(assembly, 'part-1', '箱', input.placement);
    const second = placePart(first.document, 'part-1', '箱', input.placement);
    expect(first.component.fixed).toBe(true);
    expect(second.component.fixed).toBe(false);
    expect(second.document.components).toHaveLength(2);
  });

  it('複製しても同じpartRefを参照する', () => {
    const assembly = createAssemblyDocument('組立');
    const first = addComponent(assembly, createComponentFor(assembly, { kind: 'part', partRef: 'part-1' }));
    const result = duplicateComponent(first, first.components[0].id);
    expect(result.document.components).toHaveLength(2);
    expect(result.document.components[1].source).toEqual({ kind: 'part', partRef: 'part-1' });
  });

  it('複製は配置・外観・材質を保つ', () => {
    const assembly = createAssemblyDocument('組立');
    const source = {
      ...createComponentFor(assembly, { kind: 'part', partRef: 'part-1' }),
      appearance: { ...DEFAULT_APPEARANCE, color: '#112233' },
      materialId: 'steel',
    };
    const result = duplicateComponent(addComponent(assembly, source), source.id);
    expect(result.component?.placement).toEqual(source.placement);
    expect(result.component?.appearance).toEqual(source.appearance);
    expect(result.component?.materialId).toBe('steel');
  });

  it('存在しない部品の複製は文書を変えない', () => {
    const assembly = createAssemblyDocument('組立');
    expect(duplicateComponent(assembly, 'missing')).toEqual({ document: assembly, component: null });
  });

  it('複数削除を1つの文書結果へまとめる', () => {
    let assembly = createAssemblyDocument('組立');
    const first = createComponentFor(assembly, { kind: 'part', partRef: 'part-1' });
    assembly = addComponent(assembly, first);
    const second = createComponentFor(assembly, { kind: 'part', partRef: 'part-1' });
    assembly = addComponent(assembly, second);
    expect(removeComponents(assembly, [first.id, second.id]).components).toHaveLength(0);
  });
});
