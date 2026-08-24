export interface AssistantConfig {
  workspaceDir: string;
  stateDir: string;
  backupDir: string;
  telegramUserId: string;
  timezone: 'Asia/Seoul';
}

export function loadConfig(raw: unknown): AssistantConfig {
  const value = raw as Partial<AssistantConfig>;
  for (const key of ['workspaceDir', 'stateDir', 'backupDir'] as const) {
    const path = value[key];
    if (!path?.startsWith('/') || path.includes('/../')) throw new Error(`invalid ${key}`);
  }
  if (!/^\d+$/.test(value.telegramUserId ?? '')) throw new Error('invalid telegramUserId');
  if (value.timezone !== 'Asia/Seoul') throw new Error('timezone must be Asia/Seoul');
  return value as AssistantConfig;
}
