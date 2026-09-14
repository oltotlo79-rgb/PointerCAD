import { executeDefinitionDiffWork } from './definitionDiffWork.js';
self.addEventListener('message', (event: MessageEvent<unknown>) => {
  void executeDefinitionDiffWork(event.data).then(reply => self.postMessage(reply));
});
