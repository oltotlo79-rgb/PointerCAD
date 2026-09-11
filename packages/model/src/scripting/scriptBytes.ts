/** Count before allocating an encoded copy; lone surrogates follow TextEncoder replacement. */
export function scriptUtf8Bytes(value: string, maximum: number): number | null {
  if (value.length > maximum) return null;
  let bytes = 0;
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code < 0x80) bytes++;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && index + 1 < value.length
      && value.charCodeAt(index + 1) >= 0xdc00 && value.charCodeAt(index + 1) <= 0xdfff) {
      bytes += 4; index++;
    } else bytes += 3;
    if (bytes > maximum) return null;
  }
  return bytes;
}
