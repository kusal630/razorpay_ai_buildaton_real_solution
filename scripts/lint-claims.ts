/**
 * v4.2 P10: claims-linter over narrative docs.
 * Usage: npx tsx scripts/lint-claims.ts [files...]  (default: DEMO.md README.md)
 * Exit 0 iff no banned claims in any file.
 */
import { lintClaims } from "../src/lib/claimsLinter.js";

const files = process.argv.slice(2).length > 0
  ? process.argv.slice(2)
  : ["DEMO.md", "README.md", "PATCH_REPORT.md", "src/public/dashboard/index.html"];

let failed = 0;
for (const f of files) {
  const r = lintClaims(f);
  if (r.passed) {
    console.log(`  ✓ ${f}: clean${r.missingRequired.length > 0 ? " (no required phrase — informational)" : ""}`);
  } else {
    failed++;
    console.log(`  ✗ ${f}:`);
    for (const v of r.violations) console.log(`      ${v}`);
  }
}
console.log(failed === 0 ? "\nCLAIMS LINTER GREEN" : `\nCLAIMS LINTER RED (${failed} files)`);
process.exit(failed === 0 ? 0 : 1);
