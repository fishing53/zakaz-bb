const target = (process.env.LOAD_TEST_URL || 'http://127.0.0.1:3107').replace(/\/$/, '');
const clients = Math.max(1, Math.min(100, Number(process.env.LOAD_TEST_CLIENTS ?? 50)));
const requestsPerClient = Math.max(1, Math.min(100, Number(process.env.LOAD_TEST_REQUESTS ?? 10)));
if (!/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/i.test(target) && process.env.ALLOW_REMOTE_LOAD_TEST !== 'YES') throw new Error('Удалённый нагрузочный тест требует ALLOW_REMOTE_LOAD_TEST=YES');
const started = performance.now(); let passed = 0; let failed = 0;
await Promise.all(Array.from({ length: clients }, async (_, client) => {
  for (let index = 0; index < requestsPerClient; index += 1) {
    const path = index % 2 ? '/api/v1/health/ready' : `/api/v1/bootstrap?terminalId=load_${client}_${index}`;
    try { const response = await fetch(`${target}${path}`); if (!response.ok) throw new Error(String(response.status)); await response.arrayBuffer(); passed += 1; }
    catch { failed += 1; }
  }
}));
const duration = Math.round(performance.now() - started);
console.log(JSON.stringify({ target, clients, requests: passed + failed, passed, failed, durationMs: duration, requestsPerSecond: Math.round((passed + failed) / duration * 1000) }, null, 2));
if (failed) process.exitCode = 1;
