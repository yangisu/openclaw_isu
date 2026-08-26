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
  const calendar = plugin?.config?.calendar;
  if (config.gateway?.bind !== 'loopback' || config.cron?.triggers?.enabled !== true
    || config.channels?.telegram?.enabled !== true || config.channels?.telegram?.tokenFile !== join(secretDir, 'telegram-token').replaceAll('\\', '/')
    || config.channels?.telegram?.dmPolicy !== 'allowlist' || config.channels?.telegram?.groupPolicy !== 'disabled'
    || config.channels?.telegram?.configWrites !== false || !/^[1-9][0-9]{0,18}$/.test(String(owner))
    || JSON.stringify(config.channels?.telegram?.allowFrom) !== JSON.stringify([`tg:${owner}`])
    || config.commands?.bash !== false || config.commands?.config !== false || config.commands?.mcp !== false || config.commands?.plugins !== false
    || config.tools?.elevated?.enabled !== false || JSON.stringify([...(config.tools?.allow ?? [])].sort()) !== JSON.stringify(expectedTools)
    || plugin?.enabled !== true || plugin?.config?.timezone !== 'Asia/Seoul'
    || calendar?.caldavReadEnabled !== false
    || calendar?.caldavSecretFile !== join(secretDir, 'naver-caldav').replaceAll('\\', '/')
    || calendar?.naverOAuthClientFile !== join(secretDir, 'naver-oauth-client').replaceAll('\\', '/')
    || calendar?.naverTokenFile !== join(secretDir, 'naver-oauth-token').replaceAll('\\', '/')
    || !validCalendarMappings(calendar)
    || containsPlaceholder(config)) throw new Error('hardening');
  process.stdout.write('{"status":"PASS"}\n');
} catch {
  process.stderr.write('active_config_not_hardened\n');
  process.exit(1);
}

function containsPlaceholder(value) {
  const text = JSON.stringify(value);
  return /<(?:replace|your|placeholder)|CHANGE_ME|example\.invalid|REPLACE_ME|OWNER_APPROVED_/i.test(text);
}

function validCalendarMappings(calendar) {
  try {
    const base = new URL(calendar?.caldavBaseUrl);
    const mappings = calendar?.calendarMappings;
    if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash
      || !Array.isArray(mappings) || mappings.length < 1 || mappings.length > 10) return false;
    const apiIds = new Set();
    const hrefs = [];
    for (const mapping of mappings) {
      if (!mapping || typeof mapping !== 'object' || Array.isArray(mapping)
        || Object.keys(mapping).sort().join(',') !== 'apiCalendarId,caldavHref'
        || typeof mapping.apiCalendarId !== 'string' || !mapping.apiCalendarId.trim() || mapping.apiCalendarId.length > 1024
        || typeof mapping.caldavHref !== 'string' || mapping.caldavHref.length > 4096
        || hasTraversal(mapping.caldavHref)) return false;
      const href = new URL(mapping.caldavHref);
      if (href.href !== mapping.caldavHref || href.protocol !== 'https:' || href.origin !== base.origin
        || href.username || href.password || href.search || href.hash || !href.pathname.endsWith('/')
        || href.href === base.href
        || apiIds.has(mapping.apiCalendarId) || hrefs.some(existing => existing.href === href.href
          || existing.pathname.startsWith(href.pathname) || href.pathname.startsWith(existing.pathname))) return false;
      apiIds.add(mapping.apiCalendarId);
      hrefs.push(href);
    }
    return true;
  } catch { return false; }
}

function hasTraversal(raw) {
  try {
    let decoded = raw;
    for (let iteration = 0; iteration < 5; iteration += 1) {
      const next = decodeURIComponent(decoded);
      if (next === decoded) break;
      decoded = next;
    }
    return /%[0-9a-f]{2}/i.test(decoded)
      || decoded.replaceAll('\\', '/').split('/').some(segment => segment === '.' || segment === '..');
  } catch { return true; }
}
