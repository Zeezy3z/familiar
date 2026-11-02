/** Compact only the available preview. Expanding cannot recover text omitted by a provider.
 * A pending approval is never compacted: whatever you approve is on the card, tail included. */
export function approvalPreview(text: string, expanded = false, pending = false) {
  if (pending) return { text, shortened: false };
  const compact = text.split("\n").slice(0, 8).join("\n").slice(0, 600);
  return { text: expanded ? text : compact, shortened: compact.length < text.length };
}
