/**
 * setup.ts — fresh-database setup: apply the migration chain in order, then
 * seed the sample dataset. `npm run setup`.
 */
import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "../src/config.js";

loadConfig();
const db = await import("../src/db.js");

const dir = "src/migrate";
const files = fs.readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
for (const f of files) {
  await db.query(fs.readFileSync(path.join(dir, f), "utf8"));
  console.log(`  migration ${f} OK`);
}
await db.closePool();
console.log("Schema ready — now run: npm run seed");
