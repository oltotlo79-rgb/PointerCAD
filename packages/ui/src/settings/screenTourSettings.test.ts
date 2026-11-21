import { expect, it } from 'vitest';
import { settingsStorage } from './cameraSettingsPersistence.testSupport.js';
import { loadSettings, saveSettings } from './settings.js';

it('loads settings written before the tour and round-trips completion independently', () => {
  const memory = settingsStorage(JSON.stringify({ theme: 'light', uiScale: 120, tutorialCompleted: true }));
  const before = loadSettings(memory.storage);
  expect(before).toMatchObject({ theme: 'light', tutorialCompleted: true, screenTourSeen: false });
  saveSettings({ ...before, screenTourSeen: true }, memory.storage);
  expect(loadSettings(memory.storage)).toEqual({ ...before, screenTourSeen: true });
});
