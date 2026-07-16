// Load environment variables from .env, resilient to the process working
// directory. The backend is usually launched with cwd = backend/, but the
// canonical .env lives at the project root. This file gets bundled into an ES
// module (dist/index.mjs) where __dirname is undefined, so we resolve paths
// from process.cwd() and walk up toward the filesystem root, loading every
// .env we find. dotenv never clobbers values already present in process.env,
// so the nearest file (loaded first) wins, and the root file fills the rest.
const path = require("path");
const fs = require("fs");
const dotenv = require("dotenv");

let dir = process.cwd();
const seen = new Set();
// Walk up at most a handful of levels: backend/ -> project root is enough,
// but a few extra guards against unusual launch directories.
for (let i = 0; i < 6; i++) {
  const file = path.join(dir, ".env");
  if (!seen.has(file)) {
    seen.add(file);
    if (fs.existsSync(file)) {
      dotenv.config({ path: file });
    }
  }
  const parent = path.dirname(dir);
  if (parent === dir) break; // reached filesystem root
  dir = parent;
}
