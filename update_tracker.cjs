const fs = require('fs');
const file = process.argv[2];
const issue = process.argv[3] || '';
const fix = process.argv[4] || '';
const evidence = process.argv[5] || 'Verified, no issue';

let t = fs.readFileSync('C:/Users/sahaj/.gemini/antigravity-ide/brain/fdc1e583-92ba-4814-af28-cb362fc7adec/task.md', 'utf8');
t = t.replace('- [ ] `' + file + '`', '- [x] `' + file + '`');
fs.writeFileSync('C:/Users/sahaj/.gemini/antigravity-ide/brain/fdc1e583-92ba-4814-af28-cb362fc7adec/task.md', t);

let a = fs.readFileSync('AUDIT_TRACKER.md', 'utf8');
const regex = new RegExp('\\\| `(?:' + file.replace(/\./g, '\\.') + ')` \\\|([^|]+)\\\|([^|]+)\\\|([^|]+)\\\|');
a = a.replace(regex, '| `' + file + '` |$1|$2| ' + issue + ' | ' + fix + ' | ' + evidence + ' | Complete |');
fs.writeFileSync('AUDIT_TRACKER.md', a);
console.log('Updated ' + file);
