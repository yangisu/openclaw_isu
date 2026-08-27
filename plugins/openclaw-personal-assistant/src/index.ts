import {
  buildJsonPluginConfigSchema, definePluginEntry, type OpenClawPluginDefinition,
} from 'openclaw/plugin-sdk/plugin-entry';

import { configSchema, registerAssistantTools } from './tools/register.js';
import { registerAssistantCommands } from './commands/register.js';
import { registerStudyInteractiveHandler } from './commands/telegram-study.js';

const entry: OpenClawPluginDefinition = definePluginEntry({
  id: 'openclaw-personal-assistant',
  name: 'OpenClaw Personal Assistant',
  description: 'Owner-scoped local records, dedicated Google calendar, and briefings.',
  configSchema: buildJsonPluginConfigSchema(
    configSchema as unknown as Parameters<typeof buildJsonPluginConfigSchema>[0],
  ),
  register(api) {
    registerAssistantTools(api);
    if (api.registrationMode === 'full') {
      registerAssistantCommands(api);
      registerStudyInteractiveHandler(api);
    }
  },
});

export default entry;
