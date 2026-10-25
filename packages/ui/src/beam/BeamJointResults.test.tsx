import { beforeEach, describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { decodeBeamJointContact } from '@pointercad/fem';
import { jointTestInput, jointTestRaw } from '../../../fem/src/beamJointContact.testSupport.js';
import { resetTestStore } from '../store/testing/createTestStore.js';
import { t } from '../i18n/t.js';
import { BeamJointResults } from './BeamJointResults.js';

beforeEach(resetTestStore);
describe('mixed joint view of one common decoded state', () => {
  it('shows both independent one-third branch forces, energy and common nodal motion', () => {
    // Analytic fixture only; actual native mixed-result view remains a separate required proof.
    const result = decodeBeamJointContact(jointTestRaw(), jointTestInput(), 'a'.repeat(64));
    const html = renderToStaticMarkup(<BeamJointResults result={result} view={{ state: 0 }} />);
    const force = 1000/3, motion = 1000/(3*210e6);
    const rows = html.split('<tr>');
    const exactRow = (start: string): string => {
      const matching = rows.filter(row => row.startsWith(start));
      expect(matching).toHaveLength(1);
      return matching[0];
    };
    const values = (row: string, unit: string, quantity?: string): number[] => {
      const cells = [...row.matchAll(/<td([^>]*)>/gu)].map(match => match[1])
        .filter(attributes => attributes.includes(`data-unit="${unit}"`));
      return cells.map(attributes => {
        if (quantity !== undefined) expect(attributes).toContain(`data-quantity="${quantity}"`);
        const value = attributes.match(/data-value="([^"]+)"/u);
        expect(value).not.toBeNull();
        const number = Number(value?.[1]);
        expect(Number.isFinite(number)).toBe(true);
        return number;
      });
    };
    const roundoffEqual = (actual: number, expected: number): void => {
      // Four Gauss contributions and their products need a small double-roundoff bound,
      // not equality of independently evaluated decimal strings or a solver tolerance.
      expect(Math.abs(actual-expected)).toBeLessThanOrEqual(16*Number.EPSILON*Math.abs(expected));
    };
    expect(html).toContain('data-testid="beam-joint-bolt-results"');
    expect(html).toContain('<th>X</th><th>Y</th><th>Z</th>');
    const bolt = exactRow('<th>bolt</th>');
    const boltForce = values(bolt, 'N'), extension = values(bolt, 'm');
    expect(boltForce).toHaveLength(1);
    expect(extension).toHaveLength(1);
    roundoffEqual(boltForce[0], force);
    roundoffEqual(extension[0], motion);
    const first = values(exactRow(`<th>weld</th><td>${t('beam.weldForceA')}</td>`), 'N', 'forceOnAN');
    const second = values(exactRow(`<th>weld</th><td>${t('beam.weldForceB')}</td>`), 'N', 'forceOnBN');
    expect(first).toHaveLength(3);
    expect(second).toHaveLength(3);
    roundoffEqual(first[0], force);
    roundoffEqual(second[0], -force);
    expect(first.slice(1)).toEqual([0, 0]);
    expect(second.slice(1)).toEqual([0, 0]);
    roundoffEqual(-second[0], boltForce[0]);
    const energy = [...html.matchAll(/<p data-unit="J" data-value="([^"]+)">weld:/gu)];
    expect(energy).toHaveLength(1);
    const storedEnergy = Number(energy[0][1]);
    expect(Number.isFinite(storedEnergy)).toBe(true);
    roundoffEqual(storedEnergy, force*motion/2);
    const displacement = values(exactRow(`<th>2</th><td>${t('beam.displacement')}</td>`), 'm');
    expect(displacement).toHaveLength(3);
    roundoffEqual(displacement[0], motion);
    expect(displacement.slice(1)).toEqual([0, 0]);
    roundoffEqual(displacement[0], extension[0]);
    expect(html.match(/data-testid="beam-weld-layer-results"/gu)).toHaveLength(1);
    expect(html.split(t('beam.contactState'))).toHaveLength(2);
  });
});
