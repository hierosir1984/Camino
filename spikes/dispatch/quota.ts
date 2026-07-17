// Shared quota / rate-limit signal detection. A dispatch that hits a provider
// rate limit is `quota-blocked`, NEVER `requirement-failed` (CAM-EXEC-06):
// blaming the worker for the provider's throttle would poison the outcome
// ledger and trigger spurious family switches.
//
// Markers are deliberately SPECIFIC error signatures, not bare topic words:
// bare "quota" / "capacity" / "overloaded" matched benign text ("needs
// capacity planning", "not overloaded") — the WP-001 review's finding #2. Each
// pattern below names an actual rate-limit condition as the providers emit it.
const QUOTA_MARKERS = [
  /\b429\b/,
  /rate[_\s-]?limit(?:ed|_exceeded|\s+exceeded|\s+reached)/i,
  /too many requests/i,
  /usage limit (?:reached|exceeded)/i,
  /quota (?:exceeded|exhausted)/i,
  /insufficient[_\s-]?quota/i,
  /overloaded_error/i, // Anthropic's specific overload error type
  /retry[_\s-]?after/i,
  /resource[_\s-]?exhausted/i,
];

export function classifyByQuotaSignal(text: string): boolean {
  return QUOTA_MARKERS.some((re) => re.test(text));
}
