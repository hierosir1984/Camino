// WP-105: shared quota / rate-limit signal detection (CAM-EXEC-06). A dispatch
// that hits a provider rate limit or spent-balance block is `quota-blocked`,
// NEVER `requirement-failed`: blaming the worker for the provider's throttle
// would corrupt the outcome ledger and trigger spurious family switches.
//
// Markers are deliberately SPECIFIC error signatures, not bare topic words:
// bare "quota" / "capacity" / "overloaded" matched benign text ("needs
// capacity planning", "not overloaded") — the WP-001 review's finding #2.
// Round-1 review finding 6 tightened two over-broad markers and added the
// providers' CURRENT exhaustion strings:
//   - a bare "429" matched benign issue references ("#429", "issue 429"); it
//     now requires a status-code context (HTTP/status/code/Error … 429, or
//     "429 Too Many Requests");
//   - "retry-after" matched documentation prose ("Retry-After header parsing");
//     it now requires an actual delay value after it;
//   - added the installed Codex "You've hit your usage limit." and Anthropic's
//     documented "Credit balance is too low" conditions.
//
// This is a maintained signature list, not a completeness proof: provider
// wording changes, and the routing layer (WP-106) owns keeping it current.
// Classification is per-line by contract — providers emit a rate-limit signal
// atomically on one line; joining adjacent lines manufactures false positives
// from unrelated text ("success rate\nLimited…") and is deliberately not done
// (WP-001 review #4-r4).
const QUOTA_MARKERS = [
  // A 429 only in a status-code context, never a bare number (kills "#429").
  /\b(?:HTTP|status|code|error)\b[^\n]{0,20}\b429\b/i,
  /\b429\b\s*(?:too many requests|rate)/i,
  /rate[_\s-]?limit(?:ed|_exceeded|\s+exceeded|\s+reached)/i,
  /too many requests/i,
  /usage limit (?:reached|exceeded)/i,
  /you'?ve hit your usage limit/i, // Codex CLI (installed 0.144.x)
  /quota (?:exceeded|exhausted)/i,
  /insufficient[_\s-]?quota/i,
  /credit balance is too low/i, // Anthropic spent-balance block
  /overloaded_error/i, // Anthropic's specific overload error type
  // retry-after only when an actual delay value follows (kills doc prose).
  /retry[_\s-]?after["'\s:=]*\d/i,
  /resource[_\s-]?exhausted/i,
];

export function classifyByQuotaSignal(text: string): boolean {
  return QUOTA_MARKERS.some((re) => re.test(text));
}
