import { H_BEAM_ADDITION_ORACLE } from './steelHBeamOracle.fixture.js';
import { STEEL_SECTION_ADDITION_ORACLE } from './steelAngleChannelOracle.fixture.js';
import { readFileSync } from 'node:fs';
import * as ts from 'typescript';
import { describe, expect, it } from 'vitest';

import type { PartDocument } from '../../part/types.js';
import type { CoordinateInput } from '../../sketch/types.js';
import { buildStandardPartFromSource, createStandardPartSource } from './buildStandardPart.js';
import { CHANNEL_TABLE, EQUAL_ANGLE_TABLE, H_BEAM_TABLE } from './sections.js';
import { STEEL_PRODUCTS, steelProductOptions } from './steelCatalog.js';
import {
  SGP_ADDITION_ORACLE, SGP_TABLE4_PRINTED, STEEL_SS400_EXPANSION_ORACLE, SS400_STANDARD_THICKNESSES, SS400_STANDARD_WIDTHS, SS400_STANDARD_ROUND_PRINTED,
  SS400_ROUND_PRINTED_DISCREPANCIES,
  SS400_EXPANSION_FLAT_PRINTED, SS400_EXPANSION_FLAT_JIS_PRINTED, SS400_EXPANSION_SAVED_OPTIONS,
  ORACLE_DENSITY_KG_PER_M3, STEEL_CATALOG_ORACLE, STEEL_HOT_CATALOG_ORACLE, S45C_HOT_FLAT_PRINTED, oraclePipeMass, type SteelCatalogOracleRow,
} from './steelCatalogOracle.fixture.js';

const ALL_ORACLE_ROWS = [...STEEL_CATALOG_ORACLE, ...STEEL_HOT_CATALOG_ORACLE, ...STEEL_SS400_EXPANSION_ORACLE, ...STEEL_SECTION_ADDITION_ORACLE, ...H_BEAM_ADDITION_ORACLE, ...SGP_ADDITION_ORACLE];

