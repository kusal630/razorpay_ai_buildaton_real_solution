/**
 * format.ts — single rupee display formatter for every money surface
 * (feed, dashboard cards, pay page). Integer paise in, "₹1,899" out
 * (en-IN grouping, rounded). Machine paths (ledger rationale, API
 * paise fields) keep raw integers — this is display-only.
 */
export function formatINR(paise: number): string {
  const rupees = Math.round(Number(paise || 0) / 100);
  return `₹${rupees.toLocaleString("en-IN")}`;
}
