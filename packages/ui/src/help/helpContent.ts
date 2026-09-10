import { HELP_TOPICS } from '@pointercad/help-content';
import { createHelpLibrary, type HelpLoader } from './helpLibrary.js';

const markdown = import.meta.glob<string>('../../../help-content/docs/ja/*.md', { query: '?raw', import: 'default' });
const images = import.meta.glob<string>('../../../help-content/docs/ja/images/*.png', { query: '?url', import: 'default', eager: true });
export const HELP_IMAGES: Readonly<Record<string, string>> = Object.fromEntries(Object.entries(images).map(([path, url]) => [
  path.slice('../../../help-content/docs/ja/'.length), url,
]));
export const HELP_LOADERS: Readonly<Record<string, HelpLoader>> = Object.fromEntries(HELP_TOPICS.map((topic) => {
  const loader = markdown[`../../../help-content/${topic.path}`];
  if (loader === undefined) throw new Error(`Help document is missing: ${topic.path}`);
  return [topic.id, loader];
}));
export const helpLibrary = createHelpLibrary(HELP_LOADERS);