describe('W8b independent SGP table 4 and zinc-coated conditions', () => {
  it('covers 24 black and 24 white sizes while keeping the old six black rows separate', () => {
    expect(SGP_TABLE4_PRINTED).toHaveLength(24);
    expect(new Set(SGP_TABLE4_PRINTED.map(([id]) => id)).size).toBe(24);
    expect(SGP_ADDITION_ORACLE).toHaveLength(42);
    const pipes = STEEL_PRODUCTS.filter((row) => row.materialGrade === 'SGP');
    expect(pipes).toHaveLength(48);
    for (const condition of ['blackPipe-plainEnds', 'whitePipe-zincCoated']) {
      const selected = pipes.filter((row) => row.condition === condition);
      expect(selected).toHaveLength(24);
      expect(selected.map((row) => row.size).sort()).toEqual(SGP_TABLE4_PRINTED.map(([, size]) => size).sort());
    }
    const additions = pipes.filter((row) => SGP_ADDITION_ORACLE.some((oracle) => oracle.key === row.key));
    expect(additions.filter((row) => row.condition === 'blackPipe-plainEnds')).toHaveLength(18);
    expect(additions.filter((row) => row.condition === 'whitePipe-zincCoated')).toHaveLength(24);
  });

  it.each(SGP_TABLE4_PRINTED)('%s %s matches black/white dimensions and independent rational mass rounding',
    (id, size, diameter, thickness, printedMass) => {
      const [dn, dd] = decimalFraction(diameter), [tn, td] = decimalFraction(thickness);
      const numerator = 2466n * tn * (dn * td - tn * dd);
      const denominator = 100000n * dd * td * td;
      expect(printedSignificant(numerator, denominator, 3)).toBe(printedMass);
      const exactMass = Number(numerator) / Number(denominator);
      const difference = relativeDifference(Number(printedMass), exactMass);
      expect(difference).toBeLessThan(0.005);
      process.stdout.write('SGP_TABLE4_MASS ' + JSON.stringify({ id, size, printedMass,
        exactMass, relativeDifference: difference }) + '\n');
      for (const white of [false, true]) {
        const key = `SGP:steelPipe:${size}${white ? ':whitePipe-zincCoated' : ''}`;
        const row = STEEL_PRODUCTS.find((candidate) => candidate.key === key);
        if (row === undefined) throw new Error(`Missing SGP row ${key}`);
        if (row.dimensions === undefined) throw new Error(`Missing SGP dimensions ${key}`);
        expect(row.dimensions).toEqual({ outsideDiameter: Number(diameter), wallThickness: Number(thickness) });
        expect(row.condition).toBe(white ? 'whitePipe-zincCoated' : 'blackPipe-plainEnds');
        expect(row.standardLengthsMm).toEqual([5500]);
        expect(row.evidence).toBe('pipe');
        const [pdn, pdd] = decimalFraction(String(row.dimensions.outsideDiameter));
        const [ptn, ptd] = decimalFraction(String(row.dimensions.wallThickness));
        expect(printedSignificant(2466n * ptn * (pdn * ptd - ptn * pdd),
          100000n * pdd * ptd * ptd, 3)).toBe(printedMass);
        if (SGP_ADDITION_ORACLE.some((oracle) => oracle.key === key)) {
          expect(row.note).toContain(id);
          expect(row.note).toContain('表 4 の単位質量はソケットを含まない参考値。めっき・ねじの分は含まない');
          expect(row.note).toContain('管端・ソケット・ねじ・めっき厚さは形状に反映しない');
          expect(row.note).toContain(Number.parseInt(size, 10) <= 300
            ? '300A以下はねじ付又はプレンエンド' : '350A以上はプレンエンド');
          if (white) expect(row.note).toContain('亜鉛めっき -ZN');
        }
      }
    });

  it('uses rule A ties-to-even rather than rounding every half upwards', () => {
    expect(printedSignificant(1245n, 1000n, 3)).toBe('1.24');
    expect(printedSignificant(1255n, 1000n, 3)).toBe('1.26');
    expect(printedSignificant(4195n, 10000n, 3)).toBe('0.420');
  });
});

/** Exact rational half-even rounding: no binary decimal tie or added tolerance. */
function decimalFraction(value: string): readonly [bigint, bigint] {
  const places = value.split('.')[1]?.length ?? 0;
  return [BigInt(value.replace('.', '')), 10n ** BigInt(places)];
}
function printedSignificant(numerator: bigint, denominator: bigint, digits: number): string {
  let exponent = 0;
  if (numerator >= denominator) {
    while (numerator >= denominator * 10n ** BigInt(exponent + 1)) exponent++;
  } else {
    while (numerator * 10n ** BigInt(-exponent) < denominator) exponent--;
  }
  const places = digits - 1 - exponent;
  const top = places >= 0 ? numerator * 10n ** BigInt(places) : numerator;
  const bottom = places >= 0 ? denominator : denominator * 10n ** BigInt(-places);
  const quotient = top / bottom, remainder = top % bottom;
  const rounded = quotient + (2n * remainder > bottom
    || (2n * remainder === bottom && quotient % 2n === 1n) ? 1n : 0n);
  return (Number(rounded) * 10 ** -places).toFixed(Math.max(0, places));
}

const relativeDifference = (actual: number, expected: number): number => Math.abs(actual - expected) / expected;
function product(row: SteelCatalogOracleRow) {
  const found = STEEL_PRODUCTS.find((candidate) => candidate.key === row.key);
  if (found === undefined) throw new Error(`Missing oracle product ${row.key}`);
  return found;
}
function xy(input: CoordinateInput): readonly [number, number] {
  if (input.mode !== 'absolute') throw new Error('Generated section must have absolute coordinates');
  return [input.x.value, input.y.value];
}
const cross = (a: readonly [number, number], b: readonly [number, number]): number => a[0] * b[1] - a[1] * b[0];

