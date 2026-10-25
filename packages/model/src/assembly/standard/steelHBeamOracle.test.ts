import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import * as ts from 'typescript';
import { describe, expect, it } from 'vitest';

import { findHBeam, H_BEAM_TABLE } from './sections.js';
import { STEEL_EVIDENCE, STEEL_PRODUCTS, steelProducts } from './steelCatalog.js';
import {
  H_BEAM_ADDITION_ORACLE, H_BEAM_ADDITION_SAVED_OPTIONS, H_BEAM_ORACLE, H_BEAM_TRANSCRIPT,
} from './steelHBeamOracle.fixture.js';
import { steelSectionProfile, type SteelProfileSegment } from './steelSectionProfiles.js';

const relative = (actual: number, expected: number): number => Math.abs(actual - expected) / expected;
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

/** Decimal half-even rounding, independent of binary floating-point ties. */
function significant(numerator: bigint, denominator: bigint, digits: number): string {
  let exponent = 0;
  while (numerator >= denominator * 10n ** BigInt(exponent + 1)) exponent++;
  const places = digits - 1 - exponent;
  const top = places >= 0 ? numerator * 10n ** BigInt(places) : numerator;
  const bottom = places >= 0 ? denominator : denominator * 10n ** BigInt(-places);
  const quotient = top / bottom, remainder = top % bottom;
  const rounded = quotient + (2n * remainder > bottom
    || (2n * remainder === bottom && quotient % 2n === 1n) ? 1n : 0n);
  return (Number(rounded) * 10 ** -places).toFixed(Math.max(0, places));
}

