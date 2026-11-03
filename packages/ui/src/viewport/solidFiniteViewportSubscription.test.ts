import { analyzeCadSolidFinite } from '@pointercad/fem';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { context, finiteSettings, kernel, ownedClient } from '@pointercad/fem/testing/ui-fixtures';
import { solidAnalysisLayersChanged, solidAnalysisLayersOf } from '../solidAnalysis/solidModalViewport.js';
import { resetTestStore } from '../store/testing/createTestStore.js';
import { useAppStore } from '../store/useAppStore.js';

beforeEach(() => { resetTestStore(); useAppStore.getState().toggleStrength(); useAppStore.getState().openSolidFinite(); });
afterEach(() => { resetTestStore(); });

describe('finite field viewport subscription', () => {
  it('redraws the completed result, step and scale changes, then clears on cancellation', async () => {
    const initial = useAppStore.getState(), base = context(), current = { ...base,
      documentId: initial.document.id, revision: initial.completedGeneration };
    const client = ownedClient(), settings = { ...finiteSettings(current), forceFactors: [0, 0], prescribedDisplacementFactors: [0, 0] };
    const outcome = await analyzeCadSolidFinite(client.client, kernel(), () => current, settings);
    if (outcome.kind !== 'result' || initial.solidFiniteSession === null) throw new Error('Synthetic finite fixture failed');
    const updates: ReturnType<typeof solidAnalysisLayersOf>[] = [];
    const unsubscribe = useAppStore.subscribe((next, previous) => {
      if (solidAnalysisLayersChanged(next, previous)) updates.push(solidAnalysisLayersOf(next));
    });
    try {
      useAppStore.setState({ solidFiniteSession: { ...initial.solidFiniteSession, bodyFeatureId: current.body.featureId,
        status: 'complete', result: outcome } });
      expect(updates.at(-1)?.field).not.toBeNull();
      useAppStore.getState().setSolidFiniteFieldView({ step: 2 });
      expect(useAppStore.getState().solidFiniteSession?.fieldView.step).toBe(2);
      expect(updates.at(-1)?.field).not.toBeNull();
      useAppStore.getState().setSolidFiniteFieldView({ quantity: 'xy' });
      expect(updates.at(-1)?.field?.quantity).toBe('xy');
      useAppStore.getState().setSolidFiniteFieldView({ deformationScale: 0 });
      expect(updates.at(-1)?.field?.deformationScale).toBe(0);
      useAppStore.getState().setSolidFiniteFieldView({ deformationScale: 2 });
      expect(updates.at(-1)?.field?.deformationScale).toBe(2);
      useAppStore.getState().cancelSolidFinite();
      expect(updates.at(-1)).toEqual({ field: null, mode: null });
      expect(updates.length).toBeGreaterThanOrEqual(6);
    } finally { unsubscribe(); client.client.dispose(); }
  });

  it('uses session owner and persistent document identity independently', async () => {
    const initial = useAppStore.getState(), base = context(), current = { ...base,
      documentId: initial.document.id, revision: initial.completedGeneration };
    const client = ownedClient(), outcome = await analyzeCadSolidFinite(client.client, kernel(), () => current, finiteSettings(current));
    if (outcome.kind !== 'result' || initial.solidFiniteSession === null) throw new Error('Synthetic finite fixture failed');
    try {
      const session = { ...initial.solidFiniteSession, ownerId: initial.activeDocumentId, bodyFeatureId: current.body.featureId,
        status: 'complete' as const, result: outcome };
      const valid = { ...initial, solidFiniteSession: session, activeDocumentId: 'distinct-session-owner' };
      const paired = { ...valid, solidFiniteSession: { ...session, ownerId: valid.activeDocumentId } };
      expect(paired.activeDocumentId).not.toBe(paired.document.id);
      expect(solidAnalysisLayersOf(paired).field).not.toBeNull();
      expect(solidAnalysisLayersOf({ ...paired, activeDocumentId: 'other-owner' }).field).toBeNull();
      expect(solidAnalysisLayersOf({ ...paired, document: { ...paired.document, id: 'other-document' } }).field).toBeNull();
      expect(solidAnalysisLayersOf({ ...paired, completedGeneration: paired.completedGeneration + 1 }).field).toBeNull();
    } finally { client.client.dispose(); }
  });
});
