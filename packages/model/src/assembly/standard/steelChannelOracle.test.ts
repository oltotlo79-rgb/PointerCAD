import { readFileSync } from 'node:fs';
import * as ts from 'typescript';
import { describe, expect, it } from 'vitest';

import { CHANNEL_TABLE, EQUAL_ANGLE_TABLE, H_BEAM_TABLE } from './sections.js';
import { CHANNEL_ADDITION_ORACLE, CHANNEL_ADDITION_PRINTED } from './steelChannelOracle.fixture.js';
import { steelSectionProfile, type SteelProfileSegment } from './steelSectionProfiles.js';

function tangent(segment: SteelProfileSegment, end: boolean): readonly [number, number] {
  if (segment.kind === 'line') {
    const dx = segment.to[0] - segment.from[0], dy = segment.to[1] - segment.from[1];
    const norm = Math.hypot(dx, dy);
    return [dx / norm, dy / norm];
  }
  const angle = end ? segment.endAngle : segment.startAngle;
  const sign = Math.sign(segment.endAngle - segment.startAngle);
  return [-Math.sin(angle) * sign, Math.cos(angle) * sign];
}

describe('W6c independent channel profiles', () => {
  it('freezes exactly the eight additional rows and the raw transcript numeric spellings', () => {
    expect(CHANNEL_ADDITION_ORACLE).toHaveLength(8);
    expect(new Set(CHANNEL_ADDITION_ORACLE.map(row => row.key)).size).toBe(8);
    const text = readFileSync(new URL('../../../../../docs/standards/jis/channel-jis-g-3192.json', import.meta.url), 'utf8');
    const values: unknown = JSON.parse(text);
    if (typeof values !== 'object' || values === null || !('rows' in values) || !Array.isArray(values.rows)) {
      throw new Error('Invalid channel source transcript');
    }
    const additions = values.rows.slice(8);
    expect(additions).toHaveLength(8);
    CHANNEL_ADDITION_PRINTED.forEach(([h, b, tw, tf, root, tip, area, mass], index) => {
      expect(additions[index]).toMatchObject({ H: h, B: b, t1: tw, t2: tf, r1: root, r2: tip,
        area: Number(area), mass: Number(mass), verified: true });
      const block = text.split('"designation":').find(part =>
        part.trimStart().startsWith(JSON.stringify(`[ ${h}×${b}×${tw}×${tf}`)));
      expect(block).toContain('"area": ' + area + ',');
      expect(block).toContain('"mass": ' + mass + ',');
    });
  });

  it.each(CHANNEL_ADDITION_ORACLE)('$size agrees with both printed and JIS formula areas to 0.05 percent', row => {
    const profile = steelSectionProfile(row.catalog, row.size);
    if (profile === undefined) throw new Error('Missing additional channel profile');
    expect(profile.rootRadius).toBe(row.rootRadiusMm.value);
    expect(profile.tipRadius).toBe(row.tipRadiusMm.value);
    expect(profile.width).toBe(row.dimensions.width.value);
    expect(profile.height).toBe(row.dimensions.height.value);
    expect(profile.taperDegrees).toBe(5);
    const printed = Number(row.printedAreaCm2.value) * 100;
    expect(Math.abs(profile.areaMm2 - printed) / printed).toBeLessThanOrEqual(5e-4);
    expect(Math.abs(profile.areaMm2 - row.jisAreaMm2.value) / row.jisAreaMm2.value).toBeLessThanOrEqual(5e-4);
    expect(Math.abs(profile.areaMm2 - row.exactAreaMm2.value) / row.exactAreaMm2.value).toBeLessThan(1e-12);
    expect(row.printedAreaCm2.kind).toBe('source');
    expect(row.printedMassKgPerM.kind).toBe('source');
    expect(row.jisAreaMm2.kind).toBe('computed');
    expect(row.standardLengthsMm).toMatchObject({ kind: 'unverified', value: null });
    for (const quantity of [...Object.values(row.dimensions), row.rootRadiusMm, row.tipRadiusMm,
      row.printedAreaCm2, row.printedMassKgPerM]) {
      expect(quantity.citation.locator).toContain('JISF G 3192 原案 表12');
      expect(quantity.citation.locator).toContain('docs/standards/jis/channel-jis-g-3192.json');
    }
    process.stdout.write('W6C_CHANNEL_AREA ' + JSON.stringify({ size: row.size, printedAreaMm2: printed,
      jisAreaMm2: row.jisAreaMm2.value, exactAreaMm2: row.exactAreaMm2.value, generatedAreaMm2: profile.areaMm2,
      printedRelativeDifference: Math.abs(profile.areaMm2 - printed) / printed,
      jisRelativeDifference: Math.abs(profile.areaMm2 - row.jisAreaMm2.value) / row.jisAreaMm2.value }) + String.fromCharCode(10));
  });

  it.each(CHANNEL_ADDITION_ORACLE)('$size is closed with tangent root and tip arcs, unchanged slope and midpoint thickness', row => {
    const profile = steelSectionProfile(row.catalog, row.size);
    if (profile === undefined) throw new Error('Missing additional channel profile');
    const arcs = profile.segments.filter(segment => segment.kind === 'arc');
    expect(arcs).toHaveLength(4);
    expect(arcs.filter(arc => arc.endAngle < arc.startAngle)).toHaveLength(2);
    expect(new Set(arcs.map(arc => arc.radius))).toEqual(new Set([row.rootRadiusMm.value, row.tipRadiusMm.value]));
    const points = profile.segments.flatMap(segment => [segment.from, segment.to]);
    expect(Math.min(...points.map(point => point[0]))).toBe(0);
    expect(Math.min(...points.map(point => point[1]))).toBe(0);
    expect(Math.max(...points.map(point => point[0]))).toBe(row.dimensions.width.value);
    expect(Math.max(...points.map(point => point[1]))).toBe(row.dimensions.height.value);
    for (let index = 0; index < profile.segments.length; index++) {
      const current = profile.segments[index], next = profile.segments[(index + 1) % profile.segments.length];
      expect(current.to[0]).toBeCloseTo(next.from[0], 10);
      expect(current.to[1]).toBeCloseTo(next.from[1], 10);
      if (current.kind === 'arc' || next.kind === 'arc') {
        const first = tangent(current, true), second = tangent(next, false);
        expect(first[0] * second[0] + first[1] * second[1]).toBeCloseTo(1, 10);
      }
      if (current.kind === 'arc') for (const point of [current.from, current.to]) {
        expect(Math.hypot(point[0] - current.center[0], point[1] - current.center[1])).toBeCloseTo(current.radius, 10);
      }
    }
    const lower = profile.segments.find(segment => segment.kind === 'line'
      && segment.from[0] > segment.to[0] && segment.from[1] < segment.to[1]);
    if (lower?.kind !== 'line') throw new Error('Missing tapered flange');
    const slope = (lower.to[1] - lower.from[1]) / (lower.to[0] - lower.from[0]);
    expect(slope).toBeCloseTo(-Math.tan(5 * Math.PI / 180), 12);
    const midpoint = (row.dimensions.width.value + row.dimensions.webThickness.value) / 2;
    expect(lower.from[1] + (midpoint - lower.from[0]) * slope).toBeCloseTo(row.dimensions.flangeThickness.value, 10);
  });

  it('keeps all five legacy warnings with their draft table number and does not promote verification', () => {
    const warnings = [...EQUAL_ANGLE_TABLE, ...CHANNEL_TABLE, ...H_BEAM_TABLE].filter(row => !row.verified);
    expect(warnings).toHaveLength(5);
    expect(warnings.filter(row => row.size.startsWith('L '))).toHaveLength(4);
    for (const row of warnings) {
      expect(row.note).toContain(row.size.startsWith('L ') ? '表8' : '表15');
      expect(row.note).toContain('要確認');
      expect(row.note).toContain('docs/standards/jis/');
    }
  });

  it.each(['steelChannelOracle.fixture.ts', 'steelChannelRegressionOracle.fixture.ts'])(
    '%s has no module dependency, import, re-export or require', name => {
      const text = readFileSync(new URL('./' + name, import.meta.url), 'utf8');
      const file = ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
      const dependencies: string[] = [];
      function visit(node: ts.Node): void {
        if (ts.isImportDeclaration(node) || ts.isImportEqualsDeclaration(node) || ts.isImportTypeNode(node)
          || (ts.isExportDeclaration(node) && node.moduleSpecifier !== undefined)
          || (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword
            || (ts.isIdentifier(node.expression) && node.expression.text === 'require')))) dependencies.push(node.getText(file));
        ts.forEachChild(node, visit);
      }
      visit(file);
      expect(dependencies).toEqual([]);
    });
});
