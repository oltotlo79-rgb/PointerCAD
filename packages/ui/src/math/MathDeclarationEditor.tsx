import { useId, useState } from 'react';
import { MATH_DECLARATION_LIMITS, MATH_INPUT_LIMITS, type MathDeclaration, type MathDeclaredType } from '@pointercad/expression/math/contracts';
import type { MathEditorController } from './MathEditorController.js';
import { t } from '../i18n/t.js';

const TYPES: readonly MathDeclaredType[] = ['real', 'complex', 'integer', 'natural', 'rational',
  'boolean', 'set', 'vector', 'matrix', 'function', 'symbolic'];

/** Draft controls commit into the one editor session; closing the dialog changes no document. */
export function MathDeclarationEditor(props: {
  readonly controller: MathEditorController;
  readonly declarations: readonly MathDeclaration[];
  readonly disabled: boolean;
}): React.JSX.Element {
  const id = useId(), [problem, setProblem] = useState<string | null>(null), [renaming, setRenaming] = useState(false);
  const change = (values: readonly MathDeclaration[]): boolean => {
    try { props.controller.setDeclarations(values); setProblem(null); return true; }
    catch (error) { setProblem(error instanceof Error ? error.message : t('math.declaration.invalid')); return false; }
  };
  const submit = (form: HTMLFormElement, existing?: MathDeclaration) => {
    const data = new FormData(form), label = existing?.label ?? data.get('label'), meaning = data.get('meaning');
    const type = TYPES.find(value => value === data.get('type'));
    if (typeof label !== 'string' || typeof meaning !== 'string' || type === undefined) {
      setProblem(t('math.declaration.invalid')); return;
    }
    const supplied = data.get('value-source'), valueSource = typeof supplied === 'string' ? supplied.trim() : '';
    const declaration = { id: existing?.id ?? `symbol:${crypto.randomUUID()}`, label, meaning, type,
      ...(valueSource === '' ? {} : { valueSource }) };
    if (change(existing === undefined ? [...props.declarations, declaration]
      : props.declarations.map(value => value.id === existing.id ? declaration : value)) && existing === undefined) form.reset();
  };
  const rename = async (form: HTMLFormElement, existing: MathDeclaration): Promise<void> => {
    const label = new FormData(form).get('new-label');
    if (typeof label !== 'string' || props.disabled || renaming) return;
    setRenaming(true); setProblem(null);
    try {
      if (await props.controller.renameDeclaration(existing.id, label)) form.reset();
      else if (props.controller.isCurrent()) setProblem(t('math.declaration.renameFailed'));
    } catch { setProblem(t('math.declaration.renameFailed')); }
    finally { setRenaming(false); }
  };
  const fields = (existing?: MathDeclaration) => <>
    <label>{t('math.declaration.name')}<input name="label" title={t('math.declaration.guide.name')} maxLength={128} required
      {...(existing === undefined ? { defaultValue: '' } : { value: existing.label, readOnly: true })}
      autoComplete="off" spellCheck={false}/></label>
    <label>{t('math.declaration.meaning')}<input name="meaning" title={t('math.declaration.guide.meaning')} maxLength={MATH_DECLARATION_LIMITS.meaningLength}
      required defaultValue={existing?.meaning ?? ''} autoComplete="off"/></label>
    <label>{t('math.declaration.type')}<select name="type" title={t('math.declaration.guide.type')} defaultValue={existing?.type ?? 'real'}>
      {TYPES.map(value => <option key={value} value={value}>{t(`math.declaration.type.${value}`)}</option>)}
    </select></label>
    <label>{t('math.declaration.value')}<input name="value-source" title={t('math.declaration.guide.value')}
      maxLength={MATH_INPUT_LIMITS.sourceCodeUnits} defaultValue={existing?.valueSource ?? ''}
      autoComplete="off" spellCheck={false}/></label>
  </>;
  return <details className="pcad-math-declarations">
    <summary id={`${id}-title`}>{t('math.declaration.title')}</summary>
    <p>{t('math.declaration.hint')}</p>
    {problem === null ? null : <p role="alert">{problem}</p>}
    <ul>{props.declarations.map(declaration => <li key={declaration.id}>
      <form aria-label={`${t('math.declaration.edit')} ${declaration.label}`} onSubmit={event => {
        event.preventDefault(); if (!props.disabled) submit(event.currentTarget, declaration);
      }}>
        <fieldset disabled={props.disabled || renaming}>{fields(declaration)}
          <button type="submit" className="pcad-button" title={t('math.declaration.update')}>{t('math.declaration.update')}</button>
          <button type="button" className="pcad-button" title={t('math.declaration.remove')} onClick={() => {
            change(props.declarations.filter(value => value.id !== declaration.id));
          }}>{t('math.declaration.remove')}</button>
        </fieldset>
      </form>
      <form aria-label={`${t('math.declaration.rename')} ${declaration.label}`} onSubmit={event => {
        event.preventDefault(); void rename(event.currentTarget, declaration);
      }}>
        <fieldset disabled={props.disabled || renaming}>
          <label>{t('math.declaration.newName')}<input name="new-label" required maxLength={128}
            title={t('math.declaration.renameGuide')} autoComplete="off" spellCheck={false}/></label>
          <button type="submit" className="pcad-button" title={t('math.declaration.renameGuide')}>{t('math.declaration.rename')}</button>
        </fieldset>
      </form>
    </li>)}</ul>
    <form aria-label={t('math.declaration.add')} onSubmit={event => {
      event.preventDefault(); if (!props.disabled) submit(event.currentTarget);
    }}>
      <fieldset disabled={props.disabled || renaming || props.declarations.length >= MATH_DECLARATION_LIMITS.count}>
        {fields()}<button type="submit" className="pcad-button" title={t('math.declaration.add')}>{t('math.declaration.add')}</button>
      </fieldset>
    </form>
  </details>;
}
