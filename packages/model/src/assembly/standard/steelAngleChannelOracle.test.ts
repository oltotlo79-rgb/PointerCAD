import { H_BEAM_PROFILE_ADDITIONS, H_BEAM_ADDITION_ORACLE } from './steelHBeamOracle.fixture.js';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import * as ts from 'typescript';
import { describe, expect, it } from 'vitest';

import { CHANNEL_TABLE, EQUAL_ANGLE_TABLE, H_BEAM_TABLE } from './sections.js';
import {
  ANGLE_ADDITION_ORACLE, CHANNEL_ADDITION_CATALOG_ORACLE, SECTION_ADDITION_TRANSCRIPT,
  STEEL_SECTION_ADDITION_ORACLE,
} from './steelAngleChannelOracle.fixture.js';
import { STEEL_EVIDENCE, STEEL_PRODUCTS, steelProducts } from './steelCatalog.js';
import { CHANNEL_ADDITION_ORACLE } from './steelChannelOracle.fixture.js';
import { steelSectionProfile, type SteelProfileSegment } from './steelSectionProfiles.js';

const relative = (actual: number, expected: number): number => Math.abs(actual - expected) / expected;
// Git may check out TS with LF or CRLF; only that encoding difference is normalized here.
// The worker audit separately compares the original on-disk bytes before and after additions.
const sourceHash = (text: string): string => createHash('sha256')
  .update(text.replaceAll(String.fromCharCode(13, 10), String.fromCharCode(10)), 'utf8').digest('hex');
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

