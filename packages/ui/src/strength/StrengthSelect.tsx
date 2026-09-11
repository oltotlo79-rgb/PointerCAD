import { useId } from 'react';
import { t, type MessageKey } from '../i18n/t.js';

/** Validate DOM values against the actual options; no unchecked string-to-union assertion. */
export function StrengthSelect<T extends string>({ labelKey, value, options, onChange }: {
  readonly labelKey: MessageKey; readonly value: T;
  readonly options: readonly { readonly value: T; readonly label: string }[];
  readonly onChange: (value: T) => void;
}): React.JSX.Element {
  const id = useId();
  return <div className="pcad-strength__select">
    <label htmlFor={id}>{t(labelKey)}</label>
    <select id={id} value={value} onChange={event => {
      const option = options.find(candidate => candidate.value === event.target.value);
      if (option !== undefined) onChange(option.value);
    }}>{options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select>
  </div>;
}
