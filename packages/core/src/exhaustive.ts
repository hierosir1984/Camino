/**
 * Compile-time + runtime exhaustiveness guard for the Appendix A state
 * machines (WP-101): a `switch` over a state/event union calls
 * `exhaustive(value)` in its `default` branch. If a variant is unhandled,
 * TypeScript rejects the call (the argument is not `never`); if an illegal
 * value arrives at runtime anyway, this throws instead of silently passing —
 * illegal transitions are rejected and logged, never absorbed (CAM-STATE-05).
 */
export function exhaustive(value: never, context = "value"): never {
  throw new Error(`Unhandled ${context}: ${JSON.stringify(value)}`);
}
