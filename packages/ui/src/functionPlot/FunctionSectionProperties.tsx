import { useState } from 'react';
import { t } from '../i18n/t.js';
import { pendingFieldVariables, referencesPendingVariable } from '../shell/propertyFieldUnits.js';
import { useAppStore } from '../store/useAppStore.js';
import { readFunctionSection } from './functionSectionEdit.js';
import { FunctionSectionDialog } from './FunctionSectionDialog.js';

export function FunctionSectionProperties({ featureId }: { readonly featureId: string }): React.JSX.Element | null {
  const document = useAppStore(state => state.document);
  const pending = useAppStore(pendingFieldVariables);
  const [open, setOpen] = useState(false);
  const address = { sketchId: document.activeSketchId, featureId };
  const section = readFunctionSection(document, address);
  if (!section) return null;
  const waiting = referencesPendingVariable(section.coordinate.source, pending, section.coordinate.mathDefinition);
  return <section className="pcad-section" data-help-topic="function-surface">
    <h3 className="pcad-section__title">{t('functionSection.coordinate')}</h3>
    <p>{section.parent.name}: {section.axis} = {waiting ? t('mathGeometry.status.pending') : `${section.coordinate.value} mm`}</p>
    <button title={t('controlGuide.button.sectionEdit')} type="button" onClick={() => setOpen(true)}>{t('functionSection.edit')}</button>
    {open ? <FunctionSectionDialog parentId={section.parent.id} edit={address} onClose={() => setOpen(false)} /> : null}
  </section>;
}
