import { rm } from 'node:fs/promises';
import { dirname, join, parse, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repository = resolve(fileURLToPath(new URL('..', import.meta.url)));
const target = join(repository, 'dist');

if (dirname(target) !== repository || parse(target).base !== 'dist') {
  throw new Error('Refusing to clean an unexpected build directory.');
}

await rm(target, { recursive: true, force: true });
