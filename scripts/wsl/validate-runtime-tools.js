#!/usr/bin/env node
'use strict';

try {
  const value = JSON.parse(readBoundedStdin(1024 * 1024));
  if (!value || !Array.isArray(value.tools) || value.tools.length > 32) throw new Error('shape');
  const actual = value.tools.flatMap(tool => {
    if (!tool || !Array.isArray(tool.names) || tool.names.length !== 1 || tool.optional !== true
      || typeof tool.names[0] !== 'string') throw new Error('shape');
    return [{ name: tool.names[0], optional: tool.optional }];
  }).sort((left, right) => left.name.localeCompare(right.name));
  const expected = [
    'assistant_briefing', 'assistant_calendar_manage', 'assistant_mutate',
    'assistant_query', 'assistant_resource_store', 'assistant_study_manage',
  ]
    .map(name => ({ name, optional: true }));
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error('contract');
  process.stdout.write(`${JSON.stringify({ status: 'PASS', count: actual.length, tools: actual })}\n`);
} catch {
  process.stderr.write('runtime_tool_contract_invalid\n');
  process.exit(1);
}

function readBoundedStdin(cap) {
  const chunks = []; let total = 0; const buffer = Buffer.alloc(16 * 1024);
  for (;;) {
    const count = require('node:fs').readSync(0, buffer, 0, buffer.length, null);
    if (count === 0) break;
    total += count; if (total > cap) throw new Error('stdin_too_large');
    chunks.push(Buffer.from(buffer.subarray(0, count)));
  }
  return Buffer.concat(chunks, total).toString('utf8');
}
