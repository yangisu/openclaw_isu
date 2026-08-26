import {
  buildJsonPluginConfigSchema, definePluginEntry, type OpenClawPluginDefinition,
} from 'openclaw/plugin-sdk/plugin-entry';

import { configSchema, registerAssistantTools } from './tools/register.js';
import { createCalendarRecoveryService } from './calendar/recovery-service.js';

const entry: OpenClawPluginDefinition = definePluginEntry({
  id: 'openclaw-personal-assistant',
  name: 'OpenClaw Personal Assistant',
  description: 'Owner-scoped local records, Naver calendar, and briefings.',
  configSchema: buildJsonPluginConfigSchema(
    configSchema as unknown as Parameters<typeof buildJsonPluginConfigSchema>[0],
  ),
  register(api) {
    registerAssistantTools(api);
    if (api.registrationMode !== 'full') return;
    api.registerCommand({
      name: 'assistant-confirm',
      description: 'Check a prepared calendar request confirmation boundary.',
      acceptsArgs: true,
      requireAuth: true,
      exposeSenderIsOwner: true,
      channels: ['telegram'],
      handler: () => ({
        text: 'Calendar confirmation is unavailable until the host supplies non-forwarded inbound provenance.',
      }),
    });
    api.registerService(createCalendarRecoveryService(api));
  },
});

export default entry;
