import fs from 'node:fs';

const tap = fs.readFileSync(process.argv[2], 'utf8');
const number = (name) => Number(tap.match(new RegExp(`# ${name} (\\d+)`))?.[1] ?? 0);
const browserPassed = Number(process.env.BROWSER_TESTS_PASSED ?? 0);
const report = { status: number('fail') ? 'failed' : 'passed', commit: process.env.GITHUB_SHA ?? null, passed: number('pass') + browserPassed, failed: number('fail'), durationMs: Number(tap.match(/# duration_ms ([\d.]+)/)?.[1] ?? 0), createdAt: new Date().toISOString() };
fs.writeFileSync('quality-report.json', `${JSON.stringify(report, null, 2)}\n`);