describe('W6d independent angle and channel additions', () => {
  it('adds exactly 14 angles and eight channels to both selection paths', () => {
    expect(ANGLE_ADDITION_ORACLE).toHaveLength(14);
    expect(CHANNEL_ADDITION_CATALOG_ORACLE).toHaveLength(8);
    expect(STEEL_SECTION_ADDITION_ORACLE).toHaveLength(22);
    expect(new Set(STEEL_SECTION_ADDITION_ORACLE.map(row => row.key)).size).toBe(22);
    expect(STEEL_PRODUCTS).toHaveLength(459);
    expect(steelProducts('SS400')).toHaveLength(253);
    expect(steelProducts('SS400', 'equalAngle')).toHaveLength(17);
    expect(steelProducts('SS400', 'channel')).toHaveLength(11);
    expect([...EQUAL_ANGLE_TABLE, ...CHANNEL_TABLE, ...H_BEAM_TABLE]).toHaveLength(109);
  });

  it('retains every pre-existing sections.ts byte including all five warning notes', () => {
    const text = readFileSync(new URL('./sections.ts', import.meta.url), 'utf8');
    const lines = text.split(String.fromCharCode(10));
    const hBeamLines = lines.filter(line => H_BEAM_ADDITION_ORACLE.some(row =>
      line.startsWith(`  { key: 'JIS-G-3192:2024:${row.size}',`)));
    expect(hBeamLines).toHaveLength(46);
    for (const line of hBeamLines) lines.splice(lines.indexOf(line), 1);
    const added = lines.filter(line => STEEL_SECTION_ADDITION_ORACLE.some(row =>
      line.startsWith(`  { key: 'JIS-G-3192:2024:${row.size}',`)));
    expect(added).toHaveLength(22);
    const original = lines.filter(line => !added.includes(line)).join(String.fromCharCode(10));
    expect(sourceHash(original)).toBe('9b48419b198b6d002382cc166d713a0e24ead329dd4cf6ca764d3480882ac22c');
  });

  it.each([
    ['steelCatalogOracle.fixture.ts', 'd891a8cc6918188b576e7a967062e84830b5e9c75e38fc56a435ddfb92b3cfce'],
    ['steelS45cOracle.fixture.ts', '51d3342fd50345c4e7a97f42c07cbfb301202d4b642b077b4cd5443cd834276d'],
    ['steelGolden.fixture.ts', 'bb738d3bcc4f7571816aa3f406f8968c16b16540af388350ad23086c64e77cca'],
  ])('%s retains the frozen W1/W4b/W5 bytes', (name, sha256) => {
    const text = readFileSync(new URL('./' + name, import.meta.url), 'utf8');
    // W8b adds a separate SGP table after all frozen W1/W4b/W5 bytes.
    const marker = String.fromCharCode(10) + '/** W8b: literal printed strings';
    const end = name === 'steelCatalogOracle.fixture.ts' ? text.indexOf(marker) : text.length;
    expect(end).toBeGreaterThan(0);
    expect(sourceHash(text.slice(0, end))).toBe(sha256);
  });

  it('retains all W6c channel profile and generator bytes while appending angle rows', () => {
    const text = readFileSync(new URL('./steelSectionProfiles.ts', import.meta.url), 'utf8');
    const original = text.split(String.fromCharCode(10)).filter(line =>
      !line.startsWith('  // JISF G 3192 原案 表8;')
      && !line.startsWith('  // W7 JISF G 3192 原案 表15;')
      && !H_BEAM_PROFILE_ADDITIONS.some(row => line.startsWith(`  '${row.size}':`))
      && !ANGLE_ADDITION_ORACLE.some(row => line.startsWith(`  '${row.size}':`))).join(String.fromCharCode(10));
    expect(sourceHash(original))
      .toBe('9bc0e9f3e842118d67da94b7d5a4661eb602e7753ec479980124e10951557c9f');
    expect(CHANNEL_ADDITION_CATALOG_ORACLE.map(row => [row.key, row.exactAreaMm2.value]))
      .toEqual(CHANNEL_ADDITION_ORACLE.map(row => [row.key, row.exactAreaMm2.value]));
  });

  it('keeps the new fixture independent of every module dependency', () => {
    const text = readFileSync(new URL('./steelAngleChannelOracle.fixture.ts', import.meta.url), 'utf8');
    const file = ts.createSourceFile('fixture.ts', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
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

  it.each(STEEL_SECTION_ADDITION_ORACLE)('$size retains printed precision, primary provenance and no stock promise', oracle => {
    const product = STEEL_PRODUCTS.find(row => row.key === oracle.key);
    if (product === undefined) throw new Error('Missing W6d product');
    const row = oracle.catalog === 'equalAngle' ? EQUAL_ANGLE_TABLE.find(item => item.size === oracle.size)
      : CHANNEL_TABLE.find(item => item.size === oracle.size);
    if (row === undefined) throw new Error('Missing W6d legacy section');
    const table = oracle.catalog === 'equalAngle' ? 8 : 12;
    expect(row.verified).toBe(true);
    expect(row.note).toContain(`JISF G 3192 原案 2024-07-24 表 ${table}、転記 g3192-tables.json`);
    expect(row.note).toContain(SECTION_ADDITION_TRANSCRIPT);
    expect(row.areaCm2).toBe(Number(oracle.printedAreaCm2.value));
    expect(row.massKgPerM).toBe(Number(oracle.printedMassKgPerM.value));
    const line = readFileSync(new URL('./sections.ts', import.meta.url), 'utf8')
      .split(String.fromCharCode(10)).find(item => item.startsWith(`  { key: 'JIS-G-3192:2024:${row.size}',`));
    expect(line).toContain(`areaCm2: ${oracle.printedAreaCm2.value},`);
    expect(line).toContain(`massKgPerM: ${oracle.printedMassKgPerM.value},`);
    expect((oracle.jisAreaMm2.value / 100).toPrecision(4)).toBe(oracle.printedAreaCm2.value);
    expect((Number(oracle.printedAreaCm2.value) * 0.785).toPrecision(3)).toBe(oracle.printedMassKgPerM.value);
    expect(product.profileEvidence).toEqual(STEEL_EVIDENCE[product.evidence]);
    expect(STEEL_EVIDENCE[product.evidence].sha256)
      .toBe('ca399bdfe4d84de29e04449d7356de9e45b83405b291c6dc8bf9ea7c5c772baa');
    expect(STEEL_EVIDENCE[product.evidence].locator).toContain(`JISF G 3192 原案 2024-07-24 表${table}`);
    expect(STEEL_EVIDENCE[product.evidence].locator).toContain(SECTION_ADDITION_TRANSCRIPT);
    expect(product.standardEdition.dimensions.verification).toBe('draft');
    expect(product.standardLengthsMm).toEqual([]);
    expect(oracle.standardLengthsMm).toMatchObject({ kind: 'unverified', value: null });
    for (const quantity of [...Object.values(oracle.dimensions), oracle.rootRadiusMm, oracle.tipRadiusMm,
      oracle.printedAreaCm2, oracle.printedMassKgPerM, oracle.areaMm2, oracle.massKgPerM]) {
      expect(quantity.kind).toBe('source');
      expect(quantity.citation.locator).toContain(`JISF G 3192 原案 表${table}`);
      expect(quantity.citation.locator).toContain(SECTION_ADDITION_TRANSCRIPT);
    }
    expect(oracle.exactAreaMm2.kind).toBe('computed');
    expect(oracle.jisAreaMm2.kind).toBe('computed');
  });

  it.each(ANGLE_ADDITION_ORACLE)('$size has a closed tangent boundary within 0.05 percent of both areas', row => {
    const profile = steelSectionProfile(row.catalog, row.size);
    if (profile === undefined) throw new Error('Missing additional angle profile');
    expect(profile.rootRadius).toBe(row.rootRadiusMm.value);
    expect(profile.tipRadius).toBe(row.tipRadiusMm.value);
    expect(profile.width).toBe(row.dimensions.a.value);
    expect(profile.height).toBe(row.dimensions.b.value);
    expect(profile.taperDegrees).toBe(0);
    expect(relative(profile.areaMm2, row.areaMm2.value)).toBeLessThanOrEqual(5e-4);
    expect(relative(profile.areaMm2, row.jisAreaMm2.value)).toBeLessThanOrEqual(5e-4);
    expect(relative(profile.areaMm2, row.exactAreaMm2.value)).toBeLessThan(1e-12);
    const arcs = profile.segments.filter(segment => segment.kind === 'arc');
    expect(arcs).toHaveLength(3);
    expect(arcs.filter(arc => arc.endAngle < arc.startAngle)).toHaveLength(1);
    expect(arcs.filter(arc => arc.endAngle < arc.startAngle).map(arc => arc.radius)).toEqual([row.rootRadiusMm.value]);
    expect(arcs.filter(arc => arc.endAngle > arc.startAngle).map(arc => arc.radius))
      .toEqual([row.tipRadiusMm.value, row.tipRadiusMm.value]);
    const points = profile.segments.flatMap(segment => [segment.from, segment.to]);
    for (const axis of [0, 1]) {
      expect(Math.min(...points.map(point => point[axis]))).toBe(0);
      expect(Math.max(...points.map(point => point[axis]))).toBe(profile.width);
    }
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
    process.stdout.write('W6D_ANGLE_AREA ' + JSON.stringify({ size: row.size,
      printedAreaMm2: row.areaMm2.value, jisAreaMm2: row.jisAreaMm2.value,
      exactAreaMm2: row.exactAreaMm2.value, generatedAreaMm2: profile.areaMm2,
      printedRelativeDifference: relative(profile.areaMm2, row.areaMm2.value),
      jisRelativeDifference: relative(profile.areaMm2, row.jisAreaMm2.value) }) + String.fromCharCode(10));
  });
});
