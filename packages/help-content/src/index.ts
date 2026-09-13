/**
 * ヘルプ文書(要件 FR-901)。Markdown を docs/ja 配下で管理する。
 * 機能追加のたびにヘルプの追加を必須とする(NFR-MA-4)。
 */
export { createHelpSearchIndex, normalizeHelpSearch, type HelpSearchDocument, type HelpSearchHit } from './searchIndex.js';
export { resolveHelpUiReferences } from './uiReferences.js';
export { adjacentHelpTopics, initialHelpHistory, stepHelpHistory, visitHelp, type HelpHistory, type HelpVisit } from './navigation.js';

export { HELP_TOPICS, findHelpTopic, type HelpTopic } from './topics.js';
export { buildManualManifest, MANUAL_CHAPTERS, MANUAL_VOLUMES, type ManualChapter, type ManualVolume } from './manualManifest.js';
