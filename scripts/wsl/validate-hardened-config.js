#!/usr/bin/env node
'use strict';

const { createRequire } = require('node:module');
const { dirname, isAbsolute, join, resolve } = require('node:path');
const { secureReadFile, validateSafeValue } = require('./live-probe-contract.js');

try {
  const [openclawBin, configPath, secretDir] = process.argv.slice(2);
  if (process.argv.length !== 5
    || !isAbsolute(openclawBin) || !isAbsolute(configPath) || !isAbsolute(secretDir)
    || resolve(configPath) !== configPath || resolve(secretDir) !== secretDir) throw new Error('usage');
  const bytes = secureReadFile(configPath, { root: resolve(configPath, '..'), maxBytes: 1024 * 1024 });
  const requireFromOpenClaw = createRequire(join(dirname(openclawBin), '..', 'openclaw', 'package.json'));
  const JSON5 = requireFromOpenClaw('json5');
  const config = JSON5.parse(bytes.toString('utf8'));
  const safeConfig = structuredClone(config);
  removeOwnerPrivateGatewayAuth(safeConfig);
  validateSafeValue(safeConfig);
  const expectedTools = [
    'assistant_briefing', 'assistant_calendar_manage', 'assistant_mutate',
    'assistant_query', 'assistant_resource_store', 'assistant_study_manage', 'pdf', 'web_fetch',
  ];
  const plugin = config.plugins?.entries?.['openclaw-personal-assistant'];
  const owner = plugin?.config?.telegramUserId;
  const calendar = plugin?.config?.calendar;
  if (config.gateway?.bind !== 'loopback' || config.cron?.triggers?.enabled !== true
    || config.channels?.telegram?.enabled !== true || config.channels?.telegram?.tokenFile !== join(secretDir, 'telegram-token').replaceAll('\\', '/')
    || config.channels?.telegram?.dmPolicy !== 'allowlist' || config.channels?.telegram?.groupPolicy !== 'disabled'
    || config.channels?.telegram?.configWrites !== false || !/^[1-9][0-9]{0,18}$/.test(String(owner))
    || JSON.stringify(config.channels?.telegram?.capabilities) !== JSON.stringify({ inlineButtons: 'dm' })
    || JSON.stringify(config.channels?.telegram?.allowFrom) !== JSON.stringify([`tg:${owner}`])
    || config.commands?.bash !== false || config.commands?.config !== false || config.commands?.mcp !== false || config.commands?.plugins !== false
    || config.tools?.elevated?.enabled !== false || JSON.stringify([...(config.tools?.allow ?? [])].sort()) !== JSON.stringify(expectedTools)
    || Object.keys(config.tools ?? {}).sort().join(',') !== 'allow,elevated,web'
    || Object.keys(config.tools?.web ?? {}).sort().join(',') !== 'fetch'
    || Object.keys(config.tools?.web?.fetch ?? {}).sort().join(',') !== 'enabled,maxChars,maxCharsCap,maxRedirects,maxResponseBytes,timeoutSeconds,useTrustedEnvProxy'
    || config.tools?.web?.fetch?.enabled !== true || config.tools?.web?.fetch?.maxChars !== 100000
    || config.tools?.web?.fetch?.maxCharsCap !== 100000 || config.tools?.web?.fetch?.maxResponseBytes !== 1000000
    || config.tools?.web?.fetch?.timeoutSeconds !== 30 || config.tools?.web?.fetch?.maxRedirects !== 3
    || config.tools?.web?.fetch?.useTrustedEnvProxy !== false
    || config.agents?.defaults?.pdfMaxBytesMb !== 10 || config.agents?.defaults?.pdfMaxPages !== 20
    || plugin?.enabled !== true || plugin?.config?.timezone !== 'Asia/Seoul'
    || calendar?.provider !== 'google'
    || calendar?.googleOAuthClientFile !== join(secretDir, 'google-oauth-client').replaceAll('\\', '/')
    || calendar?.googleTokenFile !== join(secretDir, 'google-oauth-token').replaceAll('\\', '/')
    || calendar?.googleCalendarBindingFile !== join(secretDir, 'google-calendar-binding').replaceAll('\\', '/')
    || calendar?.expectedAccount !== 'yangisu12@gmail.com'
    || Object.keys(calendar ?? {}).sort().join(',') !== 'expectedAccount,googleCalendarBindingFile,googleOAuthClientFile,googleTokenFile,provider'
    || new Set([
      calendar?.googleOAuthClientFile, calendar?.googleTokenFile, calendar?.googleCalendarBindingFile,
    ]).size !== 3
    || containsPlaceholder(config)) throw new Error('hardening');
  process.stdout.write('{"status":"PASS"}\n');
} catch {
  process.stderr.write('active_config_not_hardened\n');
  process.exit(1);
}

function removeOwnerPrivateGatewayAuth(config) {
  const gateway = config?.gateway;
  const auth = gateway?.auth;
  if (auth === undefined) return;
  if (!gateway || typeof gateway !== 'object' || Array.isArray(gateway)
    || !auth || typeof auth !== 'object' || Array.isArray(auth)
    || Object.keys(auth).sort().join(',') !== 'mode,token'
    || auth.mode !== 'token'
    || typeof auth.token !== 'string' || !/^[0-9a-f]{48}$/.test(auth.token)) {
    throw new Error('gateway_auth_invalid');
  }
  delete gateway.auth;
}

function containsPlaceholder(value) {
  const text = JSON.stringify(value);
  return /<(?:replace|your|placeholder)|CHANGE_ME|example\.invalid|REPLACE_ME|OWNER_APPROVED_/i.test(text);
}
