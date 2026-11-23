const fs = require('fs');

const lines = fs.readFileSync('live-effect-studio/public/admin.html', 'utf8').split('\n');
console.log(lines.slice(1125, 1260).map((l, i) => `${i + 1126}: ${l.substring(0, 100)}`).join('\n'));
