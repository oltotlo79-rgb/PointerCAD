import { attachOfflineManualNavigation } from '../../packages/ui/src/help/offlineManualNavigation.js';

const script = document.currentScript;
if (!(script instanceof HTMLScriptElement)) throw new Error('Missing navigation script');
attachOfflineManualNavigation(new URL('./', script.src), '同じ版の説明書を確認できませんでした。');