/** Integrate the actual generated document, not a catalog area/nominal-volume helper.
 * Polygons use shoelace; line/arc faces use Green's theorem; pipes subtract two circles.
 */
function generatedArea(document: PartDocument): number {
  const extrude = document.solids.find((solid) => solid.kind === 'extrude');
  if (extrude?.kind === 'extrude') {
    const sketch = document.sketches.find((candidate) => candidate.id === extrude.profile.sketchId);
    const face = sketch?.features.find((feature) => feature.id === extrude.profile.faceFeatureId);
    if (sketch === undefined || face?.kind !== 'face') throw new Error('Missing generated face');
    const boundary = face.boundary.map((ref) => {
      const feature = sketch.features.find((candidate) => candidate.id === ref.featureId);
      if (feature === undefined) throw new Error('Missing boundary member');
      return feature;
    });
    if (boundary.every((feature) => feature.kind === 'point')) {
      const points = boundary.map((feature) => xy(feature.at));
      return Math.abs(points.reduce((sum, point, index) => sum + cross(point, points[(index + 1) % points.length]), 0)) / 2;
    }
    return Math.abs(boundary.reduce((area, feature) => {
      if (feature.kind === 'line') return area + cross(xy(feature.from), xy(feature.to)) / 2;
      if (feature.kind !== 'arc') throw new Error('Unexpected generated boundary kind');
      const [cx, cy] = xy(feature.center);
      const r = feature.radius.value;
      const a = feature.startAngle.value * Math.PI / 180;
      const b = feature.endAngle.value * Math.PI / 180;
      return area + (r * cx * (Math.sin(b) - Math.sin(a))
        - r * cy * (Math.cos(b) - Math.cos(a)) + r ** 2 * (b - a)) / 2;
    }, 0));
  }
  const radii = document.solids.flatMap((solid) => solid.kind === 'primitive' && solid.shape.kind === 'cylinder'
    ? [solid.shape.radius.value] : []);
  if (radii.length === 1) {
    expect(document.solids).toHaveLength(1);
    return Math.PI * radii[0] ** 2;
  }
  expect(radii).toHaveLength(2);
  expect(document.solids).toHaveLength(3);
  expect(document.solids[2]).toMatchObject({ kind: 'boolean', operation: 'subtract',
    targetFeatureId: document.solids[0].id, toolFeatureId: document.solids[1].id });
  return Math.PI * (radii[0] ** 2 - radii[1] ** 2);
}

