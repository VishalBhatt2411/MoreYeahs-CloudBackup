import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { countGzLines } from '../src/backup/exporters.js';

describe('counting rows in a saved file', () => {
  it('counts one row per line, even when the text holds U+2028 / U+2029 (page markup does)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'rowcount-'));
    try {
      // JSON.stringify leaves U+2028 and U+2029 as they are inside text.
      const rows = [{ Id: '1', Markup: 'a b c' }, { Id: '2', Markup: 'line1\nline2\r\n' }, { Id: '3', Markup: '' }];
      const text = rows.map((r) => JSON.stringify(r) + '\n').join('');
      expect(text).toContain(' '); // proves the trap is really in the data
      const file = join(dir, 'x.jsonl.gz');
      await writeFile(file, gzipSync(text));
      expect(await countGzLines(file)).toBe(3);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
