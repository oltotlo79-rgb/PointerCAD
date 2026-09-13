import { useId, useRef, useState } from 'react';
import type { FunctionDefinition, Parameter } from '@pointercad/model';
import { t } from '../i18n/t.js';
import { useAppStore } from '../store/useAppStore.js';
import {
  applyFunctionCoefficientSlider, coefficientSliderRange, functionCoefficientParameters, initialCoefficientSliderRange,
} from './functionCoefficientSlider.js';
import './functionCoefficientSliders.css';

function CoefficientSlider({ parameter, documentId, documentVersion }: {
  readonly parameter: Parameter; readonly documentId: string; readonly documentVersion: number;
}): React.JSX.Element {
  const id = useId();
  const initial = initialCoefficientSliderRange(parameter.value.value);
  const [minimum, setMinimum] = useState(String(initial.minimum));
  const [maximum, setMaximum] = useState(String(initial.maximum));
  const [message, setMessage] = useState<string | null>(null);
  const gesture = useRef<string | null>(null);
  const range = coefficientSliderRange(minimum, maximum);
  const value = parameter.value.value;
  const enabled = range !== null && Number.isFinite(value) && value >= range.minimum && value <= range.maximum;
  const begin = () => { gesture.current ??= crypto.randomUUID(); };
  const finish = () => { gesture.current = null; };
  const change = (next: number) => {
    if (range === null || parameter.mathId === undefined) return;
    begin();
    const result = applyFunctionCoefficientSlider({ documentId, documentVersion, coefficientId: parameter.mathId,
      gesture: gesture.current ?? '', value: next, range });
    setMessage(result.ok ? null : result.message);
  };
  return <fieldset className="pcad-function-coefficient">
    <legend>{parameter.name}</legend>
    <p>{parameter.value.source}{parameter.unit === 'none' ? '' : parameter.unit === 'degree' ? ' °' : ' mm'}</p>
    <div className="pcad-function-coefficient__bounds">
      <label htmlFor={`${id}-minimum`}>{t('functionCoefficient.minimum')}
        <input id={`${id}-minimum`} type="number" step="any" value={minimum}
          onChange={event => { finish(); setMinimum(event.currentTarget.value); }} />
      </label>
      <label htmlFor={`${id}-maximum`}>{t('functionCoefficient.maximum')}
        <input id={`${id}-maximum`} type="number" step="any" value={maximum}
          onChange={event => { finish(); setMaximum(event.currentTarget.value); }} />
      </label>
    </div>
    <label htmlFor={`${id}-value`}>{t('functionCoefficient.value')}: {parameter.name}</label>
    <input id={`${id}-value`} className="pcad-function-coefficient__range" type="range" step="any"
      min={range?.minimum ?? -1} max={range?.maximum ?? 1} value={Number.isFinite(value) ? value : 0}
      disabled={!enabled} aria-describedby={`${id}-status`}
      onPointerDown={event => { begin(); event.currentTarget.setPointerCapture(event.pointerId); }}
      onPointerUp={finish} onPointerCancel={finish} onLostPointerCapture={finish}
      onKeyDown={event => { if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown'].includes(event.key)) begin(); }}
      onKeyUp={finish} onBlur={finish} onChange={event => change(event.currentTarget.valueAsNumber)} />
    <p id={`${id}-status`} role={message === null && enabled ? undefined : 'status'}>
      {message ?? (enabled ? t('functionCoefficient.gestureHint') : t('functionCoefficient.invalidRange'))}
    </p>
  </fieldset>;
}

export function FunctionCoefficientSliders({ definition }: { readonly definition: FunctionDefinition }): React.JSX.Element | null {
  const document = useAppStore(state => state.document);
  const documentVersion = useAppStore(state => state.documentVersion);
  const parameters = functionCoefficientParameters(document, definition);
  if (parameters.length === 0) return null;
  return <section aria-label={t('functionCoefficient.title')}>
    <h4>{t('functionCoefficient.title')}</h4>
    <p>{t('functionCoefficient.replacesExpression')}</p>
    {parameters.map(parameter => <CoefficientSlider key={`${documentVersion}:${parameter.mathId}`}
      parameter={parameter} documentId={document.id} documentVersion={documentVersion} />)}
  </section>;
}
