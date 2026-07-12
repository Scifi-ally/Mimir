const fs = require('fs');
const path = require('path');

function replaceInFile(filePath) {
    if (!fs.existsSync(filePath)) return;
    let content = fs.readFileSync(filePath, 'utf8');
    content = content.replace(/kronosScore/g, 'patternScore');
    content = content.replace(/kronosWins/g, 'patternWins');
    content = content.replace(/kronosTotal/g, 'patternTotal');
    content = content.replace(/kronosPower/g, 'patternPower');
    content = content.replace(/kronosShift/g, 'patternShift');
    content = content.replace(/kronosCont/g, 'patternCont');
    content = content.replace(/kronosContrib/g, 'patternContrib');
    content = content.replace(/kronosPatterns/g, 'technicalPatterns');
    content = content.replace(/kronos/g, 'technicalRanking');
    content = content.replace(/Kronos/g, 'Technical Ranking');
    fs.writeFileSync(filePath, content);
}

function walkDir(dir) {
    const files = fs.readdirSync(dir);
    for (const file of files) {
        const fullPath = path.join(dir, file);
        if (fs.statSync(fullPath).isDirectory()) {
            walkDir(fullPath);
        } else if (fullPath.endsWith('.ts') || fullPath.endsWith('.tsx')) {
            replaceInFile(fullPath);
        }
    }
}

walkDir('backend/src');
walkDir('frontend/src');
