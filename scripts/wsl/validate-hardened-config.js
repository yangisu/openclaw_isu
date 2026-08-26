#!/usr/bin/env node
'use strict';

const { createRequire } = require('node:module');
const { dirname, isAbsolute, join, resolve } = require('node:path');
const { secureReadFile, validateSafeValue } = require('./live-probe-contract.js');

try {
  const [openclawBin, configPath, secretDir] = process.argv.slice(2);
  if (process.argv.length !== 5 || !isAbsolute(openclawBin) || !isAbsolute(configPath) || !isAbsolute(secretDir)
    || resolve(configPath) !== configPath || resolve(secretDir) !== secretDir) throw new Error('usage');
  const bytes = secureReadFile(configPath, { root: resolve(configPath, '..'), maxBytes: 1024 * 1024 });
  const requireFromOpenClaw = createRequire(join(dirname(openclawBin), '..', 'openclaw', 'package.json'));
  const JSON5 = requireFromOpenClaw('json5');
  const config = JSON5.parse(bytes.toString('utf8'));
  validateSafeValue(config);
  const expectedTools = ['assistant_briefing', 'assistant_calendar_confirm', 'assistant_calendar_prepare', 'assistant_mutate', 'assistant_query'];
  const plugin = config.plugins?.entries?.['openclaw-personal-assistant'];
  const owner = plugin?.config?.telegramUserId;
  if (config.gateway?.bind !== 'loopback' || config.cron?.triggers?.enabled !== true
    || config.channels?.telegram?.enabled !== true || config.channels?.telegram?.tokenFile !== join(secretDir, 'telegram-token').replaceAll('\\', '/')
    || config.channels?.telegram?.dmPolicy !== 'allowlist' || config.channels?.telegram?.groupPolicy !== 'disabled'
    || config.channels?.telegram?.configWrites !== false || !/^[1-9][0-9]{0,18}$/.test(String(owner))
    || JSON.stringify(config.channels?.telegram?.allowFrom) !== JSON.stringify([`tg:${owner}`])
    || config.commands?.bash !== false || config.commands?.config !== false || config.commands?.mcp !== false || config.commands?.plugins !== false
    || config.tools?.elevated?.enabled !== false || JSON.stringify([...(config.tools?.allow ?? [])].sort()) !== JSON.stringify(expectedTools)
    || plugin?.enabled !== true || plugin?.config?.timezone !== 'Asia/Seoul'
    || plugin?.config?.calendar?.caldavSecretFile !== join(secretDir, 'naver-caldav').replaceAll('\\', '/')
    || plugin?.config?.calendar?.naverTokenFile !== join(secretDir, 'naver-oauth').replaceAll('\\', '/')
    || containsPlaceholder(config)) throw new Error('hardening');
  process.stdout.write('{"status":"PASS"}\n');
} catch {
  process.stderr.write('active_config_not_hardened\n');
  process.exit(1);
}

function containsPlaceholder(value) {
  const text = JSON.stringify(value);
  return /<(?:replace|your|placeholder)|CHANGE_ME|example\.invalid|REPLACE_ME/i.test(text);
}
