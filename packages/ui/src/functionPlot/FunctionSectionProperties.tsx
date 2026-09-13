import { useState } from 'react';
import { t } from '../i18n/t.js';
import { useAppStore } from '../store/useAppStore.js';
import { readFunctionSection } from './functionSectionEdit.js';
import { FunctionSectionDialog } from './FunctionSectionDialog.js';

export function FunctionSectionProperties({ featureId }: { readonly featureId: string }): React.JSX.Element | null {
  const document = useAppStore(state => state.document);
  const [open, setOpen] = useState(false);
  const address = { sketchId: document.activeSketchId, featureId };
  const section = readFunctionSection(document, address);
  if (!section) return null;
  return <section className="pcad-section" data-help-topic="function-surface">
    <h3 className="pcad-section__title">{t('functionSection.coordinate')}</h3>
    <p>{section.parent.name}: {section.axis} = {section.coordinate.value} mm</p>
    <button type="button" onClick={() => setOpen(true)}>{t('functionSection.edit')}</button>
    {open ? <FunctionSectionDialog parentId={section.parent.id} edit={address} onClose={() => setOpen(false)} /> : null}
  </section>;
}
