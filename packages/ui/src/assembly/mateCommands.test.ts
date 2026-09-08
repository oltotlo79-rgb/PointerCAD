import { addComponent, createAssemblyDocument, createComponentFor, type AssemblyDocument } from '@pointercad/model';
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { appendMateTarget, availableMateKinds, commitMate, createMateDraft, editMateDraft,
  assemblyTargetId, parseAssemblyTargetId, mateKindNeedsValue, removeMate, toggleMateFlipped } from './mateCommands.js';

function assembly(): AssemblyDocument {
  let document = createAssemblyDocument('組立');
  document = addComponent(document, createComponentFor(document, { kind: 'part', partRef: 'a' }, { partName: 'A' }));
  document = addComponent(document, createComponentFor(document, { kind: 'part', partRef: 'b' }, { partName: 'B' }));
  return document;
}

const origin = (componentId: string) => ({ kind: 'origin', componentId, element: 'origin' } as const);

describe('合致コマンド', () => {
  it('利用者向け日本語の文字列はcommand/action/popoverに直書きせずリソースへ置く', () => {
    for (const file of ['mateCommands.ts', 'mateActions.ts', 'MatePopover.tsx']) {
      const source = ts.createSourceFile(file, readFileSync(new URL(file, import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true);
      const literals: string[] = [];
      const visit = (node: ts.Node): void => {
        if (ts.isStringLiteralLike(node) && /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/u.test(node.text)) literals.push(node.text);
        ts.forEachChild(node, visit);
      };
      visit(source);
      expect(literals, file).toEqual([]);
    }
  });
  it.each([
    ['point', 'point', ['coincident', 'distance']],
    ['point', 'plane', ['coincident', 'distance']],
    ['plane', 'point', ['coincident', 'distance']],
    ['plane', 'plane', ['coincident', 'parallel', 'distance', 'angle']],
    ['axis', 'axis', ['concentric', 'parallel', 'angle']],
    ['cylinder', 'cylinder', ['concentric', 'parallel', 'angle']],
    ['cylinder', 'plane', ['tangent']],
    ['plane', 'cylinder', ['tangent']],
    ['point', 'axis', []],
    ['axis', 'point', []], ['point', 'cylinder', []], ['cylinder', 'point', []],
    ['plane', 'axis', ['parallel', 'angle']], ['axis', 'plane', ['parallel', 'angle']],
    ['axis', 'cylinder', ['concentric', 'parallel', 'angle']],
    ['cylinder', 'axis', ['concentric', 'parallel', 'angle']],
  ] as const)('%s と %s の実solver対応候補だけを返す', (a, b, expected) => {
    expect(availableMateKinds(a, b)).toEqual(expected);
  });

  it.each([
    ['coincident', false], ['concentric', false], ['parallel', false], ['tangent', false],
    ['distance', true], ['angle', true],
  ] as const)('%s の非平面対象の値要否', (kind, expected) => {
    expect(mateKindNeedsValue(kind)).toBe(expected);
  });

  it.each(['0', '5', '-5', '-10*2'])('面一致のoffset %sを式のまま保存する', (source) => {
    const document = assembly();
    const draft = { ...createMateDraft('doc', 'coincident'), targets: document.components.map((component) => ({ kind: 'origin', componentId: component.id, element: 'xy' } as const)),
      targetKinds: ['plane', 'plane'] as const, source };
    expect(mateKindNeedsValue(draft.kind, draft.targetKinds)).toBe(true);
    const result = commitMate(document, draft);
    expect(result).toMatchObject({ ok: true, mate: { value: { source } } });
  });

  it('角度のEnter既定値は90度で有効', () => {
    const document = assembly();
    const draft = { ...createMateDraft('doc', 'angle'), targets: document.components.map((component) => ({ kind: 'origin', componentId: component.id, element: 'x' } as const)), targetKinds: ['axis', 'axis'] as const };
    expect(commitMate(document, draft)).toMatchObject({ ok: true, mate: { value: { value: 90, source: '90' } } });
  });

  it('消えた編集対象を新規mateとして作らない', () => {
    const document = assembly();
    const draft = { ...createMateDraft('doc', 'coincident'), targets: document.components.map((component) => origin(component.id)), targetKinds: ['point', 'point'] as const, editingMateId: 'missing' };
    expect(commitMate(document, draft)).toMatchObject({ ok: false, reason: 'stale' });
    expect(document.mates).toHaveLength(0);
  });

  it('instance付きIDは区切りを含むcomponentでも往復し不正なURIを拒否する', () => {
    const id = assemblyTargetId(origin('part/a%1'));
    expect(parseAssemblyTargetId(id)).toEqual({ componentId: 'part/a%1', elementId: '@origin' });
    expect(parseAssemblyTargetId('assembly-target:%zz/@x')).toBeNull();
    expect(parseAssemblyTargetId('extrude-1#face:0')).toBeNull();
  });

  it('異なる部品を選択順どおり2つまで保持する', () => {
    const first = appendMateTarget(createMateDraft('doc', 'coincident'), origin('component-1'), 'point');
    expect(first?.targets).toEqual([origin('component-1')]);
    const second = first === null ? null : appendMateTarget(first, origin('component-2'), 'point');
    expect(second?.targets).toEqual([origin('component-1'), origin('component-2')]);
    expect(second === null ? null : appendMateTarget(second, origin('component-1'), 'point')).toBeNull();
  });

  it('同じ部品を2回選べない', () => {
    const first = appendMateTarget(createMateDraft('doc', 'coincident'), origin('component-1'), 'point');
    expect(first === null ? null : appendMateTarget(first, { kind: 'origin', componentId: 'component-1', element: 'x' }, 'axis')).toBeNull();
  });

  it('2対象未満では文書を作らない', () => {
    expect(commitMate(assembly(), createMateDraft('doc', 'coincident'))).toMatchObject({ ok: false, reason: 'targets' });
  });

  it('一致を既定値・採番・選択順で追加する', () => {
    const draft = appendMateTarget(appendMateTarget(createMateDraft('doc', 'coincident'), origin('component-1'), 'point')!, origin('component-2'), 'point')!;
    const result = commitMate(assembly(), draft);
    expect(result).toMatchObject({ ok: true, mate: { id: 'mate-1', kind: 'coincident', a: origin('component-1'), b: origin('component-2'), flipped: false } });
    if (result.ok) expect(result.document.mates).toHaveLength(1);
  });

  it('距離式10*2を20mmと元文字列の両方で保存する', () => {
    const base = createMateDraft('doc', 'distance');
    const draft = appendMateTarget(appendMateTarget({ ...base, source: '10*2' }, origin('component-1'), 'point')!, origin('component-2'), 'point')!;
    const result = commitMate(assembly(), draft);
    expect(result).toMatchObject({ ok: true, mate: { value: { source: '10*2', value: 20 } } });
  });

  it.each(['-1', '1/0', 'notKnown'])('不正な距離 %s は文書を変えず断る', (source) => {
    const base = createMateDraft('doc', 'distance');
    const draft = appendMateTarget(appendMateTarget({ ...base, source }, origin('component-1'), 'point')!, origin('component-2'), 'point')!;
    expect(commitMate(assembly(), draft)).toMatchObject({ ok: false, reason: 'value' });
  });

  it.each(['0', '1', '179', '180'])('不安定な角度 %s 度は断る', (source) => {
    const base = createMateDraft('doc', 'angle');
    const draft = appendMateTarget(appendMateTarget({ ...base, source }, { kind: 'origin', componentId: 'component-1', element: 'x' }, 'axis')!, { kind: 'origin', componentId: 'component-2', element: 'x' }, 'axis')!;
    expect(commitMate(assembly(), draft)).toMatchObject({ ok: false, reason: 'value' });
  });

  it('編集はid・名前・抑制を維持して値だけ置き換える', () => {
    const firstDraft = appendMateTarget(appendMateTarget({ ...createMateDraft('doc', 'distance'), source: '5' }, origin('component-1'), 'point')!, origin('component-2'), 'point')!;
    const first = commitMate(assembly(), firstDraft);
    if (!first.ok) throw new Error('fixture');
    const named = { ...first.document, mates: [{ ...first.mate, name: '離れ', suppressed: true }] };
    const editing = { ...editMateDraft('doc', named.mates[0]), targetKinds: ['point', 'point'] as const, source: '10*2' };
    const changed = commitMate(named, editing);
    expect(changed).toMatchObject({ ok: true, mate: { id: 'mate-1', name: '離れ', suppressed: true, value: { value: 20 } } });
    if (changed.ok) expect(changed.document.mates).toHaveLength(1);
  });

  it('反転と削除は元文書を変えない', () => {
    const draft = appendMateTarget(appendMateTarget(createMateDraft('doc', 'coincident'), origin('component-1'), 'point')!, origin('component-2'), 'point')!;
    const made = commitMate(assembly(), draft);
    if (!made.ok) throw new Error('fixture');
    const flipped = toggleMateFlipped(made.document, made.mate.id);
    expect(flipped.mates[0].flipped).toBe(true);
    expect(made.document.mates[0].flipped).toBe(false);
    expect(removeMate(flipped, made.mate.id).mates).toEqual([]);
  });

  it('存在しないidの反転・削除は同じ参照を返す', () => {
    const document = assembly();
    expect(toggleMateFlipped(document, 'missing')).toBe(document);
    expect(removeMate(document, 'missing')).toBe(document);
  });
});
