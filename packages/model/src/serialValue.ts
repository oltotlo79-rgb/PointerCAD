/** 最大の既存連番の次を返す。番号の読み方は保存済みの各形式に合わせて受け取る。 */
export function nextSerialValue(
  usedValues: Iterable<string>,
  prefix: string,
  readSerial: (value: string, prefix: string) => number,
): string {
  let max = 0;
  for (const value of usedValues) {
    const serial = readSerial(value, prefix);
    if (serial > max) max = serial;
  }
  return `${prefix}${String(max + 1)}`;
}

/** 外観・選択セット・下絵が従来受け入れてきた Number による整数接尾辞。 */
export function integerSerial(value: string, prefix: string): number {
  if (!value.startsWith(prefix)) return 0;
  const serial = Number(value.slice(prefix.length));
  return Number.isInteger(serial) ? serial : 0;
}
