import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const command = process.argv[2];
const args = process.argv.slice(3);

const scripts: Record<string, string> = {
  "test:preflight": "preflight.ts",
  "ranker:extract": "extract_training_data.ts",
  "research:meanrev": "research_meanrev.ts",
  "research:pullback": "research_pullback.ts",
  "research:volbreak": "research_volbreak.ts",
  "research:xsmom": "research_xsmom.ts",
  "backtest": "backtest_setups.ts",
  "db:fix": "fix_db.ts",
  "db:migrate": "../src/migrate.ts",
  "db:setup:screener": "../src/create_screener_tables.ts",
  "confluence": "extract_confluence_data.ts",
  "risk:harden": "harden_risk_config.ts",
};

if (!command || !scripts[command]) {
  console.error("Usage: npm run cli -- <command>");
  console.error("Available commands:");
  Object.keys(scripts).forEach(cmd => console.error(`  ${cmd} -> ${scripts[cmd]}`));
  process.exit(1);
}

const scriptPath = path.resolve(__dirname, scripts[command]);
console.log(`\n🚀 Running ${command} via tsx...\n`);

const child = spawn('npx', ['tsx', scriptPath, ...args], { 
  stdio: 'inherit',
  shell: process.platform === 'win32'
});

child.on('exit', (code) => {
  process.exit(code ?? 0);
});
