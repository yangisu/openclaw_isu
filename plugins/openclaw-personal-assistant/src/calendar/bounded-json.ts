const DEFAULT_MAX_DEPTH = 12;
const DEFAULT_MAX_NODES = 1_024;
const DEFAULT_MAX_STRING_LENGTH = 16_384;

export type BoundedBodyErrorCode = 'body_failed' | 'response_too_large' | 'invalid_json' | 'invalid_shape';

export class BoundedBodyError extends Error {
  constructor(public readonly code: BoundedBodyErrorCode) {
    super('Remote response could not be accepted');
    this.name = 'BoundedBodyError';
  }
}

export async function readBoundedBody(response: Response, maxBytes: number): Promise<string> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new BoundedBodyError('response_too_large');
  const declared = response.headers?.get('content-length');
  if (declared !== null && declared !== undefined) {
    const length = Number(declared);
    if (!Number.isSafeInteger(length) || length < 0 || length > maxBytes) {
      await response.body?.cancel().catch(() => undefined);
      throw new BoundedBodyError('response_too_large');
    }
  }
  const reader = response.body?.getReader();
  if (!reader) throw new BoundedBodyError('body_failed');
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let bytes = 0;
  let text = '';
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new BoundedBodyError('response_too_large');
      }
      text += decoder.decode(next.value, { stream: true });
    }
    text += decoder.decode();
    return text;
  } catch (error) {
    if (error instanceof BoundedBodyError) throw error;
    throw new BoundedBodyError('body_failed');
  } finally {
    reader.releaseLock();
  }
}

export async function readBoundedJson(response: Response, maxBytes: number): Promise<unknown> {
  const text = await readBoundedBody(response, maxBytes);
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    throw new BoundedBodyError('invalid_json');
  }
  assertBoundedShape(value);
  return value;
}

function assertBoundedShape(value: unknown): void {
  let nodes = 0;
  const visit = (current: unknown, depth: number): void => {
    nodes += 1;
    if (nodes > DEFAULT_MAX_NODES || depth > DEFAULT_MAX_DEPTH) throw new BoundedBodyError('invalid_shape');
    if (typeof current === 'string') {
      if (current.length > DEFAULT_MAX_STRING_LENGTH) throw new BoundedBodyError('invalid_shape');
      return;
    }
    if (Array.isArray(current)) {
      if (current.length > DEFAULT_MAX_NODES) throw new BoundedBodyError('invalid_shape');
      for (const item of current) visit(item, depth + 1);
      return;
    }
    if (current !== null && typeof current === 'object') {
      const entries = Object.entries(current as Record<string, unknown>);
      if (entries.length > 128) throw new BoundedBodyError('invalid_shape');
      for (const [key, item] of entries) {
        if (key.length > 256) throw new BoundedBodyError('invalid_shape');
        visit(item, depth + 1);
      }
    }
  };
  visit(value, 0);
}
