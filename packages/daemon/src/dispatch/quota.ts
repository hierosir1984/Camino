// WP-105: shared quota / rate-limit signal detection (CAM-EXEC-06). A dispatch
// that hits a provider rate limit or spent-balance block is `quota-blocked`,
// NEVER `requirement-failed`: blaming the worker for the provider's throttle
// would corrupt the outcome ledger and trigger spurious family switches.
//
// TWO classifiers, because a signal is only reliable in ERROR CONTEXT, not in
// arbitrary assistant prose (round-2/3 finding: matching provider exhaustion
// PHRASES anywhere in a worker's answer manufactures false positives):
//
//   classifyByQuotaSignal(text) — structured, prose-RESISTANT signatures
//     (HTTP status codes in context, error-type tokens, header syntax). Safe
//     to scan over any line because these forms are unusual in benign prose.
//
//   classifyErrorTextForQuota(text) — structured signatures OR the providers'
//     human-readable exhaustion PHRASES. Reliable ONLY when the adapter already
//     knows the line is an error/failed-result/stderr event — the adapters
//     apply it in their error branches, never over assistant text.
//
// BOUNDARY (rounds 2–4): free-text classification cannot PERFECTLY separate a
// real rate-limit error from an error that merely quotes an exhaustion phrase
// (e.g. an assertion failure containing "usage limit reached"), and no fixed
// list of provider wording is complete — providers change strings and add new
// ones. This is a REGENERATING surface (the WP-003 unicode / git-env
// precedent): the list below targets the providers' CURRENT, observed
// exhaustion messages; systematic misclassification is corrected by the
// routing layer's outcome ledger (WP-106), which owns keeping this current.
// WP-105's conformance guarantees (kill-confirm, lease ordering, env posture)
// do not depend on perfect quota classification.

// Prose-resistant structured signatures. Each requires a status/error/header
// form that benign engineering prose is unlikely to take.
const STRUCTURED_QUOTA_MARKERS = [
  // A 429/529 status code in a status context — never a bare number, so
  // "#429", "issue 429", "the 429th commit" do NOT match, while "HTTP 429",
  // "Error: 429", `"status_code":429` do.
  /\b(?:HTTP\/?[0-9.]*\s*|status[_ ]?code|statuscode|status|code|error)["'\s:=]*(?:429|529)\b/i,
  /\b(?:429|529)\b\s*(?:too many requests|[-–—:])/i,
  /["':](?:429|529)\s*[}\],"]/, // a 4xx as a JSON value: {"code":429} (key context, not a comma list)
  /too many requests/i,
  // Error-type TOKENS (underscore/dash forms) — machine strings, not prose:
  // "rate limiting documentation" (space form) does NOT match.
  /rate[_-]limit(?:_exceeded|_error|ed)\b/i,
  /rate limit (?:exceeded|reached)/i,
  /overloaded_error/i,
  /insufficient[_-]quota/i,
  /quota[_-](?:exceeded|exhausted)/i,
  /resource[_-]exhausted/i,
  // Retry-After: header syntax (colon/equals then a value) OR a delay form
  // (retry-after followed by a number) — not "Retry-After header parsing".
  /retry[_\s-]?after\s*[:=]/i,
  /retry[_\s-]?after[\s_]*\d/i,
];

// Provider exhaustion phrases — reliable only in an error context (see above).
// Includes the strings found in the installed Codex 0.144.x and Grok 0.2.x
// binaries (round-4 finding 3); kept current by WP-106.
const EXHAUSTION_PHRASE_MARKERS = [
  /you(?:'ve)? hit your (?:\w+ )?(?:usage )?limit/i, // "you've hit your usage limit", "you hit your weekly/free … limit"
  /(?:usage|rate|weekly|monthly|daily) limit (?:reached|exceeded)/i,
  /exceeded your (?:rate|usage|weekly|monthly|daily) limit/i,
  /(?:credit|usage) balance (?:is too low|exhausted)/i,
  /(?:run(?:ning)? )?out of credits/i,
  /over your spending limit/i,
  /quota (?:exceeded|exhausted)/i, // space form (prose-risky, hence error-context only)
  /insufficient quota/i,
  /please retry after \d/i, // "Please retry after 10 seconds."
];

/** Prose-resistant: a structured rate-limit signature is present. */
export function classifyByQuotaSignal(text: string): boolean {
  return STRUCTURED_QUOTA_MARKERS.some((re) => re.test(text));
}

/**
 * Error-context: the text carries a provider exhaustion signal — a structured
 * signature OR a known exhaustion phrase. Call ONLY when the line is already
 * known to be an error/failed-result/stderr event (adapters do this in their
 * error branches); never over assistant prose.
 */
export function classifyErrorTextForQuota(text: string): boolean {
  return classifyByQuotaSignal(text) || EXHAUSTION_PHRASE_MARKERS.some((re) => re.test(text));
}

/**
 * ALL token-count fields of a vendor usage object that count toward what the
 * run processed. A per-attempt token BUDGET is a runaway guard, so it must sum
 * EVERY consumed-token variant — Anthropic's total input is
 * `input_tokens + cache_creation_input_tokens + cache_read_input_tokens`, plus
 * `output_tokens` (prompt-caching docs). Excluding the cache fields let a run
 * that consumed thousands of cache-read tokens slip a small budget (round-1
 * finding 6). Cheaper-per-token ≠ not-consumed; a hard cap counts them all.
 */
const USAGE_TOKEN_FIELDS = [
  "input_tokens",
  "output_tokens",
  "cache_creation_input_tokens",
  "cache_read_input_tokens",
] as const;

/**
 * Sum a vendor usage object's token counts (WP-107, CAM-EXEC-03 "tokens where
 * reportable"). Total over hostile/absent shapes: any non-record usage yields
 * undefined ("not reportable"); a non-finite/negative field is skipped, never a
 * throw and never a partial figure treated as authoritative. Returns undefined
 * only when NO recognized token field is present.
 */
export function sumUsageTokens(usage: unknown): number | undefined {
  if (usage === null || typeof usage !== "object" || Array.isArray(usage)) return undefined;
  const rec = usage as Record<string, unknown>;
  const nums = USAGE_TOKEN_FIELDS.map((f) => rec[f]).filter(
    (v): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0,
  );
  if (nums.length === 0) return undefined;
  const total = nums.reduce((a, b) => a + b, 0);
  // Fail-CLOSED on overflow (round-2 finding 9): a sum that leaves the finite
  // range (hostile 1e308 fields) must not be discarded as "not reportable" —
  // clamp to MAX_SAFE_INTEGER so it TRIPS any budget rather than evading it.
  return Number.isFinite(total) ? total : Number.MAX_SAFE_INTEGER;
}
