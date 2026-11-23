const fs = require('fs');

const content = fs.readFileSync('live-effect-studio/public/admin.html', 'utf8');
const lines = content.split('\n');
lines.forEach((l, idx) => {
  if (l.includes('<div class="card') || l.includes('class="card-title') || l.includes('<header') || l.includes('id="jarSection"')) {
    console.log(`Line ${idx + 1}: ${l.trim().substring(0, 100)}`);
  }
});
