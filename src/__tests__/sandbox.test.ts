import { describe, expect, it } from 'vitest';
import { InMemorySandbox } from '../sandbox.js';

describe('InMemorySandbox', () => {
  it('round-trips, lists, and deletes files', async () => {
    const sandbox = new InMemorySandbox();

    const written = await sandbox.writeFile('/tmp/example.txt', 'hello');
    const read = await sandbox.readFile('/tmp/example.txt');
    const listed = await sandbox.listFiles('/tmp');

    expect(written).toMatchObject({ success: true, size: 5 });
    expect(read.content.toString('utf8')).toBe('hello');
    expect(listed.files.map((file) => file.path)).toEqual(['/tmp/example.txt']);
    await expect(sandbox.deleteFile('/tmp/example.txt')).resolves.toBe(true);
    await expect(sandbox.listFiles('/tmp')).resolves.toMatchObject({ total: 0 });
  });

  it('rejects reads for missing files', async () => {
    const sandbox = new InMemorySandbox();

    await expect(sandbox.readFile('/tmp/missing.txt')).rejects.toThrow('sandbox file not found');
  });

  it('labels deterministic execution output', async () => {
    const sandbox = new InMemorySandbox();

    await expect(sandbox.executeCode("console.log('hello')", 'javascript')).resolves.toMatchObject({
      exitCode: 0,
      stdout: "[javascript] console.log('hello')",
    });
  });
});
