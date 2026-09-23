/** Read-only gate progress. An unfinished run is never reported as passed. */
import { readFileSync, existsSync } from 'node:fs';
import { extname } from 'node:path';
import { TextDecoder } from 'node:util';
import { URL } from 'node:url';
import process from 'node:process';
import console from 'node:console';

function linesOf(bytes) {
  const utf8 = new TextDecoder('utf-8', { fatal: true }), legacy = new TextDecoder('shift_jis');
  const ansi = new RegExp(String.fromCharCode(27) + String.raw`\[[0-9;]*[A-Za-z]`, 'gu');
  const lines = [];
  let start = 0;
  for (let end = 0; end <= bytes.length; end += 1) {
    if (end !== bytes.length && bytes[end] !== 10) continue;
    const line = bytes.subarray(start, end); start = end + 1;
    let decoded;
    try { decoded = utf8.decode(line); } catch { decoded = legacy.decode(line); }
    lines.push(decoded.replace(ansi, '').trim());
  }
  return lines;
}
const input = process.argv[2];
if (input === undefined) throw new Error('Specify a gate log path, or --stdin');
const bytes = readFileSync(input === '--stdin' ? 0 : input);
const lines = linesOf(bytes);
const extension = extname(input);
const exitPath = input === '--stdin' ? null : (extension === '' ? input : input.slice(0, -extension.length)) + '.exit';
const rawExit = input === '--stdin' ? process.argv[3] : exitPath !== null && existsSync(exitPath) ? readFileSync(exitPath, 'utf8').trim() : undefined;
if (rawExit !== undefined && !/^-?\d+$/u.test(rawExit)) throw new Error('Invalid gate exit record');
const exitCode = rawExit === undefined ? null : Number(rawExit);
if (exitCode !== null && !Number.isSafeInteger(exitCode)) throw new Error('Invalid gate exit code');
const passed = lines.filter(line => /^(?:✓|ok)\s+\d+\s+\[/u.test(line));
const failed = lines.filter(line => /^(?:✘|×|x|not ok)\s+\d+\s+\[/u.test(line));
const failures = lines.filter(line => /^(?:Test Files|Tests|[1-9]\d* failed)\b.*\b[1-9]\d* failed\b/u.test(line)
  || /^[1-9]\d* failed\b/u.test(line) || /^\[NG\]\s+\(\d/u.test(line));
const headings = lines.filter(line => line.startsWith('==='));
const status = failed.length > 0 || failures.length > 0 || (exitCode !== null && exitCode !== 0) ? 'failed'
  : exitCode === 0 ? 'passed' : 'running';
// Read the actual report beside this script, not a different worktree's draft.
// A warning is only a reminder while this reader runs; it is not an auto-report.
const reportPath = new URL('../docs/報告記録.md', import.meta.url);
const reportHeading = existsSync(reportPath)
  ? readFileSync(reportPath, 'utf8').match(/^## (\d{4}-\d{2}-\d{2}) (\d{2}:\d{2})(?:\s|$)/mu) : null;
const reportTime = reportHeading === null ? Number.NaN
  : Date.parse(`${reportHeading[1]}T${reportHeading[2]}:00+09:00`);
const reportAgeMinutes = Number.isFinite(reportTime) ? (Date.now() - reportTime) / 60_000 : null;
const reportUpdateDue = reportAgeMinutes === null || reportAgeMinutes >= 10 || reportAgeMinutes < -1;
const report = { latestEntry: reportHeading?.[0].trim() ?? null,
  ageMinutes: reportAgeMinutes === null ? null : Math.round(reportAgeMinutes * 10) / 10,
  updateDue: reportUpdateDue,
  action: reportUpdateDue ? '普段の作業場所の報告記録を更新し、実ファイルを読み直してください。' : null };
console.log(JSON.stringify({ status, stage: headings.at(-1) ?? null, exitCode,
  e2ePassedEvents: passed.length, e2eFailedEvents: failed.length, failedE2E: failed,
  failureSummaries: failures, lastE2E: passed.slice(-2), report }, null, 2));
