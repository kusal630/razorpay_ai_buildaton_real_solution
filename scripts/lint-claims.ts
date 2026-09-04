/**
 * Claims-linter over shipped narrative docs + console strings.
 * Usage: npx tsx scripts/lint-claims.ts [files...]
 * Exit 0 iff no banned claims in any file.
 */
import { lintClaims } from "../src/lib/claimsLinter.js";

const files = process.argv.slice(2).length > 0
  ? process.argv.slice(2)
  : ["README.md", "CONTRIBUTING.md", "docs/DEMO.md", "docs/GO_LIVE.md",
     "docs/ARCHITECTURE.md", "docs/SECURITY.md", "docs/PRODUCT_ROADMAP.md",
     "src/public/dashboard/index.html"];

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
