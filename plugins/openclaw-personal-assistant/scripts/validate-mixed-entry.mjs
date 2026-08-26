import entry from '../dist/index.js';

const expectedTools = [
  'assistant_briefing',
  'assistant_calendar_confirm',
  'assistant_calendar_prepare',
  'assistant_mutate',
  'assistant_query',
];
const tools = [];
const services = [];
const commands = [];
const hooks = [];
const api = {
  registrationMode: 'full',
  pluginConfig: {
    workspaceDir: '/private/workspace',
    stateDir: '/private/state',
    backupDir: '/private/backups',
    telegramUserId: '123456789',
    timezone: 'Asia/Seoul',
  },
  registerTool(tool, options) { tools.push({ tool, options }); },
  registerService(service) { services.push(service); },
  registerCommand(command) { commands.push(command); },
  registerHook(events, handler, options) { hooks.push({ events, handler, options }); },
};

if (!entry || entry.id !== 'openclaw-personal-assistant' || typeof entry.register !== 'function') {
  throw new Error('mixed_entry_invalid');
}
entry.register(api);
const actualTools = tools.map(({ options }) => options?.name).sort();
if (JSON.stringify(actualTools) !== JSON.stringify(expectedTools) ||
    tools.some(({ options }) => options?.optional !== true) ||
    services.length !== 1 || services[0]?.id !== 'openclaw-personal-assistant-calendar-recovery' ||
    commands.length !== 1 || commands[0]?.name !== 'assistant-confirm' ||
    commands[0]?.requireAuth !== true || commands[0]?.exposeSenderIsOwner !== true ||
    hooks.length !== 0) {
  throw new Error('mixed_entry_registration_invalid');
}
process.stdout.write(JSON.stringify({ status: 'valid', optionalToolCount: tools.length }));
