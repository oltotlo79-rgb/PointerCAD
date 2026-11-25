import { useState } from 'react';
import type { ImportedBrepInspection, ImportedSolidFeature } from '@pointercad/model';
import { t, type MessageKey } from '../i18n/t.js';
import { featureIdOf } from '../sketch/featureSummary.js';
import type { AppState } from '../store/appState.js';
import { beginDocumentRequest } from '../store/documentRequest.js';
import { useAppStore } from '../store/useAppStore.js';

const BODY_KIND_KEYS = {
  solid: 'propertyPanel.importedInspectionSolid',
  shell: 'propertyPanel.importedInspectionShell',
  mixed: 'propertyPanel.importedInspectionMixed',
} as const satisfies Record<Extract<ImportedBrepInspection, { kind: 'checked' }>['bodyKind'], MessageKey>;

function messageOf(outcome: ImportedBrepInspection | null): string {
  if (outcome === null) return t('propertyPanel.importedInspectionPending');
  switch (outcome.kind) {
    case 'empty': return t('propertyPanel.importedInspectionEmpty');
    case 'unreadable': return t('propertyPanel.importedInspectionUnreadable');
    case 'failed': return t('propertyPanel.importedInspectionFailed');
    case 'checked':
      return t(outcome.valid ? 'propertyPanel.importedInspectionValid' : 'propertyPanel.importedInspectionInvalid')
        .replace('{kind}', () => t(BODY_KIND_KEYS[outcome.bodyKind]));
  }
}

interface Inspection {
  readonly isCurrent: (state: AppState) => boolean;
  readonly outcome: ImportedBrepInspection | null;
}

export function ImportedShapeInspection({ feature }: { readonly feature: ImportedSolidFeature }): React.JSX.Element {
  const [inspection, setInspection] = useState<Inspection | null>(null);
  const current = useAppStore(state => inspection?.isCurrent(state) === true) ? inspection : null;
  const available = useAppStore(state => state.exchangeKernel?.inspectImportedBrep !== undefined);
  const pending = current !== null && current.outcome === null;

  const inspect = async (): Promise<void> => {
    const state = useAppStore.getState();
    const { exchangeKernel, selection } = state;
    if (exchangeKernel?.inspectImportedBrep === undefined || !state.document.solids.includes(feature)
      || selection.length === 0 || selection.some(id => featureIdOf(id) !== feature.id)) return;
    const request = beginDocumentRequest('inspect-imported-brep', state);
    const started: Inspection = {
      isCurrent: next => request.isCurrent() && next.selection === selection && next.exchangeKernel === exchangeKernel,
      outcome: null,
    };
    setInspection(started);
    const bytes = state.importedShapes.get(feature.shapeRef);
    let outcome: ImportedBrepInspection = { kind: 'unreadable' };
    if (bytes !== undefined) {
      try {
        outcome = await exchangeKernel.inspectImportedBrep(bytes);
      } catch {
        outcome = { kind: 'failed' };
      }
    }
    const observed = started.isCurrent(useAppStore.getState()) ? { ...started, outcome } : null;
    setInspection(previous => previous === started ? observed : previous);
  };

  return <>
    <button type="button" className="pcad-button" disabled={!available || pending} title={t('propertyPanel.inspectImportedShapeGuide')} onClick={() => { void inspect(); }}>
      {t('propertyPanel.inspectImportedShape')}
    </button>
    <span role="status">{current === null ? '' : messageOf(current.outcome)}</span>
  </>;
}
