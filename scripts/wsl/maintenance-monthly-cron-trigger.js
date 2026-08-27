const seoul = new Date(new Date().getTime() + 9 * 60 * 60 * 1000);
json({ fire: seoul.getUTCDate() === 1 && seoul.getUTCHours() === 4 && seoul.getUTCMinutes() === 0 });
