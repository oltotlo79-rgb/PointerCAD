import { buildStandardPartFromSourceWithReason, steelMessageRejectionSourcesForUi } from '@pointercad/model/testing/ui-fixtures';
import { describe, expect, it } from 'vitest';
import assembly from '../i18n/ja/assembly.json';

describe('reasoned generation UI messages', () => {
  it('keeps every reason code, UI template and Japanese fallback in agreement', () => {
    const messages: Record<string, unknown> = assembly;
    const sources = steelMessageRejectionSourcesForUi();
    const codes = new Set<string>();
    for (const source of sources) {
      const rejection = buildStandardPartFromSourceWithReason(source).rejection;
      if (rejection === null) continue;
      codes.add(rejection.code);
      const template = messages[rejection.messageKey];
      if (typeof template !== 'string') throw new Error(`Missing UI template: ${rejection.messageKey}`);
      let message: string = template;
      for (const [key, value] of Object.entries(rejection.parameters)) message = message.split(`{${key}}`).join(value);
      expect(message).toBe(rejection.message);
      expect(message).not.toMatch(/\{[^}]+\}/);
    }
    expect(codes.size).toBe(11);
  });
});
