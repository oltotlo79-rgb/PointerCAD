/** Assemble a new persisted element identity; existing saved IDs are never inputs. */
export function createDocumentElementId(prefix = '', entropy: () => string = () => crypto.randomUUID()): string {
  const value = entropy();
  return prefix === '' ? value : `${prefix}${value}`;
}
