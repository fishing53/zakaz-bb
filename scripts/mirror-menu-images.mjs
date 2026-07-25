import { mkdir, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const root = new URL('..', import.meta.url).pathname;
const catalog = JSON.parse(await readFile(join(root, 'menu.json'), 'utf8'));
const output = join(root, 'public', 'images', 'menu');
await mkdir(output, { recursive: true });

const run = promisify(execFile);
const jobs = catalog.menu.map((product, index) => ({ index, url: product.image, source: join(output, `${index}.source.jpg`), target: join(output, `${index}.webp`) }));
let completed = 0;

async function download(job) {
  try {
    const existing = await stat(job.target);
    if (existing.size > 1024) { completed += 1; return; }
  } catch {}
  const response = await fetch(job.url);
  if (!response.ok) throw new Error(`${response.status} ${job.url}`);
  await writeFile(job.source, Buffer.from(await response.arrayBuffer()));
  await run('cwebp', ['-quiet', '-q', '78', '-resize', '1200', '0', job.source, '-o', job.target]);
  await unlink(job.source);
  completed += 1;
}

const queue = [...jobs];
await Promise.all(Array.from({ length: 6 }, async () => {
  while (queue.length) {
    const job = queue.shift();
    if (!job) return;
    await download(job);
    process.stdout.write(`\rИзображения: ${completed}/${jobs.length}`);
  }
}));
process.stdout.write('\nГотово.\n');
