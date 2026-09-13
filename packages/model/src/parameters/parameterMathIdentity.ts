import type { Parameter } from './types.js';

/** Names can be renamed; a persisted mathematical coefficient is identified independently. */
export function isParameterMathId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9:._-]{0,127}$/u.test(value);
}

/** Pure migration for the first math edit. The caller applies it with the accepted expression atomically. */
export function ensureParameterMathIds(parameters: readonly Parameter[], minimumSerial = 0): readonly Parameter[] {
  return allocateParameterMathIds(parameters, minimumSerial).parameters;
}

/** The document persists nextSerial even when the highest numbered coefficient is deleted. */
export function allocateParameterMathIds(parameters: readonly Parameter[], minimumSerial = 0): {
  readonly parameters: readonly Parameter[]; readonly nextSerial: number;
} {
  if (!Number.isSafeInteger(minimumSerial) || minimumSerial < 0) throw new Error('係数の参照番号が不正です。');
  const occupied = new Set<string>();
  let serial = minimumSerial;
  for (const parameter of parameters) {
    if (parameter.mathId === undefined) continue;
    if (!isParameterMathId(parameter.mathId) || occupied.has(parameter.mathId)) throw new Error('係数の参照先が不正または重複しています。');
    occupied.add(parameter.mathId);
    const match = /^coefficient:([1-9][0-9]*)$/u.exec(parameter.mathId);
    if (match !== null) {
      const number = Number(match[1]);
      if (!Number.isSafeInteger(number)) throw new Error('係数の参照番号が上限を超えています。');
      serial = Math.max(serial, number);
    }
  }
  let changed = false;
  const result = parameters.map(parameter => {
    if (parameter.mathId !== undefined) return parameter;
    if (serial >= Number.MAX_SAFE_INTEGER) throw new Error('係数の参照番号が上限に達しました。');
    serial += 1;
    changed = true;
    return { ...parameter, mathId: `coefficient:${serial}` };
  });
  return { parameters: changed ? result : parameters, nextSerial: serial };
}
