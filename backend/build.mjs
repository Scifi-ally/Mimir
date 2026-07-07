import * as esbuild from 'esbuild';
import esbuildPluginPino from 'esbuild-plugin-pino';
import { createRequire } from 'module';
globalThis.require = createRequire(import.meta.url);

const options = {
  entryPoints: ['src/index.ts', 'src/api_server.ts', 'src/trading_engine.ts', 'src/migrate.ts', 'src/workers/scan_worker.ts'],
  bundle: true,
  outdir: 'dist',
  platform: 'node',
  format: 'esm',
  banner: {
    js: `import { createRequire } from 'module'; const require = createRequire(import.meta.url);`,
  },
  outExtension: { '.js': '.mjs' },
  sourcemap: true,
  packages: 'external',
  plugins: [esbuildPluginPino({ transports: ['pino-pretty'] })],
};

esbuild.build(options).catch((err) => {
  console.error(err);
  process.exit(1);
});
