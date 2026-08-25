export const MAX_TELEGRAM_USER_ID = '9223372036854775807';
export const TELEGRAM_USER_ID_PATTERN = positiveDecimalPattern(MAX_TELEGRAM_USER_ID);

const TELEGRAM_USER_ID = new RegExp(TELEGRAM_USER_ID_PATTERN);

export class TelegramUserIdError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TelegramUserIdError';
  }
}

export function normalizeTelegramUserId(value: unknown): string {
  if (typeof value !== 'string' || !TELEGRAM_USER_ID.test(value)) {
    throw new TelegramUserIdError(
      `Telegram user ID must be a canonical positive decimal at most ${MAX_TELEGRAM_USER_ID}`,
    );
  }
  return value;
}

function positiveDecimalPattern(maximum: string): string {
  const branches = [`[1-9][0-9]{0,${maximum.length - 2}}`];
  for (let index = 0; index < maximum.length; index += 1) {
    const maximumDigit = Number(maximum[index]);
    const minimumDigit = index === 0 ? 1 : 0;
    if (maximumDigit <= minimumDigit) continue;
    const prefix = maximum.slice(0, index);
    const digit = maximumDigit - 1 === minimumDigit
      ? String(minimumDigit)
      : `[${minimumDigit}-${maximumDigit - 1}]`;
    const remaining = maximum.length - index - 1;
    branches.push(`${prefix}${digit}${remaining === 0 ? '' : `[0-9]{${remaining}}`}`);
  }
  branches.push(maximum);
  return `^(?:${branches.join('|')})$`;
}
