// Electron だけの画面検査で、desktop の組み立てが済んだ事を Playwright の webServer.wait へ知らせる(scripts/lib/e2eWebServer.mjs)。
// 印を出した後は、Playwright が片付け(teardown)で止めるまで待つ(途中で終わると「webServer が早く終わった」と見なされるため)。
import process from 'node:process';
import { setInterval } from 'node:timers';

process.stdout.write('PCAD_E2E_DESKTOP_BUILD_READY\n');
setInterval(() => undefined, 60_000);
