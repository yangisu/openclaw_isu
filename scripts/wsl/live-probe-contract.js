#!/usr/bin/env node
'use strict';

const { constants, closeSync, fstatSync, lstatSync, openSync, readSync, realpathSync } = require('node:fs');
const { isAbsolute, relative, resolve } = require('node:path');

function within(root, path) {
  const rel = relative(resolve(root), resolve(path));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function secureReadFile(path, { root, maxBytes, afterOpen } = {}) {
  if (!isAbsolute(path) || resolve(path) !== path || !isAbsolute(root) || !within(root, path)) throw new Error('unsafe_path');
  const before = lstatSync(path);
  if (!before.isFile() || before.isSymbolicLink() || before.size < 1 || before.size > maxBytes) throw new Error('unsafe_file');
  if (realpathSync(path) !== path) throw new Error('unsafe_path');
  const flags = constants.O_RDONLY | (constants.O_NOFOLLOW || 0);
  const fd = openSync(path, flags);
  try {
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size) throw new Error('file_changed');
    assertPosixPrivate(opened, false);
    if (afterOpen) afterOpen();
    const bytes = Buffer.alloc(opened.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (count === 0) throw new Error('short_read');
      offset += count;
    }
    const extra = Buffer.alloc(1);
    if (readSync(fd, extra, 0, 1, offset) !== 0) throw new Error('oversized_file');
    const after = fstatSync(fd);
    const current = lstatSync(path);
    if (after.dev !== opened.dev || after.ino !== opened.ino || after.size !== opened.size
      || current.dev !== opened.dev || current.ino !== opened.ino || current.size !== opened.size) throw new Error('file_changed');
    return bytes;
  } finally { closeSync(fd); }
}

function assertPosixPrivate(info, directory) {
  if (process.platform === 'win32') return;
  if (typeof process.getuid === 'function' && info.uid !== process.getuid()) throw new Error('owner_invalid');
  if ((info.mode & 0o777) !== (directory ? 0o700 : 0o600)) throw new Error('mode_invalid');
}

const forbiddenKey = /^(?:token|secret|secret[_-]?value|access[_-]?token|refresh[_-]?token|client[_-]?secret|api[_-]?key|apikey|authorization|password|password[_-]?hash|telegram[_-]?token|bearer|basic|oauth[_-]?(?:code|state|verifier)|code|state|verifier|cookie|credential|private[_-]?key)$/i;
const forbiddenValue = /(?:\b(?:Basic|Bearer)\s+\S+|\b\d{6,12}:[A-Za-z0-9_-]{20,}\b|\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\b|-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:sk-|ghp_|AIza)[A-Za-z0-9_-]{8,}\b|https?:\/\/[^\s/@]+:[^\s/@]+@|https?:\/\/[^\s]+[?&](?:token|code|state|secret|key|api[_-]?key|password|verifier)=[^&#\s]*)/iu;

function validateSafeValue(value, canaries = [], state = { nodes: 0, strings: 0 }, depth = 0) {
  if (depth > 8 || ++state.nodes > 1000) throw new Error('structure_limit');
  if (typeof value === 'string') {
    state.strings += value.length;
    if (value.length > 4096 || state.strings > 128 * 1024 || /[\p{Cc}\p{Cf}]/u.test(value)
      || forbiddenValue.test(value) || canaries.some(canary => canary && value.includes(canary))) throw new Error('unsafe_value');
    return;
  }
  if (typeof value === 'number') { if (!Number.isFinite(value)) throw new Error('unsafe_number'); return; }
  if (typeof value === 'boolean' || value === null) return;
  if (Array.isArray(value)) {
    if (value.length > 128) throw new Error('array_limit');
    for (const item of value) validateSafeValue(item, canaries, state, depth + 1);
    return;
  }
  if (!value || typeof value !== 'object') throw new Error('unsafe_type');
  const keys = Object.keys(value);
  if (keys.length > 128) throw new Error('object_limit');
  for (const key of keys) {
    const normalizedKey = key.replace(/[^A-Za-z0-9]/g, '').toLowerCase();
    if (key.length > 128 || forbiddenKey.test(key)
      || /^(?:token|secret|secretvalue|accesstoken|refreshtoken|clientsecret|apikey|authorization|password|passwordhash|telegramtoken|bearer|basic|oauthcode|oauthstate|oauthverifier|code|state|verifier|cookie|credentials?|privatekey)$/.test(normalizedKey)) throw new Error('secret_key');
    validateSafeValue(value[key], canaries, state, depth + 1);
  }
}

module.exports = {
  secureReadFile, validateSafeValue,
};
