/// <reference types="node" />

import { execFile } from 'node:child_process';

export class BoundedProcessError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'BoundedProcessError';
  }
}

export interface ExecFileRequest {
  executable: string;
  args: readonly string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  signal?: AbortSignal;
}

/** Executes one binary without a shell and never exposes unbounded child output. */
export async function runExecFile(request: ExecFileRequest): Promise<void> {
  await runExecFileCapture(request);
}

export function runExecFileCapture(request: ExecFileRequest): Promise<string> {
  const timeoutMs = request.timeoutMs ?? 120_000;
  return new Promise((resolve, reject) => {
    const child = execFile(request.executable, [...request.args], {
      ...(request.cwd ? { cwd: request.cwd } : {}),
      ...(request.env ? { env: request.env } : {}),
      timeout: timeoutMs,
      maxBuffer: 64 * 1024,
      shell: false,
      windowsHide: true,
      ...(request.signal ? { signal: request.signal } : {}),
    }, (error, stdout) => {
      request.signal?.removeEventListener('abort', abort);
      if (!error) resolve(String(stdout));
      else reject(new BoundedProcessError(
        request.signal?.aborted
          ? 'process_aborted'
          : ('killed' in error && error.killed ? 'process_timeout' : 'process_failed'),
        'bounded child process failed',
      ));
    });
    const abort = () => child.kill('SIGKILL');
    request.signal?.addEventListener('abort', abort, { once: true });
  });
}
