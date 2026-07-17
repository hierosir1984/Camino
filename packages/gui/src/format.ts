/**
 * Human labels for Appendix A state identifiers (kebab-case) on board cards:
 * `awaiting-merge-approval` → "Awaiting merge approval".
 */
export function formatStateLabel(state: string): string {
  const words = state.split("-").filter((w) => w.length > 0);
  if (words.length === 0) return state;
  const [first, ...rest] = words;
  const head = (first as string).charAt(0).toUpperCase() + (first as string).slice(1);
  return [head, ...rest].join(" ");
}
