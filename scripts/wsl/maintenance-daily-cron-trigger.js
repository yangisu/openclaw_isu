const seoul = new Date(new Date().getTime() + 9 * 60 * 60 * 1000);
json({ fire: seoul.getUTCHours() === 3 && seoul.getUTCMinutes() === 0 });
