/**
 * Mission-content rendering (WP-103, CAM-CORE-02: "attached markdown
 * renders in the mission view"). The daemon renders retained content to
 * HTML and the GUI displays the result — rendering happens on the trusted
 * side, with a CommonMark renderer (micromark) whose default posture
 * encodes raw HTML rather than passing it through. PRD text and uploaded
 * files are untrusted input (CAM-EXEC-09 class): a `<script>` in a pasted
 * PRD must render as visible text, never execute in the GUI.
 *
 * Markdown is first-class; `text` content renders as an escaped
 * preformatted block. Rendering is a projection of the immutably retained
 * content — it never alters the stored original.
 */
import { micromark } from "micromark";
import type { MissionContentFormat } from "@camino/shared";

/** Render retained mission content to HTML for the mission view. */
export function renderMissionContent(content: string, format: MissionContentFormat): string {
  if (format === "markdown") {
    // Default micromark options: raw HTML in the source is encoded, not
    // emitted (allowDangerousHtml is off); dangerous protocols in link/image
    // destinations are dropped.
    return micromark(content);
  }
  return `<pre>${escapeHtml(content)}</pre>`;
}

function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
