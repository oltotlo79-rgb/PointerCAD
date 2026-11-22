import { useEffect, useId, useRef } from 'react';
import { ASSEMBLY_EXAMPLES, DRAWING_EXAMPLES, PART_EXAMPLES, type PartExampleId } from '@pointercad/model';
import { t } from '../i18n/t.js';
import { rememberDialogOpener } from '../shell/dialogFocus.js';
import { DraggableWindowTitle } from '../sketch/DraggableWindowTitle.js';
import { useAppStore } from '../store/useAppStore.js';
import { ASSEMBLY_EXAMPLE_ENTRIES, DRAWING_EXAMPLE_ENTRIES } from './documentExampleEntries.js';
import { openAssemblyExample, openDrawingExample } from './openDocumentExample.js';
import { openPartExample } from './openPartExample.js';
import { PART_EXAMPLE_ENTRIES } from './partExampleEntries.js';
import './examplesDialog.css';

/**
 * 作例の一覧(J-06b)。行ごとに名前・一言・使う機能と、開く・説明の釦を並べる。
 * 開く時は先に窓を閉じてから新規と同じ確認を通す(確認の窓がこの窓の裏に隠れないように)。
 */
export function ExamplesDialog({ onClose, open = openPartExample }: {
  readonly onClose: () => void;
  readonly open?: (id: PartExampleId) => Promise<void>;
}): React.JSX.Element {
  const element = useRef<HTMLDialogElement>(null), first = useRef<HTMLButtonElement>(null);
  const titleId = useId(), introId = useId();
  useEffect(() => {
    // ファイルの一覧から開いた時は項目が消えるので、一覧を開いた釦を戻り先の代わりにする(C-03)。
    const dialog = element.current, restoreFocus = rememberDialogOpener(dialog);
    dialog?.showModal(); first.current?.focus();
    return () => { dialog?.close(); restoreFocus(); };
  }, []);
  const groups = [
    { heading: 'examples.group.part', rows: PART_EXAMPLES.map(({ id }) => ({
      id, entry: PART_EXAMPLE_ENTRIES[id], open: () => open(id),
    })) },
    { heading: 'examples.group.assembly', rows: ASSEMBLY_EXAMPLES.map(example => ({
      id: example.id, entry: ASSEMBLY_EXAMPLE_ENTRIES[example.id], open: () => openAssemblyExample(example),
    })) },
    { heading: 'examples.group.drawing', rows: DRAWING_EXAMPLES.map(example => ({
      id: example.id, entry: DRAWING_EXAMPLE_ENTRIES[example.id], open: () => openDrawingExample(example),
    })) },
  ] as const;
  return <dialog ref={element} className="pcad-examples" aria-labelledby={titleId} aria-describedby={introId} data-help-topic="tutorial"
    onCancel={event => { event.preventDefault(); onClose(); }}
    onKeyDown={event => {
      if (event.key === 'F1') { event.preventDefault(); event.stopPropagation(); useAppStore.getState().openHelpTopic('tutorial'); }
    }}>
    <DraggableWindowTitle as="h2" id={titleId}>{t('examples.title')}</DraggableWindowTitle>
    <p id={introId}>{t('examples.intro')}</p>
    {groups.map(({ heading, rows }, groupIndex) => <section key={heading} aria-labelledby={`${titleId}-${heading}`}>
      <h3 id={`${titleId}-${heading}`}>{t(heading)}</h3>
      <ul className="pcad-examples__list">
        {rows.map(({ id, entry, open: openExample }, index) => <li key={id} className="pcad-examples__item" data-example-id={id}>
          <div className="pcad-examples__text">
            <strong>{t(entry.nameKey)}</strong>
            <p>{t(entry.summaryKey)}</p>
            <p className="pcad-examples__features">{t('examples.featuresLabel')}{t(entry.featuresKey)}</p>
          </div>
          <div className="pcad-examples__actions">
            <button type="button" ref={groupIndex === 0 && index === 0 ? first : undefined} title={t('examples.openHint')}
              aria-label={`${t('examples.open')} ${t(entry.nameKey)}`}
              onClick={() => { onClose(); void openExample(); }}>{t('examples.open')}</button>
            <button type="button" title={t('examples.helpHint')} aria-label={`${t('examples.help')} ${t(entry.nameKey)}`}
              onClick={() => useAppStore.getState().openHelpTopic(entry.helpTopic)}>{t('examples.help')}</button>
          </div>
        </li>)}
      </ul>
    </section>)}
    <footer>
      <button type="button" title={t('examples.close')} onClick={onClose}>{t('examples.close')}</button>
    </footer>
  </dialog>;
}
