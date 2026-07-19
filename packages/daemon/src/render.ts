/**
 * Mission-content rendering (WP-103, CAM-CORE-02: "attached markdown
 * renders in the mission view"). The daemon renders retained content to
 * HTML and the GUI displays the result — rendering happens on the trusted
 * side, with a CommonMark renderer (micromark) whose default posture
 * encodes raw HTML rather than passing it through. PRD text and uploaded
 * files are untrusted input (CAM-EXEC-09 class): a `<script>` in a pasted
 * PRD must render as visible text, never execute in the GUI.
 *
 * Safety posture, stated exactly (r1 findings 5 and 9):
 * - Script-inert, not resource-inert by default: micromark encodes raw HTML
 *   and blanks dangerous link protocols, but markdown IMAGE syntax would
 *   emit `<img src>` — an automatic remote/same-origin GET (a beacon) the
 *   moment the GUI displays it. This module therefore neutralizes images
 *   into visible text references; no rendered output initiates a fetch.
 *   Links remain links (navigation is a user action). A content-security
 *   policy on the GUI side is still the backstop — recorded as an
 *   obligation for the GUI work packages, not silently assumed here.
 * - Bounded rendering: micromark's resource use is content-dependent and
 *   super-linear on pathological inputs (a 1 MiB bracket run costs ~1.25 GB
 *   RSS). Markdown above RENDER_MAX_INPUT_BYTES renders as an escaped
 *   preformatted block with the reason stated inline — shown, never
 *   truncated, never fed to the markdown parser.
 *
 * Rendering is a projection of the immutably retained content — it never
 * alters the stored original.
 */
import { micromark } from "micromark";
import type { MissionContentFormat } from "@camino/shared";

/**
 * Upper bound on input handed to the markdown parser (bytes of UTF-8).
 * Chosen against the measured pathological cost (~1.1 KB RSS per input
 * byte on bracket runs → ~70 MB transient at this bound) — far above any
 * real PRD, far below daemon-threatening.
 */
export const RENDER_MAX_INPUT_BYTES = 64 * 1024;

/** Render retained mission content to HTML for the mission view. */
export function renderMissionContent(content: string, format: MissionContentFormat): string {
  if (format === "markdown") {
    const size = Buffer.byteLength(content, "utf8");
    if (size > RENDER_MAX_INPUT_BYTES) {
      return (
        `<p><em>Content is ${size} bytes — above the ${RENDER_MAX_INPUT_BYTES}-byte markdown ` +
        "rendering bound — and is shown as plain text instead (the retained original is " +
        "unchanged).</em></p>" +
        `<pre>${escapeHtml(content)}</pre>`
      );
    }
    // Default micromark options: raw HTML in the source is encoded, not
    // emitted (allowDangerousHtml is off); dangerous protocols in link/image
    // destinations are dropped.
    return neutralizeImages(micromark(content));
  }
  return `<pre>${escapeHtml(content)}</pre>`;
}

/**
 * Replace every rendered `<img>` with a visible, fetch-free text reference.
 *
 * Soundness of the textual match: with raw HTML encoding ON, every literal
 * `<` from the source arrives as `&lt;` — the only `<img` sequences in
 * micromark output are micromark's own image emissions, whose exact shape
 * is `<img src="…" alt="…"` + optional ` title="…"` + ` />` with
 * attribute values HTML-encoded (no raw `"` or `>` inside). The regex
 * below matches precisely that shape; a test pins the emission shape so a
 * micromark upgrade that changes it fails loudly instead of leaking an
 * `<img>` through.
 */
function neutralizeImages(html: string): string {
  return html.replace(
    /<img src="([^"]*)" alt="([^"]*)"(?: title="[^"]*")? \/>/g,
    (_match, src: string, alt: string) =>
      `<span class="camino-image-ref">[image${alt.length > 0 ? `: ${alt}` : ""}${
        src.length > 0 ? ` — ${src}` : ""
      }]</span>`,
  );
}

function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
