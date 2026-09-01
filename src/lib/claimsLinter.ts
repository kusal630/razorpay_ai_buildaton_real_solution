import fs from "node:fs";
import path from "node:path";
import { createLogger } from "../logger.js";

const log = createLogger("claimsLinter");

/**
 * C6: Claims-linter v2 - BANNED and REQUIRED phrases.
 */

// C6: BANNED in linter-scanned files
const BANNED_PATTERNS = [
  /\bguaranteed\b/i,
  /\bno side door exists\b/i,
  /\bunkillable\b/i,
  /\bwe process payments\b/i,
  /\bcannot fail\b/i,
  /\bdouble-spend\b/i,
];

// C6: REQUIRED phrases (at least one must appear in scanned files)
const REQUIRED_PATTERNS = [
  /at-most-once.*with.*reconciliation.*detecting.*anomalies/i,
  /append-only.*access-controlled.*tamper-evident/i,
  /transactional consent covers payment-status and failure recovery without incentives/i,
  /incentivized recovery and upsell require marketing consent/i,
  /estimated until reconciliation/i,
];

// C6: Allowlist file
const ALLOWLIST_PATH = ".claims-allowlist";

/**
 * C6: Load allowlist (known exceptions).
 */
function loadAllowlist(): string[] {
  try {
    const content = fs.readFileSync(ALLOWLIST_PATH, "utf8");
    return content.split("\n").filter((line) => line.trim() && !line.startsWith("#"));
  } catch {
    return [];
  }
}

/**
 * C6: Lint a file for claims compliance.
 * Returns { passed: boolean, violations: string[] }.
 */
export function lintClaims(filePath: string): {
  passed: boolean;
  violations: string[];
  missingRequired: string[];
} {
  const violations: string[] = [];
  const missingRequired: string[] = [];

  try {
    const content = fs.readFileSync(filePath, "utf8");
    const allowlist = loadAllowlist();

    // Check banned patterns
    for (const pattern of BANNED_PATTERNS) {
      const matches = content.match(pattern);
      if (matches && !allowlist.some((a) => matches[0].includes(a))) {
        violations.push(`BANNED: "${matches[0]}" found in ${filePath}`);
      }
    }

    // Check required patterns (at least one must appear)
    const hasAnyRequired = REQUIRED_PATTERNS.some((p) => p.test(content));
    if (!hasAnyRequired) {
      missingRequired.push(`No required claims found in ${filePath}`);
    }
  } catch (err: any) {
    violations.push(`Error reading ${filePath}: ${err.message}`);
  }

  return {
    passed: violations.length === 0,
    violations,
    missingRequired,
  };
}

/**
 * C6: Lint all TypeScript files in a directory.
 */
export function lintAllClaims(dir: string): {
  totalFiles: number;
  passedFiles: number;
  failedFiles: number;
  violations: string[];
} {
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".ts"));
  let passed = 0;
  let failed = 0;
  const allViolations: string[] = [];

  for (const file of files) {
    const filePath = path.join(dir, file);
    const result = lintClaims(filePath);

    if (result.passed) {
      passed++;
    } else {
      failed++;
      allViolations.push(...result.violations);
    }
  }

  return {
    totalFiles: files.length,
    passedFiles: passed,
    failedFiles: failed,
    violations: allViolations,
  };
}
