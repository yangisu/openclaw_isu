import { execPath } from 'node:process';
import { describe, expect, it } from 'vitest';

import { runExecFileCapture } from '../../src/ops/process.js';

describe('bounded process execution', () => {
  it('passes explicit child environment values without a shell', async () => {
    const output = await runExecFileCapture({
      executable: execPath,
      args: ['-e', 'process.stdout.write(process.env.OPENCLAW_TEST_VALUE ?? "missing")'],
      env: { ...process.env, OPENCLAW_TEST_VALUE: 'safe value with spaces' },
      timeoutMs: 10_000,
    });
    expect(output).toBe('safe value with spaces');
  });
});
