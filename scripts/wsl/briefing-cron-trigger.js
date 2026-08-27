const seoul = new Date(new Date().getTime() + 9 * 60 * 60 * 1000);
const hour = seoul.getUTCHours();
const minute = seoul.getUTCMinutes();
json({ fire: minute === 0 && hour >= 8 && hour <= 22 });
