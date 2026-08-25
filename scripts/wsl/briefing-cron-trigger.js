const parts = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Asia/Seoul',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
}).formatToParts(new Date());
const value = (type) => Number(parts.find((part) => part.type === type)?.value ?? -1);
const hour = value('hour');
const minute = value('minute');
json({ fire: minute === 0 && hour >= 8 && hour <= 22 });
