// WP-105: shared quota / rate-limit signal detection (CAM-EXEC-06). A dispatch
// that hits a provider rate limit or spent-balance block is `quota-blocked`,
// NEVER `requirement-failed`: blaming the worker for the provider's throttle
// would corrupt the outcome ledger and trigger spurious family switches.
//
// TWO classifiers, because a signal is only reliable in ERROR CONTEXT, not in
// arbitrary assistant prose (round-2 review finding 5 — matching provider
// exhaustion PHRASES anywhere in a worker's answer manufactures false
// positives like "Customer's credit balance is too low for financing"):
//
//   classifyByQuotaSignal(text) — prose-SAFE structured signatures only
//     (HTTP status codes in context, error-type tokens, header syntax). Safe
//     to scan over ANY line, including assistant prose and the lifecycle's
//     raw-line backstop, because these forms do not occur in benign text.
//
//   isProviderExhaustionMessage(text) — the providers' human-readable
//     exhaustion PHRASES ("you've hit your usage limit", "credit balance is
//     too low", "usage limit reached"). Reliable ONLY when the adapter already
//     knows the line is an error/failed-result event — the adapters apply it in
//     their error branches, never to assistant text.
//
// This is a maintained signature list, not a completeness proof: provider
// wording changes, and the routing layer (WP-106) owns keeping it current.
// Classification is per-line by contract — providers emit a signal atomically
// on one line; joining adjacent lines manufactures false positives from
// unrelated text and is deliberately not done (WP-001 review #4-r4).

// Prose-safe structured signatures. Each requires a status/error/header form
// that benign engineering prose does not take.
const STRUCTURED_QUOTA_MARKERS = [
  // A 429/529 status code in a status context — never a bare number, so
  // "#429", "issue 429", "the 429th commit" do NOT match (round-1 finding 6),
  // while "HTTP 429", "Error: 429", `"status_code":429`, `"statusCode": 429` do.
  /\b(?:HTTP\/?[0-9.]*\s*|status[_ ]?code|statuscode|status|code|error)["'\s:=]*(?:429|529)\b/i,
  /\b(?:429|529)\b\s*(?:too many requests|[-–—:])/i,
  /["'\s:](?:429|529)\s*[}\],"]/, // a 4xx as a JSON/bracketed value: {"code":429}
  /too many requests/i,
  // Error-type TOKENS (underscore/dash forms) — these are machine strings, not
  // prose: "rate limiting documentation" (space form) does NOT match.
  /rate[_-]limit(?:_exceeded|_error|ed)\b/i,
  /rate limit (?:exceeded|reached)/i,
  /overloaded_error/i,
  /insufficient[_-]quota/i,
  /quota[_-](?:exceeded|exhausted)/i,
  /resource[_-]exhausted/i,
  // Retry-After only in header syntax (colon/equals then a value) OR as a
  // delay token followed by a number — not "Retry-After header parsing".
  /retry[_\s-]?after\s*[:=]\s*\S/i,
  /retry[_-]after[\s_]+\d/i,
];

// Provider exhaustion phrases — reliable only in an error context (see above).
const EXHAUSTION_PHRASE_MARKERS = [
  /you'?ve hit your usage limit/i, // Codex CLI
  /usage limit (?:reached|exceeded)/i,
  /credit balance is too low/i, // Anthropic spent-balance block
  /quota (?:exceeded|exhausted)/i, // space form (prose-risky, hence error-context only)
  /insufficient quota/i,
];

/** Prose-safe: a structured rate-limit signature is present. */
export function classifyByQuotaSignal(text: string): boolean {
  return STRUCTURED_QUOTA_MARKERS.some((re) => re.test(text));
}

/**
 * Error-context: the text carries a provider exhaustion signal — either a
 * structured signature OR a known exhaustion phrase. Call ONLY when the line is
 * already known to be an error/failed-result event (adapters do this in their
 * error branches); never over assistant prose.
 */
export function classifyErrorTextForQuota(text: string): boolean {
  return classifyByQuotaSignal(text) || EXHAUSTION_PHRASE_MARKERS.some((re) => re.test(text));
}
