import { useId } from 'react';
import { t, type MessageKey } from '../i18n/t.js';

export const STRENGTH_SELECT_HINTS = {
  'strength.kind': 'strength.guide.kind',
  'strength.section': 'strength.guide.section',
  'strength.support': 'strength.guide.support',
  'strength.thread': 'strength.guide.thread',
  'strength.series': 'strength.guide.series',
  'strength.areaMethod': 'strength.guide.areaMethod',
  'strength.material': 'strength.guide.material',
} as const satisfies Partial<Record<MessageKey, MessageKey>>;

/** Validate DOM values against the actual options; no unchecked string-to-union assertion. */
export function StrengthSelect<T extends string>({ labelKey, value, options, onChange }: {
  readonly labelKey: keyof typeof STRENGTH_SELECT_HINTS; readonly value: T;
  readonly options: readonly { readonly value: T; readonly label: string }[];
  readonly onChange: (value: T) => void;
}): React.JSX.Element {
  const id = useId();
  return <div className="pcad-strength__select">
    <label htmlFor={id}>{t(labelKey)}</label>
    <select id={id} title={t(STRENGTH_SELECT_HINTS[labelKey])} value={value} onChange={event => {
      const option = options.find(candidate => candidate.value === event.target.value);
      if (option !== undefined) onChange(option.value);
    }}>{options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select>
  </div>;
}
