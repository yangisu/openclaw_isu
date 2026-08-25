import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  alertFingerprint, buildBriefing, type ActiveSubsystemError, type BriefingResult,
} from '../../src/briefing/build.js';
import { deliverClaimedBriefing } from '../../src/briefing/delivery.js';
import { AlertLedger } from '../../src/state/alerts.js';

const directories: string[] = [];
const cfg = { channels: { telegram: { enabled: true } } } as never;
const target = '123456789';

const renderRetry = (activeErrors: ActiveSubsystemError[]) => buildBriefing({
  now: '2026-08-25T09:00:00+09:00', events: [], tasks: [], studies: [], activeErrors,
});

async function claimedFixture() {
  const stateDir = await mkdtemp(join(tmpdir(), 'assistant-direct-delivery-'));
  directories.push(stateDir);
  const clock = { now: Date.parse('2026-08-25T00:00:00.000Z') };
  const ledger = new AlertLedger(stateDir, { now: () => clock.now, leaseMs: 60_000 });
  const errors: ActiveSubsystemError[] = [
    { errorCode: 'error_one', target: 'one', message: 'one' },
    { errorCode: 'error_two', target: 'two', message: 'two' },
  ];
  const first = alertFingerprint('error_one', 'one');
  const second = alertFingerprint('error_two', 'two');
  const claim = ledger.claimAndRender(errors, (): BriefingResult => ({
    trust: 'quoted_untrusted_data', allowed: true, send: true,
    messages: ['exact first payload', 'exact second payload'],
    includedErrorFingerprints: [first, second],
    messageErrorFingerprints: [[first], [second]],
  }));
  return { ledger, claim, errors, first, second, clock };
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

describe('direct durable briefing delivery', () => {
  it('sends exact renderer payload boundaries through the required durable queue and suppresses Cron announce', async () => {
    const { ledger, claim } = await claimedFixture();
    const signal = new AbortController().signal;
    const send = vi.fn(async () => ({
      status: 'sent' as const,
      payloadOutcomes: [
        { index: 0, status: 'sent' as const, results: [] },
        { index: 1, status: 'sent' as const, results: [] },
      ],
    }));

    const result = await deliverClaimedBriefing({ cfg, target, claim, alerts: ledger, signal, send });

    expect(send).toHaveBeenCalledWith(expect.objectContaining({
      cfg,
      channel: 'telegram',
      to: target,
      payloads: [{ text: 'exact first payload' }, { text: 'exact second payload' }],
      durability: 'required',
      signal,
    }));
    expect(result).toEqual({
      trust: 'quoted_untrusted_data', allowed: true, send: false,
      delivered: true, deliveryStatus: 'sent', payloadCount: 2, sentPayloadCount: 2,
    });
    ledger.close();
  });

  it('ACKs only fingerprints whose payload indices are proven sent in a partial result', async () => {
    const { ledger, claim, errors, first, second } = await claimedFixture();
    const result = await deliverClaimedBriefing({
      cfg, target, claim, alerts: ledger,
      send: async () => ({
        status: 'partial_failed',
        error: new Error('private transport detail'),
        payloadOutcomes: [
          { index: 0, status: 'sent', results: [] },
          { index: 1, status: 'failed', error: new Error('private'), sentBeforeError: false, stage: 'platform_send' },
        ],
      }),
    });

    expect(result).toMatchObject({
      send: false, delivered: false, deliveryStatus: 'partial', payloadCount: 2, sentPayloadCount: 1,
    });
    expect(JSON.stringify(result)).not.toContain('private');
    expect(ledger.list()).toEqual(expect.arrayContaining([
      expect.objectContaining({ fingerprint: first, delivered: true }),
      expect.objectContaining({ fingerprint: second, delivered: false, claimed: true }),
    ]));
    expect(ledger.claimAndRender(errors, renderRetry).result.send).toBe(false);
    ledger.close();
  });

  it.each([
    ['failed', { status: 'failed', error: new Error('private'), stage: 'queue', payloadOutcomes: [
      { index: 0, status: 'failed', error: new Error('private'), sentBeforeError: false, stage: 'queue' },
      { index: 1, status: 'failed', error: new Error('private'), sentBeforeError: false, stage: 'queue' },
    ] }, 'failed'],
    ['suppressed', { status: 'suppressed', reason: 'hook', payloadOutcomes: [
      { index: 0, status: 'suppressed', reason: 'hook' },
      { index: 1, status: 'suppressed', reason: 'hook' },
    ] }, 'suppressed'],
    ['unknown', { status: 'sent', payloadOutcomes: undefined }, 'unknown'],
  ] as const)('keeps %s outcomes leased and retryable without exposing transport errors', async (_case, outbound, status) => {
    const { ledger, claim, errors, clock } = await claimedFixture();
    const result = await deliverClaimedBriefing({
      cfg, target, claim, alerts: ledger, send: async () => outbound as never,
    });

    expect(result).toMatchObject({ send: false, delivered: false, deliveryStatus: status, sentPayloadCount: 0 });
    expect(ledger.list().every(item => item.claimed && !item.delivered)).toBe(true);
    expect(ledger.claimAndRender(errors, renderRetry).result.send).toBe(false);
    clock.now += 60_001;
    expect(ledger.claimAndRender(errors, renderRetry).result.send).toBe(true);
    ledger.close();
  });
});
