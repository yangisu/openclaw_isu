import entry from '../dist/index.js';

const expectedTools = [
  'assistant_briefing',
  'assistant_calendar_manage',
  'assistant_mutate',
  'assistant_query',
  'assistant_resource_store',
  'assistant_study_manage',
];
const tools = [];
const services = [];
const commands = [];
const hooks = [];
const interactiveHandlers = [];
const api = {
  registrationMode: 'full',
  pluginConfig: {
    workspaceDir: '/private/workspace',
    stateDir: '/private/state',
    backupDir: '/private/backups',
    telegramUserId: '123456789',
    timezone: 'Asia/Seoul',
    calendar: {
      provider: 'google',
      googleOAuthClientFile: '/private/secrets/google-oauth-client',
      googleTokenFile: '/private/secrets/google-oauth-token',
      googleCalendarBindingFile: '/private/secrets/google-calendar-binding',
      expectedAccount: 'yangisu12@gmail.com',
    },
  },
  registerTool(tool, options) { tools.push({ tool, options }); },
  registerService(service) { services.push(service); },
  registerCommand(command) { commands.push(command); },
  registerInteractiveHandler(handler) { interactiveHandlers.push(handler); },
  registerHook(events, handler, options) { hooks.push({ events, handler, options }); },
};

if (!entry || entry.id !== 'openclaw-personal-assistant' || typeof entry.register !== 'function') {
  throw new Error('mixed_entry_invalid');
}
entry.register(api);
const actualTools = tools.map(({ options }) => options?.name).sort();
if (JSON.stringify(actualTools) !== JSON.stringify(expectedTools) ||
    tools.some(({ options }) => options?.optional !== true) ||
    services.length !== 1 || services[0]?.id !== 'openclaw-personal-assistant-study-coach' ||
    JSON.stringify(commands.map(command => command.name).sort()) !== JSON.stringify(['find', 'memo', 'save', 'study']) ||
    interactiveHandlers.length !== 1 || interactiveHandlers[0]?.channel !== 'telegram'
      || interactiveHandlers[0]?.namespace !== 'ocstudy' ||
    hooks.length !== 0) {
  throw new Error('mixed_entry_registration_invalid');
}
process.stdout.write(JSON.stringify({ status: 'valid', optionalToolCount: tools.length }));
