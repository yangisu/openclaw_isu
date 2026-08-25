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

describe('hardened OpenClaw example config', () => {
  it('allows only one numeric Telegram owner and disables groups and config writes', async () => {
    const config = JSON5.parse(await readFile(configPath, 'utf8')) as any;
    expect(config.channels.telegram).toMatchObject({
      enabled: true,
      tokenFile: '/home/user/.openclaw/secrets/telegram-token',
      dmPolicy: 'allowlist',
      allowFrom: ['tg:123456789'],
      groupPolicy: 'disabled',
      configWrites: false,
    });
    expect(config.channels.telegram.allowFrom[0]).toMatch(/^tg:[1-9][0-9]*$/);
    expect(JSON.stringify(config.channels.telegram)).not.toContain('*');
  });

  it('exposes exactly five assistant tools and no dangerous command or elevation surface', async () => {
    const config = JSON5.parse(await readFile(configPath, 'utf8')) as any;
    expect(config.commands).toEqual({ bash: false, config: false, mcp: false, plugins: false });
    expect(config.tools).toEqual({
      allow: [
        'assistant_query',
        'assistant_mutate',
        'assistant_calendar_prepare',
        'assistant_calendar_confirm',
        'assistant_briefing',
      ],
      elevated: { enabled: false },
    });
    expect(config.tools.allow).not.toContain('*');
  });

  it('keeps secrets out of the example and references a token file', async () => {
    const source = await readFile(configPath, 'utf8');
    expect(source).not.toMatch(/botToken\s*:/i);
    expect(source).not.toMatch(/(?:password|clientSecret|accessToken|refreshToken)\s*:/i);
  });
});
