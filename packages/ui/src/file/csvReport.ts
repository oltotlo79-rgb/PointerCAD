/** Existing steel-stock CSV quoting and spreadsheet text protection. */
function cell(value: string | number): string {
  let text = String(value);
  if (typeof value === 'string' && (/^[=+@'\-\p{White_Space}\p{Cc}\p{Cf}]/u.test(text)
    || /^[＝＋－＠−]/u.test(text) || text.startsWith('text:'))) text = `text:${text}`;
  return /[",\r\n]/u.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function serializeCsvReport(rows: readonly (readonly (string | number)[])[]): Uint8Array {
  return new TextEncoder().encode(String.fromCharCode(0xfeff) + rows.map(row => row.map(cell).join(',')).join('\r\n') + '\r\n');
}
