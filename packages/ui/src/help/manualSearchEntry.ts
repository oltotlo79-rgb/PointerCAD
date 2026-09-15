import { attachManualSearch } from './manualSearch.js';
import { attachOfflineManualNavigation } from './offlineManualNavigation.js';
import { ja } from '../i18n/ja.js';
if (document.getElementById('manual-search-data') !== null) attachManualSearch(document);
const script = document.currentScript;
if (script instanceof HTMLScriptElement && script.src !== '') {
  attachOfflineManualNavigation(new URL('../', script.src), ja['offline.navigationFailed']);
}
