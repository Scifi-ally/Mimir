import "../load-env.cjs";
import { config as dotenvConfig } from "dotenv";
import { defineConfig } from "drizzle-kit";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

dotenvConfig({ path: path.resolve(__dirname, "../.env.local"), override: true });
dotenvConfig({ path: path.resolve(__dirname, "../.env") });

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL must be set. Did you forget to provision a database?");
}

export default defineConfig({
  schema: "./db/src/schema/*.ts",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL,
  },
});
