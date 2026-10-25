import { absoluteCoordinate, createEmptyPartDocument, createEmptySketchDocument, createPointFeature,
  type Parameter, type PartDocument, type SolidFeature } from '@pointercad/model';
import { describe, expect, it } from 'vitest';

import { filterParameterRows, parameterUsageSites, ParameterRowIdentity,
  type ParameterUsageSite } from './parameterSearch.js';
import type { ParameterRow } from './parameterCommands.js';

const value = (source: string) => ({ source, value: 0, display: '0' });
const parameter = (name: string, source = '1'): Parameter =>
  ({ name, value: value(source), unit: 'mm', description: '' });

describe('parameter search', () => {
  it('100 rows: name and description matches form a union, then status filter intersects it', () => {
    const rows: ParameterRow[] = Array.from({ length: 100 }, (_, i) => ({
      name: `係数${i}${i < 7 ? 'A' : ''}`,
      source: '1', value: 1, unit: 'mm',
      description: i >= 4 && i < 15 ? 'A の説明' : '通常',
      unused: i % 2 === 0, circular: i === 4 || i === 14, failureMessage: null,
    }));
    const usages = new Map<string, ParameterUsageSite[]>();
    rows.forEach((row, i) => usages.set(row.name, i < 10 ? [{
      kind: 'solid', ownerId: `owner-${i}`, ownerName: `Owner ${i}`,
    }] : []));
    expect(filterParameterRows(rows, 'a', 'all', usages).map(row => row.name)).toEqual(rows.slice(0, 15).map(row => row.name));
    expect(filterParameterRows(rows, 'a', 'unused', usages).map(row => row.name)).toEqual(
      rows.slice(0, 15).filter(row => row.unused).map(row => row.name));
    expect(filterParameterRows(rows, 'a', 'circular', usages).map(row => row.name)).toEqual([rows[4]?.name, rows[14]?.name]);
    expect(filterParameterRows(rows, 'a', 'referenced', usages).map(row => row.name)).toEqual(rows.slice(0, 10).map(row => row.name));
    expect(filterParameterRows(rows, 'missing', 'all', usages)).toEqual([]);
  });

  it('keeps distinct owner IDs despite equal labels and groups multiple fields of one owner', () => {
    const first: SolidFeature = {
      id: 'solid-a', name: '押し出し', kind: 'extrude', suppressed: false,
      profile: { sketchId: 'sketch-1', faceFeatureId: 'face-1' },
      distance: value('板厚'), reversed: false, symmetric: false,
    };
    const second: SolidFeature = { ...first, id: 'solid-b' };
    const document: PartDocument = { ...createEmptyPartDocument(),
      parameters: [parameter('板厚'), parameter('倍', '板厚*2'), parameter('自己', '自己+1')],
      solids: [first, second],
    };
    const sites = parameterUsageSites(document);
    expect(sites.get('板厚')?.map(site => site.ownerId)).toEqual(['倍', 'solid-a', 'solid-b']);
    expect(sites.get('自己')).toEqual([]);
  });

  it('keeps a row token across rename, Undo and configuration snapshots, then resets for another document', () => {
    const identity = new ParameterRowIdentity();
    const original: PartDocument = { ...createEmptyPartDocument(), parameters: [parameter('板厚')] };
    const initial = identity.token(original, '板厚');
    identity.beginRename(original, '板厚', '厚さ');
    const renamed: PartDocument = { ...original, parameters: [parameter('厚さ')] };
    expect(identity.token(renamed, '厚さ')).toBe(initial);
    expect(identity.token(original, '板厚')).toBe(initial);
    const configuration: PartDocument = { ...original, activeConfigurationId: 'another' };
    expect(identity.token(configuration, '板厚')).toBe(initial);
    const unrelated: PartDocument = { ...createEmptyPartDocument(), id: `${original.id}-other`,
      parameters: [parameter('板厚')] };
    expect(identity.token(unrelated, '板厚')).not.toBe(initial);
  });

  it('distinguishes equal point IDs and labels in two sketches by sketch scope', () => {
    const base = createEmptyPartDocument();
    const first = base.sketches[0];
    if (first === undefined) throw new Error('Expected the default sketch');
    const second = { ...createEmptySketchDocument(), id: 'sketch-2', name: first.name };
    const at = { ...absoluteCoordinate(0, 0, 0), x: value('板厚') };
    const a = createPointFeature(first, { ...at, y: value('板厚') });
    const b = createPointFeature(second, at);
    expect(a.id).toBe(b.id);
    const document: PartDocument = { ...base, parameters: [parameter('板厚')], sketches: [
      { ...first, features: [a] }, { ...second, features: [b] },
    ] };
    const sites = parameterUsageSites(document).get('板厚')?.filter(site => site.kind === 'sketchFeature');
    expect(sites?.map(site => site.sketchId)).toEqual([first.id, second.id]);
  });

  it('includes a nonactive configuration owner separately from active parameter fields', () => {
    const base = createEmptyPartDocument();
    const document: PartDocument = { ...base, parameters: [parameter('板厚'), parameter('穴径')],
      configurations: [...base.configurations, {
        id: 'configuration-other', name: '長い', values: { 板厚: '3', 穴径: '板厚*2' },
      }],
    };
    expect(parameterUsageSites(document).get('板厚')).toEqual([{
      kind: 'configuration', ownerId: '穴径', ownerName: '穴径',
      configurationId: 'configuration-other', configurationName: '長い',
    }]);
  });

  it('reads non-scalar mathematical problems through documentFunctions and coefficient IDs', () => {
    const source = 'coef("A")';
    const document: PartDocument = { ...createEmptyPartDocument(),
      parameters: [{ ...parameter('A'), mathId: 'coefficient:1' }],
      unresolvedMathProblems: [{ id: 'problem-1', name: '関係式', status: 'unresolved',
        definition: { format: 'pointercad-math/1', source, inputNotation: 'text', angleUnit: 'degree',
          expression: { kind: 'symbol', reference: {
            role: 'coefficient', id: 'coefficient:1', label: 'A',
          } },
        },
      }],
    };
    expect(parameterUsageSites(document).get('A')).toEqual([{
      kind: 'mathProblem', ownerId: 'problem-1', ownerName: '関係式',
    }]);
  });
});
