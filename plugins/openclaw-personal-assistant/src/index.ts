import {
  buildJsonPluginConfigSchema, definePluginEntry, type OpenClawPluginDefinition,
} from 'openclaw/plugin-sdk/plugin-entry';

import { configSchema, registerAssistantTools } from './tools/register.js';

const entry: OpenClawPluginDefinition = definePluginEntry({
  id: 'openclaw-personal-assistant',
  name: 'OpenClaw Personal Assistant',
  description: 'Owner-scoped local records, dedicated Google calendar, and briefings.',
  configSchema: buildJsonPluginConfigSchema(
    configSchema as unknown as Parameters<typeof buildJsonPluginConfigSchema>[0],
  ),
  register(api) {
    registerAssistantTools(api);
  },
});

export default entry;
