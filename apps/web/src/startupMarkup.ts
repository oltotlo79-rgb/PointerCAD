const KEYS = ['loading', 'hint', 'failed', 'retry'] as const;

/** Build-time labels are embedded in HTML so recovery never needs a message chunk. */
export function renderStartupMessages(html: string, labels: unknown): string {
  if (typeof labels !== 'object' || labels === null || Array.isArray(labels)) throw new Error('Invalid startup messages');
  const entries = new Map(Object.entries(labels));
  for (const name of KEYS) {
    const value: unknown = entries.get(`bootstrap.${name}`);
    if (typeof value !== 'string' || value.trim() === '' || !html.includes(`{{startup:${name}}}`)) {
      throw new Error(`Missing startup message: ${name}`);
    }
    const escaped = value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;').replaceAll("'", '&#39;');
    html = html.replaceAll(`{{startup:${name}}}`, escaped);
  }
  if (html.includes('{{startup:')) throw new Error('Unknown startup message');
  return html;
}
