import { describe, expect, it } from 'vitest';
import { expressionValueFromNumber } from '@pointercad/expression';
import {
  createAssemblyDocument, DEFAULT_COMPONENT_PLACEMENT, explodedPlacements, resolveAssembly,
  type AssemblyComponent, type AssemblyDocument, type MateTarget,
} from '@pointercad/model';
import * as commands from './explodeCommands.js';

function component(id: string, suppressed = false): AssemblyComponent {
  return { id, name: id, source: { kind: 'part', partRef: id },
    placement: DEFAULT_COMPONENT_PLACEMENT, fixed: false, visible: true, suppressed };
}
function origin(componentId: string, element: 'x' | 'y' | 'z'): MateTarget {
  return { kind: 'origin', componentId, element };
}
function document(): AssemblyDocument {
  return { ...createAssemblyDocument('motion'), components: [component('a'), component('b'), component('c', true)] };
}
function concentric(a: MateTarget, b: MateTarget, suppressed = false) {
  return { id: 'mate-1', name: 'axis', kind: 'concentric' as const, a, b, flipped: false, suppressed };
}

describe('P7-35 explode commands', () => {
  it('keeps selected components in document order', () => {
    expect(commands.explodeSelection(document(), ['b', 'a'])).toEqual(['a', 'b']);
  });
  it('ignores unknown, duplicate and suppressed component ids', () => {
    expect(commands.explodeSelection(document(), ['gone', 'c', 'a', 'a'])).toEqual(['a']);
  });
  it.each(['x', 'y', 'z'] as const)('infers the %s axis from a concentric mate', (axis) => {
    const base = document();
    const value = { ...base, mates: [concentric(origin('a', axis), origin('b', 'z'))] };
    expect(commands.inferExplodeDirection(value, ['a'])).toEqual({ kind: 'world', axis });
  });
  it('uses the selected second side of a concentric mate', () => {
    const base = document();
    const value = { ...base, mates: [concentric(origin('a', 'x'), origin('b', 'y'))] };
    expect(commands.inferExplodeDirection(value, ['b'])).toEqual({ kind: 'world', axis: 'y' });
  });
  it('falls back to Z when no concentric mate applies', () => {
    expect(commands.inferExplodeDirection(document(), ['a'])).toEqual({ kind: 'world', axis: 'z' });
  });
  it('ignores a suppressed concentric mate', () => {
    const base = document();
    const value = { ...base, mates: [concentric(origin('a', 'x'), origin('b', 'y'), true)] };
    expect(commands.inferExplodeDirection(value, ['a'])).toEqual({ kind: 'world', axis: 'z' });
  });
  it('chooses the dominant saved sub-shape axis deterministically', () => {
    const target: MateTarget = { kind: 'subShape', componentId: 'a', ref: { bodyFeatureId: 'body', index: 0,
      fingerprint: { kind: 'edge', curveKind: 'line', length: 2, position: [0, 0, 0], axis: [0.1, -4, 2], radius: null } } };
    const base = document();
    const value = { ...base, mates: [concentric(target, origin('b', 'z'))] };
    expect(commands.inferExplodeDirection(value, ['a'])).toEqual({ kind: 'world', axis: 'y' });
  });
  it('creates one draft for two selected components', () => {
    const result = commands.createExplodeDraft(document(), ['a', 'b']);
    expect(result.ok && result.draft.componentIds).toEqual(['a', 'b']);
  });
  it('refuses an empty component selection', () => {
    expect(commands.createExplodeDraft(document(), ['mate-1'])).toEqual({ ok: false, reason: 'noSelection' });
  });
  it('preserves the exact distance expression and creates one serial step', () => {
    const base = { ...document(), parameters: [{ name: '厚み', description: '',
      value: expressionValueFromNumber(10), unit: 'mm' as const }] };
    const draft = commands.createExplodeDraft(base, ['a', 'b']);
    if (!draft.ok) throw new Error('draft');
    const result = commands.commitExplodeDraft(base, draft.draft, '厚み*3', '分解 1');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.document.presentation).toHaveLength(1);
    expect(result.document.presentation[0]).toMatchObject({ id: 'step-1', name: '分解 1',
      body: { kind: 'explode', componentIds: ['a', 'b'], distance: { source: '厚み*3', value: 30 } } });
  });
  it('does not mutate the source document', () => {
    const base = document(); const before = structuredClone(base);
    const draft = commands.createExplodeDraft(base, ['a']);
    if (!draft.ok) throw new Error('draft');
    expect(commands.commitExplodeDraft(base, draft.draft, '12', 'step').ok).toBe(true);
    expect(base).toEqual(before);
  });
  it('refuses a stale draft so an edit cannot be lost', () => {
    const base = document(); const draft = commands.createExplodeDraft(base, ['a']);
    if (!draft.ok) throw new Error('draft');
    expect(commands.commitExplodeDraft({ ...base }, draft.draft, '12', 'step'))
      .toEqual({ ok: false, reason: 'staleDocument' });
  });
  it('refuses an invalid expression without adding a step', () => {
    const base = document(); const draft = commands.createExplodeDraft(base, ['a']);
    if (!draft.ok) throw new Error('draft');
    expect(commands.commitExplodeDraft(base, draft.draft, 'missing*3', 'step'))
      .toEqual({ ok: false, reason: 'invalidExpression' });
  });
  it.each([[0, 0], [-1, 1], [0, 2]])('refuses invalid interval %s/%s', (start, end) => {
    const base = document(); const draft = commands.createExplodeDraft(base, ['a']);
    if (!draft.ok) throw new Error('draft');
    expect(commands.commitExplodeDraft(base, draft.draft, '5', 'step', { start, end }))
      .toEqual({ ok: false, reason: 'invalidStep' });
  });
  it('updates the exploded placement of 50 components within the 16ms frame budget', () => {
    const base = { ...document(), components: Array.from({ length: 50 }, (_, index) => component(`c${String(index)}`)) };
    const selected = base.components.map((item) => item.id);
    const draft = commands.createExplodeDraft(base, selected);
    if (!draft.ok) throw new Error('draft');
    const committed = commands.commitExplodeDraft(base, draft.draft, '50', '分解1');
    if (!committed.ok) throw new Error('commit');
    const resolved = resolveAssembly(committed.document);
    const run = () => explodedPlacements(committed.document, resolved, resolved.placements, 0.5);
    for (let warmup = 0; warmup < 3; warmup += 1) run();
    const start = performance.now();
    for (let sample = 0; sample < 20; sample += 1) run();
    expect((performance.now() - start) / 20).toBeLessThanOrEqual(16);
  });
});
