// @camino/core — pure domain logic only. The ESLint fence (eslint.config.mjs)
// rejects Node builtins, persistence, and other Camino packages here; the
// Appendix A state machines land in WP-101 behind this boundary.
export { exhaustive } from "./exhaustive.js";
