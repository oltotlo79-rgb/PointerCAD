import React, { Children, isValidElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { decodeBeamJointInitialStrain } from '@pointercad/fem';
import { readCadJointInitialStrain } from '@pointercad/model/beam-analysis';
import { initialStrainTestInput, initialStrainTestRaw } from '../../../fem/src/beamJointInitialStrain.testSupport.js';
import { cadJointContactFixture } from '../../../model/src/analysis/cadJointContact.testSupport.js';
import { resetTestStore } from '../store/testing/createTestStore.js';
import { t } from '../i18n/t.js';
import { useAppStore } from '../store/useAppStore.js';
import { beamUiFixture, requireBeamSession } from './beam.testSupport.js';
import { BeamJointInitialStrainDefinitions, BeamJointInitialStrainResults } from './BeamJointInitialStrain.js';
import { beamDisplayNumber } from './BeamResults.js';

beforeEach(() => { resetTestStore(); vi.spyOn(React, 'useSyncExternalStore').mockImplementation((_subscribe, getSnapshot) => getSnapshot()); });
afterEach(() => { vi.restoreAllMocks(); resetTestStore(); });

describe('explicit initial-strain editor and result view', () => {
  it('shows the nonzero initial tension and distinguishes geometric from elastic extension at zero external load', () => {
    // Independent analytic fixture; actual native initial-strain display proof remains required.
    const result = decodeBeamJointInitialStrain(initialStrainTestRaw(), initialStrainTestInput(), 'a'.repeat(64));
    const bolt = result.states[1].bolts[0];
    expect(bolt.axialForceN).toBeCloseTo(140, 9);
    expect(bolt.extensionM).toBeLessThan(0);
    expect(bolt.elasticExtensionM).toBeGreaterThan(0);
    const html = renderToStaticMarkup(<BeamJointInitialStrainResults result={result} view={{ state: 1 }} />);
    expect(html).toContain(`data-unit="N" data-value="${bolt.axialForceN}">${beamDisplayNumber(bolt.axialForceN)}<`);
    expect(html).toContain(`data-quantity="extension" data-unit="m" data-value="${bolt.extensionM}">${beamDisplayNumber(bolt.extensionM*1000)}<`);
    expect(html).toContain(`data-quantity="elastic-extension" data-unit="m" data-value="${bolt.elasticExtensionM}">${beamDisplayNumber(bolt.elasticExtensionM*1000)}<`);
    expect(html).toContain(`data-unit="J" data-value="${bolt.elasticEnergyJ}">${beamDisplayNumber(bolt.elasticEnergyJ)}<`);
    expect(html.split(t('beam.contactState'))).toHaveLength(2);
    expect(html).toContain(t('beam.initialStrainScope'));
  });
  it('enables only explicit per-shank empty assumptions and invalidates review once through the rendered control', () => {
    const f = beamUiFixture(), cad = cadJointContactFixture(), runner = { run: vi.fn(), cancel: vi.fn() };
    useAppStore.setState({ ...f.state, beamRunner: runner, beamSession: { ...f.session, analysisType: 'contact',
      axialBolts: cad.axialBolts.bolts, weldLayers: cad.associations.welds, reviewed: f.source } });
    interface Props { readonly children?: ReactNode; readonly type?: string; readonly disabled?: boolean;
      readonly onChange?: (event: { readonly target: { readonly checked: boolean } }) => void }
    const controls: Props[] = [];
    function walk(node: ReactNode): void {
      Children.forEach(node, child => {
        if (!isValidElement<Props>(child)) return;
        if (child.type === 'input' && child.props.type === 'checkbox') controls.push(child.props);
        walk(child.props.children);
      });
    }
    function Probe(): null { walk(BeamJointInitialStrainDefinitions({ session: requireBeamSession() })); return null; }
    renderToStaticMarkup(React.createElement(Probe));
    expect(controls).toHaveLength(1);
    expect(controls[0].disabled).toBe(false);
    controls[0].onChange?.({ target: { checked: true } });
    const current = requireBeamSession();
    expect(current.initialStrain?.shortenings.map(row => row.boltId)).toEqual(['mixed-shank']);
    expect(current.initialStrain?.shortenings[0].shorteningMm).toBeNaN();
    expect(() => readCadJointInitialStrain(current.initialStrain, ['mixed-shank'])).toThrow();
    expect(current.reviewed).toBeNull();
    expect(runner.cancel).toHaveBeenCalledOnce();
    expect(current.axialBolts).toEqual(cad.axialBolts.bolts);
    expect(current.weldLayers).toEqual(cad.associations.welds);
  });
});
