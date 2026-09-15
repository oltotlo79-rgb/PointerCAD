import { useRef, useState } from 'react';
import { t } from '../i18n/t.js';

export interface MathResultComponentPickerProps {
  readonly axes: readonly number[];
  readonly disabled: boolean;
  readonly onChoose: (indices: readonly number[]) => boolean;
}

/** No component is preselected: the user explicitly chooses one index for every array axis. */
export function MathResultComponentPicker({ axes, disabled, onChoose }: MathResultComponentPickerProps): React.JSX.Element {
  const [values,setValues] = useState<readonly string[]>([]);
  const [failed,setFailed] = useState(false);
  const element = useRef<HTMLFieldSetElement>(null);
  const indices = axes.map((_,axis) => Number(values[axis] ?? ''));
  const canChoose = !disabled && indices.every((value,axis) => Number.isSafeInteger(value) && value >= 1 && value <= axes[axis]);
  function choose(): void {
    if (!canChoose) return;
    const editor = element.current?.closest('.pcad-math-editor');
    const chosen = onChoose(indices);
    setFailed(!chosen);
    if (chosen) queueMicrotask(() => {
      if (editor?.isConnected) editor.querySelector<HTMLElement>('textarea, math-field')?.focus();
    });
  }
  return <fieldset ref={element} className="pcad-math-editor__component" disabled={disabled}
    onKeyDown={event => {
      if (event.key === 'Enter' && !event.nativeEvent.isComposing && event.keyCode !== 229) {
        event.preventDefault(); event.stopPropagation(); choose();
      }
    }}>
    <legend>{t('math.component.title')}</legend>
    <p>{t('math.component.hint')}</p>
    <div className="pcad-math-editor__options">
      {axes.map((size,axis) => <label key={axis}>
        <span>{t('math.component.axis')} {axis+1} (1–{size})</span>
        <input title={`${t('math.component.hint')} (1–${size})`} type="number" min={1} max={size} step={1} value={values[axis] ?? ''}
          aria-label={`${t('math.component.axis')} ${axis+1}`}
          onChange={event => {
            const value = event.currentTarget.value;
            setFailed(false);
            setValues(previous => axes.map((_,index) => index === axis ? value : previous[index] ?? ''));
          }}/>
      </label>)}
    </div>
    {failed ? <p role="alert">{t('math.component.unavailable')}</p> : null}
    <button type="button" className="pcad-button" title={t('math.component.hint')}
      disabled={!canChoose} onClick={choose}>{t('math.component.choose')}</button>
  </fieldset>;
}
