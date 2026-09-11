/** R10: ZIPの偶発的破損を検出するCRC-32。真正性の署名ではない。 */
const table = Uint32Array.from({ length: 256 }, (_, byte) => {
  let value = byte;
  for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ ((value & 1) === 0 ? 0 : 0xedb88320);
  return value >>> 0;
});
export function zipCrc32(bytes: Uint8Array): number {
  let value = 0xffffffff;
  for (const byte of bytes) value = (value >>> 8) ^ table[(value ^ byte) & 0xff];
  return (value ^ 0xffffffff) >>> 0;
}
