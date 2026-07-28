import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

const rawFiles = execSync('git ls-files', { encoding: 'utf-8' }).split('\n').filter(Boolean);

// Filter out some obvious non-human files that git might track
const files = rawFiles.filter(f => {
    if (f.endsWith('.png') || f.endsWith('.ico') || f.endsWith('.icns') || f.endsWith('.lock') || f.endsWith('.jsonl')) return false;
    if (f.includes('gen/schemas/')) return false;
    return true;
});

function getRiskTier(f) {
    const l = f.toLowerCase();
    // Critical / High - trading logic, auth, money-handling, security
    if (l.includes('trading') || l.includes('auth') || l.includes('security') || l.includes('upstox') || l.includes('secrets') || l.includes('position_tracker') || l.includes('paper_engine') || l.includes('broker_orders') || l.includes('market_data/market_feed') || l.includes('tunnel') || l.includes('env')) {
        return 'Critical';
    }
    if (l.includes('market_data') || l.includes('suggestions') || l.includes('workflow') || l.includes('scheduler') || l.includes('ws/') || l.includes('routes/')) {
        return 'High';
    }
    // Medium - backend logic, main frontend logic
    if (l.includes('backend/') || l.includes('frontend/src/store') || l.includes('frontend/src/workers') || l.includes('lib/')) {
        return 'Medium';
    }
    return 'Low';
}

function getFileType(f) {
    const ext = path.extname(f);
    if (!ext) return 'Config/Script';
    return ext.replace('.', '').toUpperCase();
}

let md = `# MIMIR - Full-Repository Audit & Remediation Tracker\n\n`;

md += `## Phase 0 - File Inventory\n\n`;
md += `| File | Type | Risk Tier | Status |\n`;
md += `|---|---|---|---|\n`;

files.forEach(f => {
    md += `| \`${f}\` | ${getFileType(f)} | ${getRiskTier(f)} | Not Started |\n`;
});

md += `\n## Findings Log\n\n`;
md += `| ID | File:line | Severity | Issue | Root cause | Fix applied | Verification evidence | Status |\n`;
md += `|---|---|---|---|---|---|---|---|\n`;
md += `\n`;

fs.writeFileSync('AUDIT_TRACKER.md', md);
console.log(`Generated AUDIT_TRACKER.md with ${files.length} files.`);
