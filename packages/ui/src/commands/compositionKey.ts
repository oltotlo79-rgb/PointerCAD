/** Keys owned by an input method, including browsers without isComposing on its final key. */
export function isCompositionKey(event: Pick<KeyboardEvent, 'isComposing' | 'keyCode' | 'key'>): boolean {
  return event.isComposing || event.keyCode === 229 || event.key === 'Process';
}
