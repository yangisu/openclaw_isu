import { execPath } from 'node:process';
import { describe, expect, it } from 'vitest';

import { runExecFileCapture, withWslInteropEnv } from '../../src/ops/process.js';

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

  it('declares explicit values for WSL to Windows process interop', () => {
    const env = withWslInteropEnv(
      { OPENCLAW_PS_PATH: 'D:\\safe path', OPENCLAW_PS_ACTION: 'capture' },
      { WSLENV: 'EXISTING/u:OPENCLAW_PS_PATH' },
    );
    expect(env.OPENCLAW_PS_PATH).toBe('D:\\safe path');
    expect(env.OPENCLAW_PS_ACTION).toBe('capture');
    expect(env.WSLENV).toBe('EXISTING/u:OPENCLAW_PS_PATH:OPENCLAW_PS_ACTION');
  });
});
