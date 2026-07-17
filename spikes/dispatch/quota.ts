// Shared quota / rate-limit signal detection. A dispatch that hits a provider
// rate limit is `quota-blocked`, NEVER `requirement-failed` (CAM-EXEC-06):
// blaming the worker for the provider's throttle would poison the outcome
// ledger and trigger spurious family switches.
//
// Patterns are deliberately broad and provider-agnostic; each real adapter can
// add provider-specific markers. Registry item 13 tracks the actual quota
// windows — this is only the failure-classification half.
const QUOTA_MARKERS = [
  /\brate[_\s-]?limit/i,
  /\b429\b/,
  /usage limit/i,
  /quota/i,
  /too many requests/i,
  /overloaded/i,
  /retry[_\s-]?after/i,
  /insufficient[_\s-]?quota/i,
  /capacity/i,
];

export function classifyByQuotaSignal(text: string): boolean {
  return QUOTA_MARKERS.some((re) => re.test(text));
}
