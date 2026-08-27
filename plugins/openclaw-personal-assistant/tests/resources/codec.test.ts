import { describe, expect, it } from 'vitest';
import { decodeResourceFiles, encodeResourceFiles } from '../../src/resources/codec.js';
import {
  canonicalizeResourceUrl,
  type ResourceIdentity,
  type ResourceSaveInput,
} from '../../src/resources/types.js';

const identity = (): ResourceIdentity => ({
  id: 'R-20260827-001',
  createdAt: '2026-08-27T08:00:00+09:00',
  updatedAt: '2026-08-27T08:00:00+09:00',
});

const resourceInput = (extractedText: string): ResourceSaveInput => ({
  operationId: 'resource-save-1',
  url: 'https://example.com/article#section',
  title: '에이전트 메모리',
  summary: '로컬 저장 방식 요약',
  claims: ['원문과 요약을 함께 보관한다.'],
  tags: ['AI', '공부'],
  contentType: 'web',
  extractedText,
  extractedAt: '2026-08-27T08:00:00+09:00',
});

describe('resource archive codec', () => {
  it('canonicalizes one public HTTP URL without credentials or fragments', () => {
    expect(canonicalizeResourceUrl('HTTPS://Example.COM:443/a?b=2#frag'))
      .toBe('https://example.com/a?b=2');
    expect(() => canonicalizeResourceUrl('https://owner:secret@example.com/a'))
      .toThrow(expect.objectContaining({ code: 'url_credentials' }));
    expect(() => canonicalizeResourceUrl('file:///etc/passwd'))
      .toThrow(expect.objectContaining({ code: 'invalid_url' }));
  });

  it('accepts exactly 100000 normalized characters and rejects 100001', () => {
    expect(encodeResourceFiles(resourceInput('가'.repeat(100_000)), identity()).content)
      .toHaveLength(100_001);
    expect(() => encodeResourceFiles(resourceInput('가'.repeat(100_001)), identity()))
      .toThrow(expect.objectContaining({ code: 'resource_content_too_large' }));
  });

  it('round-trips deterministic metadata and normalized content', () => {
    const encoded = encodeResourceFiles(resourceInput('첫 줄\r\n둘째 줄'), identity());
    expect(encoded.content).toBe('첫 줄\n둘째 줄\n');
    expect(encoded.metadata.endsWith('\n')).toBe(true);
    expect(decodeResourceFiles(encoded.metadata, encoded.content)).toMatchObject({
      id: 'R-20260827-001',
      url: 'https://example.com/article',
      title: '에이전트 메모리',
      extractedText: '첫 줄\n둘째 줄',
    });
  });
});
