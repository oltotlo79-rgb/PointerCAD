import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { t } from '../i18n/t.js';
import { TutorialWelcome } from './TutorialPanel.js';

it('offers a tour on the empty part and leaves navigation closed until requested', () => {
  const welcome = renderToStaticMarkup(<TutorialWelcome />);
  expect(welcome).toContain(t('guide.start'));
  expect(welcome).toContain('aria-expanded="false"');
  expect(welcome).not.toContain(t('guide.next'));
  expect(welcome).toContain(t('tutorial.start'));
});
