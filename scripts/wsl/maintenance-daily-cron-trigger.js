const parts = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Asia/Seoul', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
}).formatToParts(new Date());
const value = (type) => Number(parts.find((part) => part.type === type)?.value ?? -1);
json({ fire: value('hour') === 3 && value('minute') === 0 });
