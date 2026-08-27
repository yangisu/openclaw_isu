import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const openClawEntry = require.resolve('openclaw/plugin-sdk/tool-plugin');
const openClawRoot = resolve(dirname(openClawEntry), '../..');
const JSON5 = createRequire(resolve(openClawRoot, 'package.json'))('json5') as {
  parse(source: string): Record<string, unknown>;
};
const configPath = resolve(process.cwd(), '../../config/openclaw.personal-assistant.example.json5');
const cronEvidencePath = resolve(process.cwd(), '../../config/personal-assistant-hourly-briefing.cron-evidence.json');

describe('hardened OpenClaw example config', () => {
  it('binds the Gateway explicitly to loopback', async () => {
    const config = JSON5.parse(await readFile(configPath, 'utf8')) as any;
    expect(config.gateway).toEqual({ bind: 'loopback' });
  });

  it('allows only one numeric Telegram owner and disables groups and config writes', async () => {
    const config = JSON5.parse(await readFile(configPath, 'utf8')) as any;
    expect(config.channels.telegram).toMatchObject({
      enabled: true,
      tokenFile: '/home/user/.openclaw/secrets/telegram-token',
      dmPolicy: 'allowlist',
      allowFrom: ['tg:6520016662'],
      groupPolicy: 'disabled',
      configWrites: false,
      capabilities: { inlineButtons: 'dm' },
    });
    expect(config.channels.telegram.allowFrom[0]).toMatch(/^tg:[1-9][0-9]*$/);
    expect(JSON.stringify(config.channels.telegram)).not.toContain('*');
  });

  it('exposes exactly six assistant tools plus bounded fetch/PDF and no dangerous surface', async () => {
    const config = JSON5.parse(await readFile(configPath, 'utf8')) as any;
    expect(config.commands).toEqual({ bash: false, config: false, mcp: false, plugins: false });
    expect(config.tools).toEqual({
      allow: [
        'assistant_query',
        'assistant_mutate',
        'assistant_calendar_manage',
        'assistant_briefing',
        'assistant_resource_store',
        'assistant_study_manage',
        'web_fetch',
        'pdf',
      ],
      web: { fetch: {
        enabled: true, maxChars: 100000, maxCharsCap: 100000,
        maxResponseBytes: 1000000, timeoutSeconds: 30, maxRedirects: 3,
        useTrustedEnvProxy: false,
      } },
      elevated: { enabled: false },
    });
    expect(config.agents).toEqual({ defaults: { pdfMaxBytesMb: 10, pdfMaxPages: 20 } });
    expect(config.tools.allow).not.toContain('*');
  });

  it('keeps secrets out of the example and references a token file', async () => {
    const source = await readFile(configPath, 'utf8');
    expect(source).not.toMatch(/botToken\s*:/i);
    expect(source).not.toMatch(/(?:password|clientSecret|accessToken|refreshToken)\s*:/i);
  });

  it('pins the least-privilege Google account and owner-private credential paths', async () => {
    const config = JSON5.parse(await readFile(configPath, 'utf8')) as any;
    expect(config.plugins.entries['openclaw-personal-assistant'].config.calendar).toEqual({
      provider: 'google',
      googleOAuthClientFile: '/home/user/.openclaw/secrets/google-oauth-client',
      googleTokenFile: '/home/user/.openclaw/secrets/google-oauth-token',
      googleCalendarBindingFile: '/home/user/.openclaw/secrets/google-calendar-binding',
      expectedAccount: 'yangisu12@gmail.com',
    });
  });
});

describe('exact hourly briefing cron evidence', () => {
  it('commits the inspected no-replay isolated Telegram cron contract', async () => {
    const evidence = JSON.parse(await readFile(cronEvidencePath, 'utf8'));
    expect(evidence).toMatchObject({
      name: 'Personal assistant hourly briefing',
      enabled: true,
      schedule: { kind: 'cron', expr: '0 8-22 * * *', tz: 'Asia/Seoul', staggerMs: 0 },
      sessionTarget: 'isolated',
      payload: { kind: 'agentTurn', message: 'Call assistant_briefing once. Deliver only when send=true.' },
      delivery: { mode: 'announce', channel: 'telegram', to: '123456789' },
      missedRuns: 'skip',
    });
    expect(evidence).not.toHaveProperty('catchUp');
    expect(evidence).not.toHaveProperty('replay');
  });
});