describe('W7 independent H beam table 15 oracle', () => {
  it('adds exactly 46 source sizes and material rows without assigning grades to four old-only sizes', () => {
    expect(H_BEAM_TABLE).toHaveLength(53);
    expect(H_BEAM_ORACLE).toHaveLength(53);
    expect(H_BEAM_ADDITION_ORACLE).toHaveLength(46);
    expect(H_BEAM_ADDITION_SAVED_OPTIONS).toHaveLength(46);
    expect(new Set(H_BEAM_ORACLE.map(row => row.size)).size).toBe(53);
    expect(STEEL_PRODUCTS).toHaveLength(459);
    expect(steelProducts('SS400')).toHaveLength(253);
    expect(steelProducts('SS400', 'hBeam')).toHaveLength(49);
    expect(H_BEAM_ADDITION_ORACLE.filter(row => row.flange === '細幅')).toHaveLength(29);
    expect(H_BEAM_ADDITION_ORACLE.filter(row => row.flange === '中幅')).toHaveLength(11);
    expect(H_BEAM_ADDITION_ORACLE.filter(row => row.flange === '広幅')).toHaveLength(6);
    expect(H_BEAM_ORACLE.filter(row => !STEEL_PRODUCTS.some(product => product.key === row.key)).map(row => row.size))
      .toEqual(['H 100×100×6×8', 'H 125×125×6.5×9', 'H 175×175×7.5×11', 'H 250×250×9×14']);
  });

  it('retains every pre-W7 sections.ts byte, including all seven H rows and five warning rows', () => {
    const text = readFileSync(new URL('./sections.ts', import.meta.url), 'utf8');
    const lines = text.split(String.fromCharCode(10));
    const added = lines.filter(line => H_BEAM_ADDITION_ORACLE.some(row =>
      line.startsWith(`  { key: 'JIS-G-3192:2024:${row.size}',`)));
    expect(added).toHaveLength(46);
    const original = lines.filter(line => !added.includes(line)).join(String.fromCharCode(10));
    expect(sourceHash(original)).toBe('069d0bf20815a51567eda5b6c0ce39b50da67d0d8ff86456ea3e2ca35891d6a5');
    expect(H_BEAM_TABLE.filter(row => !row.verified).map(row => row.size)).toEqual(['H 175×175×7.5×11']);
  });

  it('preserves the frozen W6d fixture in addition to the old W1/W4b/W5 fixtures', () => {
    const text = readFileSync(new URL('./steelAngleChannelOracle.fixture.ts', import.meta.url), 'utf8');
    expect(sourceHash(text)).toBe('f737c8d77d6bb831ce1ce9d0c954228597efa63e8921aa78a12ab86d0d292e5c');
  });

  it('keeps the standalone fixture independent of application modules and scratchpad at runtime', () => {
    const text = readFileSync(new URL('./steelHBeamOracle.fixture.ts', import.meta.url), 'utf8');
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

  it('retains all twenty non-general-purpose star marks and the printed nominal series in notes', () => {
    const starred = H_BEAM_ORACLE.filter(row => row.starMark.value);
    expect(starred).toHaveLength(20);
    for (const oracle of H_BEAM_ADDITION_ORACLE) {
      const row = findHBeam(oracle.size);
      expect(row?.note).toContain(`series=${oracle.series.value}`);
      expect(row?.note.includes('＊印（汎用品以外）')).toBe(oracle.starMark.value);
    }
    expect(findHBeam('H 148×100×6×9')?.note).toContain('series=150×100');
    expect(findHBeam('H 498×432×45×70')?.note).toContain('series=400×400');
  });

  it.each(H_BEAM_ORACLE)('$size retains printed dimensions, precision and row-specific primary provenance', oracle => {
    const row = findHBeam(oracle.size);
    if (row === undefined) throw new Error('Missing W7 section');
    expect(row.key).toBe(`JIS-G-3192:2024:${oracle.size}`);
    for (const [name, quantity] of Object.entries(oracle.dimensions)) {
      expect(row).toHaveProperty(name, quantity.value);
      expect(quantity.kind).toBe('source');
      expect(quantity.citation.locator).toContain('JISF G 3192 原案 表15');
      expect(quantity.citation.locator).toContain(H_BEAM_TRANSCRIPT);
    }
    expect(row.innerRadius).toBe(oracle.rootRadiusMm.value);
    expect(row.areaCm2).toBe(Number(oracle.printedAreaCm2.value));
    expect(row.massKgPerM).toBe(Number(oracle.printedMassKgPerM.value));
    expect(oracle.printedAreaCm2.kind).toBe('source');
    expect(oracle.printedMassKgPerM.kind).toBe('source');
    expect(oracle.jisAreaMm2.kind).toBe('computed');
    expect(oracle.exactAreaMm2.kind).toBe('computed');
    const [h, b, tw, tf, r] = [row.height, row.width, row.webThickness, row.flangeThickness, row.innerRadius]
      .map(value => BigInt(value * 10));
    const numerator = (tw * (h - 2n * tf) + 2n * b * tf) * 1000n + 858n * r ** 2n;
    expect(significant(numerator, 10000000n, 4)).toBe(oracle.printedAreaCm2.value);
    const printed = oracle.printedAreaCm2.value;
    expect(significant(BigInt(printed.replace('.', '')) * 785n,
      10n ** BigInt(printed.split('.')[1]?.length ?? 0) * 1000n, 3)).toBe(oracle.printedMassKgPerM.value);
    if (oracle.added) {
      expect(row.verified).toBe(true);
      expect(row.note).toContain('JISF G 3192 原案 2024-07-24 表 15、転記 g3192-tables.json');
      expect(row.note).toContain(H_BEAM_TRANSCRIPT);
      const line = readFileSync(new URL('./sections.ts', import.meta.url), 'utf8')
        .split(String.fromCharCode(10)).find(item => item.startsWith(`  { key: '${row.key}',`));
      expect(line).toContain(`areaCm2: ${oracle.printedAreaCm2.value},`);
      expect(line).toContain(`massKgPerM: ${oracle.printedMassKgPerM.value},`);
      const product = STEEL_PRODUCTS.find(item => item.key === oracle.key);
      if (product === undefined) throw new Error('Missing W7 material product');
      expect(product.evidence).toBe('ssHBeamDraft');
      expect(product.profileEvidence).toEqual(STEEL_EVIDENCE.ssHBeamDraft);
      expect(product.profileEvidence?.sha256).toBe('ca399bdfe4d84de29e04449d7356de9e45b83405b291c6dc8bf9ea7c5c772baa');
      expect(product.profileEvidence?.locator).toContain('JISF G 3192 原案 2024-07-24 表15');
      expect(product.profileEvidence?.locator).toContain(H_BEAM_TRANSCRIPT);
      expect(product.standardEdition.dimensions.verification).toBe('draft');
      expect(product.standardLengthsMm).toEqual([]);
    }
  });

  it.each(H_BEAM_ORACLE)('$size has a closed tangent boundary within 0.05 percent of printed and JIS areas', row => {
    const profile = steelSectionProfile(row.catalog, row.size);
    if (profile === undefined) throw new Error('Missing table 15 H profile');
    expect(profile).toMatchObject({ width: row.dimensions.width.value, height: row.dimensions.height.value,
      rootRadius: row.rootRadiusMm.value, tipRadius: 0, taperDegrees: 0 });
    expect(relative(profile.areaMm2, row.areaMm2.value)).toBeLessThanOrEqual(5e-4);
    expect(relative(profile.areaMm2, row.jisAreaMm2.value)).toBeLessThanOrEqual(5e-4);
    expect(relative(profile.areaMm2, row.exactAreaMm2.value)).toBeLessThan(1e-12);
    const arcs = profile.segments.filter(segment => segment.kind === 'arc');
    expect(arcs).toHaveLength(4);
    expect(arcs.every(arc => arc.endAngle < arc.startAngle && arc.radius === row.rootRadiusMm.value)).toBe(true);
    const points = profile.segments.flatMap(segment => [segment.from, segment.to]);
    expect(Math.min(...points.map(point => point[0]))).toBe(0);
    expect(Math.min(...points.map(point => point[1]))).toBe(0);
    expect(Math.max(...points.map(point => point[0]))).toBe(profile.width);
    expect(Math.max(...points.map(point => point[1]))).toBe(profile.height);
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
    process.stdout.write('W7_H_AREA ' + JSON.stringify({ size: row.size, printedAreaMm2: row.areaMm2.value,
      jisAreaMm2: row.jisAreaMm2.value, generatedAreaMm2: profile.areaMm2,
      printedRelativeDifference: relative(profile.areaMm2, row.areaMm2.value),
      jisRelativeDifference: relative(profile.areaMm2, row.jisAreaMm2.value) }) + String.fromCharCode(10));
  });
});