describe('independent 31-row steel catalog oracle', () => {
  it('has exactly the sourced 31 unique keys and keeps calculated and unknown quantities explicit', () => {
    expect(STEEL_CATALOG_ORACLE).toHaveLength(31);
    expect(new Set(STEEL_CATALOG_ORACLE.map((row) => row.key)).size).toBe(31);
    expect(STEEL_PRODUCTS.map((row) => row.key).sort()).toEqual(ALL_ORACLE_ROWS.map((row) => row.key).sort());
    expect(STEEL_HOT_CATALOG_ORACLE).toHaveLength(152);
    expect(new Set(ALL_ORACLE_ROWS.map((row) => row.key)).size).toBe(459);
    expect(STEEL_CATALOG_ORACLE.filter((row) => row.areaMm2.kind === 'source')).toHaveLength(19);
    expect(STEEL_CATALOG_ORACLE.filter((row) => row.massKgPerM.kind === 'computed')).toHaveLength(6);
    expect(STEEL_CATALOG_ORACLE.filter((row) => row.standardLengthsMm.kind === 'unverified')).toHaveLength(15);
    expect(ORACLE_DENSITY_KG_PER_M3).toMatchObject({ kind: 'computed', value: 7850 });
    expect(ORACLE_DENSITY_KG_PER_M3.formula).toContain('4.71');
    for (const row of STEEL_CATALOG_ORACLE) {
      expect(row.exactAreaMm2.kind).toBe('computed');
      for (const value of Object.values(row.dimensions)) {
        expect(value.kind).toBe('source');
        expect(value.citation.url).toMatch(/^https:/);
        expect(value.citation.locator.length).toBeGreaterThan(0);
      }
      if (row.grade === 'S45C') {
        expect(row.areaMm2.kind).toBe('computed');
        expect(row.massKgPerM.kind).toBe('computed');
      }
      if (['flatBar', 'roundBar', 'steelPipe'].includes(row.catalog)) {
        expect(row.rootRadiusMm).toMatchObject({ kind: 'unverified', value: null });
        expect(row.tipRadiusMm).toMatchObject({ kind: 'unverified', value: null });
      }
    }
  });

  it.each(['steelCatalogOracle.fixture.ts', 'steelS45cOracle.fixture.ts'])(
    '%s statically rejects every module import/re-export/require in the standalone fixture', (name) => {
    const text = readFileSync(new URL(`./${name}`, import.meta.url), 'utf8');
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

  it('covers all 152 added dimensions with explicit computed area/mass and unknown supply lengths', () => {
    expect(STEEL_HOT_CATALOG_ORACLE.filter((row) => row.catalog === 'roundBar')).toHaveLength(36);
    expect(STEEL_HOT_CATALOG_ORACLE.filter((row) => row.catalog === 'flatBar')).toHaveLength(116);
    for (const row of STEEL_HOT_CATALOG_ORACLE) {
      expect(row.areaMm2.kind).toBe('computed');
      expect(row.exactAreaMm2.kind).toBe('computed');
      expect(row.massKgPerM.kind).toBe('computed');
      expect(row.standardLengthsMm).toMatchObject({ kind: 'unverified', value: null });
      for (const dimension of Object.values(row.dimensions)) {
        expect(dimension.kind).toBe('source');
        expect(dimension.citation.url).toMatch(/^https:/);
        expect(dimension.citation.locator.length).toBeGreaterThan(0);
      }
    }
  });

  it.each(S45C_HOT_FLAT_PRINTED)('hot flat %s × %s keeps printed values separate from computed quantities',
    (thickness, width, printedArea, printedMass, page) => {
      const row = STEEL_HOT_CATALOG_ORACLE.find((candidate) => candidate.key === `S45C:flatBar:FB ${width}×${thickness}:hotRolled`);
      if (row === undefined) throw new Error('Missing independent hot flat');
      expect(row.dimensions.thickness.citation.locator).toContain(`PDF p${page}`);
      // Compare exact scaled integers: decimal → binary → ×100 can introduce roundoff.
      const scale = 10 ** (printedArea.split('.')[1]?.length ?? 0);
      expect(row.exactAreaMm2.value * scale).toBe(Number(printedArea.replace('.', '')) * 100);
      const halfUnit = 0.5 * 10 ** -(printedMass.split('.')[1]?.length ?? 0);
      expect(Math.abs(row.massKgPerM.value - Number(printedMass))).toBeLessThanOrEqual(halfUnit + 1e-12);
      expect(row.areaMm2.kind).toBe('computed');
      expect(row.massKgPerM.kind).toBe('computed');
    });

  it.each(ALL_ORACLE_ROWS)('$key agrees with source dimensions, printed table fields, radii and length status', (oracle) => {
    const row = product(oracle);
    expect(row).toMatchObject({ catalog: oracle.catalog, size: oracle.size, materialGrade: oracle.grade });
    const dimensions = Object.fromEntries(Object.entries(oracle.dimensions).map(([key, quantity]) => [key, quantity.value]));
    if (row.dimensions !== undefined) expect(row.dimensions).toEqual(dimensions);
    else {
      const tableRow = oracle.catalog === 'equalAngle' ? EQUAL_ANGLE_TABLE.find((candidate) => candidate.size === oracle.size)
        : oracle.catalog === 'channel' ? CHANNEL_TABLE.find((candidate) => candidate.size === oracle.size)
        : H_BEAM_TABLE.find((candidate) => candidate.size === oracle.size);
      if (tableRow === undefined) throw new Error(`Missing tabulated section ${oracle.key}`);
      expect(tableRow).toMatchObject(dimensions);
      expect(relativeDifference(tableRow.areaCm2 * 100, oracle.areaMm2.value)).toBeLessThanOrEqual(5e-4);
      expect(tableRow.massKgPerM).toBe(oracle.massKgPerM.value);
      expect(tableRow.innerRadius).toBe(oracle.rootRadiusMm.value);
      if ('tipRadius' in tableRow) expect(tableRow.tipRadius).toBe(oracle.tipRadiusMm.value);
    }
    if (oracle.standardLengthsMm.kind === 'source') expect(row.standardLengthsMm).toEqual(oracle.standardLengthsMm.value);
    else {
      expect(oracle.standardLengthsMm).toMatchObject({ kind: 'unverified', value: null });
      expect(row.standardLengthsMm).toEqual([]);
    }
  });

  it.each(ALL_ORACLE_ROWS)('$key generated boundary has the unrounded independent analytic area', (oracle) => {
    const row = product(oracle);
    const source = createStandardPartSource(row.catalog, row.size, { ...steelProductOptions(row), length: '100' });
    expect(source.generatorRevision).toBe('3-steel-profile-1');
    const document = buildStandardPartFromSource(source);
    if (document === null) throw new Error(`No generated section for ${oracle.key}`);
    const area = generatedArea(document);
    expect(relativeDifference(area, oracle.exactAreaMm2.value)).toBeLessThan(1e-8);
    process.stdout.write('STEEL_ORACLE_ROW ' + JSON.stringify({ key: oracle.key, areaKind: oracle.areaMm2.kind,
      massKind: oracle.massKgPerM.kind, radiusKind: oracle.rootRadiusMm.kind, lengthKind: oracle.standardLengthsMm.kind,
      printedOrComputedAreaMm2: oracle.areaMm2.value, exactAreaMm2: oracle.exactAreaMm2.value,
      generatedAreaMm2: area, areaRelativeDifference: relativeDifference(area, oracle.exactAreaMm2.value),
      printedAreaRelativeDifference: oracle.areaMm2.kind === 'source' ? relativeDifference(area, oracle.areaMm2.value) : null,
      massKgPerM: oracle.massKgPerM.value,
      pipeFormulaMassKgPerM: oracle.catalog === 'steelPipe' ? oraclePipeMass(oracle).value : null,
      pipeMassRelativeDifference: oracle.catalog === 'steelPipe'
        ? relativeDifference(oraclePipeMass(oracle).value, oracle.massKgPerM.value) : null }) + '\n');
  });

  it.each(STEEL_CATALOG_ORACLE.filter((row) => row.areaMm2.kind === 'source'))(
    '$key printed area separately agrees within 0.05 percent, including printed round-bar precision', (oracle) => {
      expect(oracle.areaMm2.kind).toBe('source');
      expect(relativeDifference(oracle.exactAreaMm2.value, oracle.areaMm2.value)).toBeLessThanOrEqual(5e-4);
    });

  it.each(STEEL_CATALOG_ORACLE.filter((row) => row.grade === 'SS400' && ['flatBar', 'roundBar'].includes(row.catalog)))(
    '$key printed 3-digit mass is within its half-last-digit rounding interval', (oracle) => {
      const mass = oracle.exactAreaMm2.value * ORACLE_DENSITY_KG_PER_M3.value * 1e-6;
      const printed = oracle.massKgPerM.value;
      // A 3-digit printed mass is not an unrounded geometric quantity (e.g. 7.065 → 7.06).
      const halfUnit = 0.5 * 10 ** (Math.floor(Math.log10(printed)) - 2);
      expect(oracle.massKgPerM.kind).toBe('source');
      expect(Math.abs(mass - printed)).toBeLessThanOrEqual(halfUnit + 1e-12);
    });

  it.each(ALL_ORACLE_ROWS.filter((row) => row.grade === 'S45C'))(
    '$key mass is explicitly computed from nominal area and the cited 7.85 g/cm³ convention', (oracle) => {
      expect(oracle.massKgPerM.kind).toBe('computed');
      expect(relativeDifference(oracle.massKgPerM.value, oracle.exactAreaMm2.value * 0.00785)).toBeLessThan(1e-12);
    });

  it.each(STEEL_CATALOG_ORACLE.filter((row) => row.catalog === 'steelPipe'))(
    '$key SGP formula rounded to the source three significant digits is exactly the printed mass', (oracle) => {
      expect(oracle.massKgPerM.kind).toBe('source');
      expect(Number(oraclePipeMass(oracle).value.toPrecision(3))).toBe(oracle.massKgPerM.value);
    });
});

describe('W5 independent SS400 standard dimensions and printed precision', () => {
  it('covers the complete 132-pair grid and 44 recommended diameters without replacing any old key', () => {
    expect(STEEL_SS400_EXPANSION_ORACLE).toHaveLength(166);
    expect(SS400_EXPANSION_SAVED_OPTIONS).toHaveLength(166);
    expect(STEEL_SS400_EXPANSION_ORACLE.filter((row) => row.catalog === 'flatBar')).toHaveLength(127);
    expect(STEEL_SS400_EXPANSION_ORACLE.filter((row) => row.catalog === 'roundBar')).toHaveLength(39);
    const flats = STEEL_PRODUCTS.filter((row) => row.materialGrade === 'SS400' && row.catalog === 'flatBar');
    expect(flats).toHaveLength(132);
    expect(flats.map((row) => row.key).sort()).toEqual(SS400_STANDARD_THICKNESSES.flatMap((thickness) =>
      SS400_STANDARD_WIDTHS.map((width) => `SS400:flatBar:FB ${width}×${thickness}`)).sort());
    const rounds = STEEL_PRODUCTS.filter((row) => row.materialGrade === 'SS400' && row.catalog === 'roundBar');
    expect(rounds).toHaveLength(44);
    expect(rounds.map((row) => row.dimensions?.diameter).sort((a, b) => (a ?? 0) - (b ?? 0)))
      .toEqual(SS400_STANDARD_ROUND_PRINTED.map(([diameter]) => diameter));
    expect(STEEL_SS400_EXPANSION_ORACLE.filter((row) => row.areaMm2.kind === 'source')).toHaveLength(152);
    expect(STEEL_SS400_EXPANSION_ORACLE.filter((row) => row.areaMm2.kind === 'computed')).toHaveLength(14);
  });

  it.each(STEEL_SS400_EXPANSION_ORACLE)('$key retains source dimensions, explicit quantities and no inferred supply length', (oracle) => {
    const row = product(oracle);
    expect(row.condition).toBe('hotRolled-heatTreatmentUnspecified');
    expect(row.materialStandard).toBe('JIS G 3101');
    expect(row.productStandard).toBe(oracle.catalog === 'flatBar' ? 'JIS G 3194' : 'JIS G 3191');
    expect(oracle.standardLengthsMm).toMatchObject({ kind: 'unverified', value: null });
    expect(oracle.exactAreaMm2.kind).toBe('computed');
    expect(row.standardLengthsMm).toEqual([]);
    for (const dimension of Object.values(oracle.dimensions)) {
      expect(dimension.kind).toBe('source');
      expect(dimension.citation.locator).toContain('PDF p6');
      expect(dimension.citation.locator).toContain('表');
    }
    if (oracle.areaMm2.kind === 'computed') {
      expect(oracle.massKgPerM.kind).toBe('computed');
      expect(oracle.massKgPerM.value).toBe(oracle.exactAreaMm2.value * 0.00785);
    } else expect(oracle.massKgPerM.kind).toBe('source');
  });

  it.each(SS400_STANDARD_ROUND_PRINTED)('round diameter %s agrees with both printed strings using the source rounding rule',
    (diameter, printedArea, printedMass) => {
      const tenths = BigInt(diameter * 10);
      // G 3191 table 6 uses 0.7854 d², then 4 significant digits, before rounding mass to 3.
      expect(printedSignificant(tenths ** 2n * 7854n, 1000000n, 4)).toBe(printedArea);
      const [area, scale] = decimalFraction(printedArea);
      const discrepancy = SS400_ROUND_PRINTED_DISCREPANCIES.find(([d]) => d === diameter);
      if (discrepancy !== undefined) expect(printedMass).toBe(discrepancy[1]);
      expect(printedSignificant(area * 785n, scale * 100000n, 3)).toBe(discrepancy?.[2] ?? printedMass);
      const oracle = STEEL_SS400_EXPANSION_ORACLE.find((row) => row.key === `SS400:roundBar:φ${diameter}`);
      if (oracle !== undefined) {
        expect(oracle.areaMm2).toMatchObject({ kind: 'source', value: Number(printedArea) });
        expect(oracle.massKgPerM).toMatchObject({ kind: 'source', value: Number(printedMass) });
        expect(oracle.areaMm2.citation.locator).toContain('PDF p9 表7');
      } else expect([13, 16, 19, 22, 25]).toContain(diameter);
    });

  it('retains the sole source printing discrepancy as two exact strings without changing either value', () => {
    expect(SS400_ROUND_PRINTED_DISCREPANCIES).toEqual([[5.5, '0.186', '0.187']]);
    const row = STEEL_SS400_EXPANSION_ORACLE.find((candidate) => candidate.key === 'SS400:roundBar:φ5.5');
    expect(row?.massKgPerM).toMatchObject({ kind: 'source', value: 0.186 });
    expect(row?.massKgPerM.citation.locator).toContain('PDF p9 表7');
    expect(printedSignificant(2376n * 785n, 100n * 100000n, 3)).toBe('0.187');
  });

  it.each(SS400_EXPANSION_FLAT_PRINTED)('flat %s × %s retains the producer printed significant-digit strings',
    (thickness, width, printedAreaCm2, printedMass, page) => {
      const oracle = STEEL_SS400_EXPANSION_ORACLE.find((row) => row.key === `SS400:flatBar:FB ${width}×${thickness}`);
      if (oracle === undefined) throw new Error('Missing W5 flat oracle');
      const [area, scale] = decimalFraction(printedAreaCm2);
      expect(BigInt(thickness * width * 10) * scale).toBe(area * 1000n);
      const [t, thicknessScale] = decimalFraction(String(thickness));
      expect(printedSignificant(t * BigInt(width) * 785n, thicknessScale * 100000n, 3)).toBe(printedMass);
      expect(oracle.areaMm2.kind).toBe('source');
      expect(oracle.massKgPerM).toMatchObject({ kind: 'source', value: Number(printedMass) });
      expect(oracle.massKgPerM.citation.locator).toContain(`PDF p${page}`);
    });

  it.each(SS400_EXPANSION_FLAT_JIS_PRINTED)('flat %s × %s retains JIS table 6 printing absent from the producer table',
    (thickness, width, printedArea, printedMass) => {
      const oracle = STEEL_SS400_EXPANSION_ORACLE.find((row) => row.key === `SS400:flatBar:FB ${width}×${thickness}`);
      if (oracle === undefined) throw new Error('Missing W5 JIS printed row');
      expect(String(thickness * width)).toBe(printedArea);
      expect(printedSignificant(BigInt(thickness * width) * 785n, 100000n, 3)).toBe(printedMass);
      expect(oracle.areaMm2).toMatchObject({ kind: 'source', value: Number(printedArea) });
      expect(oracle.massKgPerM).toMatchObject({ kind: 'source', value: Number(printedMass) });
      expect(oracle.massKgPerM.citation.locator).toContain('PDF p10 表6');
    });
});
