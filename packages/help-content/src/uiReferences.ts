/** Resolve labels from the application's own message table before rendering the shared manual source. */
export function resolveHelpUiReferences(source: string, messages: Readonly<Record<string, string>>): string {
  const resolved = source.replace(/\{\{ui:([^{}]*)\}\}/gu, (_token: string, key: string) => {
    if (!/^[a-zA-Z][a-zA-Z0-9_.-]*$/u.test(key) || !Object.hasOwn(messages, key)) {
      throw new Error(`Unknown help UI reference: ${key}`);
    }
    const value = messages[key];
    if (typeof value !== 'string' || value.length === 0 || /[\r\n\0]/u.test(value)) {
      throw new Error(`Invalid help UI label: ${key}`);
    }
    // Labels are literal text; brackets and punctuation cannot introduce Markdown links or blocks.
    return value.replace(/[\\`*_[\]{}()#+.!|>-]/gu, '\\$&');
  });
  if (resolved.includes('{{ui:')) throw new Error('Malformed help UI reference');
  return resolved;
}
