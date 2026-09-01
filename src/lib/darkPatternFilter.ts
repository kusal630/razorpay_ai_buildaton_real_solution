import { createLogger } from "../logger.js";

const log = createLogger("darkPatternFilter");

// H4: Banned patterns for dark patterns
const DARK_PATTERNS = [
  /only\s+\d+\s+(?:left|remaining|available)/i, // Fabricated scarcity
  /(?:hurry|act\s+now|last\s+(?:chance|chance|chance))/i, // False urgency
  /(?:\d+\s+(?:min|hour|sec|seconds|minutes|hours)\s+(?:left|remaining))/i, // Fake countdown
  /(?:exclusive|special)\s+(?:offer|deal|discount)\s+(?:only|just)/i, // False exclusivity
  /(?:guaranteed|100%\s+(?:success|profit|return))/i, // False guarantees
  /(?:limited\s+time|ending\s+(?:soon|today))/i, // False time pressure
];

// H4: Required disclosures for incentive offers
const REQUIRED_DISCLOSURES = [
  /special\s+offer\s+applied/i,
  /incentive\s+applied/i,
  /discount\s+applied/i,
];

/**
 * H4: Check if generated copy contains dark patterns.
 * Returns { passed: boolean, violations: string[] }.
 */
export function checkDarkPatterns(copy: string): {
  passed: boolean;
  violations: string[];
} {
  const violations: string[] = [];

  for (const pattern of DARK_PATTERNS) {
    if (pattern.test(copy)) {
      violations.push(`Dark pattern detected: ${pattern.source}`);
    }
  }

  return {
    passed: violations.length === 0,
    violations,
  };
}

/**
 * H4: Check if required disclosures are present when incentive > 0.
 */
export function checkRequiredDisclosures(
  copy: string,
  incentivePaise: number
): { passed: boolean; missing: string[] } {
  if (incentivePaise <= 0) {
    return { passed: true, missing: [] };
  }

  const missing: string[] = [];

  for (const pattern of REQUIRED_DISCLOSURES) {
    if (!pattern.test(copy)) {
      missing.push(`Missing disclosure: ${pattern.source}`);
    }
  }

  return {
    passed: missing.length === 0,
    missing,
  };
}

/**
 * H4: Sanitize copy - remove dark patterns and regenerate if needed.
 * Falls back to approved static template.
 */
export function sanitizeCopy(
  copy: string,
  incentivePaise: number
): { sanitized: string; wasFiltered: boolean; fallbackUsed: boolean } {
  const { passed: darkPatternOk, violations } = checkDarkPatterns(copy);

  if (darkPatternOk) {
    // Check disclosures
    const { passed: disclosureOk } = checkRequiredDisclosures(copy, incentivePaise);
    if (disclosureOk) {
      return { sanitized: copy, wasFiltered: false, fallbackUsed: false };
    }
  }

  // Filter: remove dark patterns
  let sanitized = copy;
  for (const pattern of DARK_PATTERNS) {
    sanitized = sanitized.replace(pattern, "");
  }

  // Add disclosure if incentive > 0
  if (incentivePaise > 0 && !checkRequiredDisclosures(sanitized, incentivePaise).passed) {
    sanitized = `${sanitized} (Special offer applied)`;
  }

  // Verify filtered copy is clean
  const { passed: filteredOk } = checkDarkPatterns(sanitized);
  if (!filteredOk) {
    // Use static template
    log.warn({ violations }, "Copy still contains dark patterns after filtering, using template");
    return {
      sanitized: incentivePaise > 0
        ? "Complete your purchase. (Special offer applied)"
        : "Complete your purchase.",
      wasFiltered: true,
      fallbackUsed: true,
    };
  }

  return { sanitized, wasFiltered: true, fallbackUsed: false };
}
