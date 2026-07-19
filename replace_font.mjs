import fs from 'fs';
import path from 'path';

function walk(dir) {
    let results = [];
    const list = fs.readdirSync(dir);
    list.forEach(function(file) {
        file = path.join(dir, file);
        const stat = fs.statSync(file);
        if (stat && stat.isDirectory()) { 
            results = results.concat(walk(file));
        } else {
            if (file.endsWith('.ts') || file.endsWith('.tsx') || file.endsWith('.css')) {
                results.push(file);
            }
        }
    });
    return results;
}

const files = walk('frontend/src');
let changedCount = 0;
for (const file of files) {
    const content = fs.readFileSync(file, 'utf8');
    const newContent = content.replace(/\bfont-(bold|semibold|medium|black|extrabold|light)\b/g, 'font-normal');
    if (newContent !== content) {
        fs.writeFileSync(file, newContent, 'utf8');
        changedCount++;
    }
}
console.log(`Changed ${changedCount} files.`);
