import type { ThickenFeature } from '@pointercad/model';

export function isThickenSide(value: string): value is ThickenFeature['side'] {
  return value === 'normal' || value === 'reverse' || value === 'both';
}

export function thickenSideChoice(value: ThickenFeature['side'] = 'normal') {
  return {
    key: 'thickenSide', labelKey: 'surfaceBody.side', value,
    options: [
      { value: 'normal', labelKey: 'surfaceBody.normal' },
      { value: 'reverse', labelKey: 'surfaceBody.reverse' },
      { value: 'both', labelKey: 'surfaceBody.both' },
    ],
  } as const;
}
