/**
 * Mission-content rendering tests (WP-103, CAM-CORE-02: attached markdown
 * renders; retained content is untrusted input, so raw HTML must render as
 * text, never as markup).
 */
import { describe, expect, it } from "vitest";
import { micromark } from "micromark";
import { RENDER_MAX_INPUT_BYTES, renderMissionContent } from "./render.js";

describe("renderMissionContent — markdown (first-class)", () => {
  it("renders headings, lists, emphasis, and code blocks to HTML", () => {
    const html = renderMissionContent(
      "# Evidence viewer\n\nSome **bold** intent.\n\n- first\n- second\n\n```\ncode here\n```\n",
      "markdown",
    );
    expect(html).toContain("<h1>Evidence viewer</h1>");
    expect(html).toContain("<strong>bold</strong>");
    expect(html).toContain("<li>first</li>");
    expect(html).toContain("<pre><code>code here\n</code></pre>");
  });

  it("encodes raw HTML in the source instead of passing it through (untrusted input)", () => {
    const html = renderMissionContent(
      'Before <script>steal("token")</script> after\n\n<img src=x onerror=probe()>\n',
      "markdown",
    );
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;script&gt;");
  });

  it("drops dangerous link protocols", () => {
    const html = renderMissionContent("[click](javascript:probe())", "markdown");
    expect(html).not.toContain("javascript:");
  });

  it("neutralizes images into fetch-free text references (r1 finding 9)", () => {
    for (const source of [
      "![diagram](https://collector.invalid/pixel.png)",
      "![diagram](//collector.invalid/pixel.png)",
      "![diagram](/same-origin-get?x=1)",
      '![diagram](https://collector.invalid/p.png "with title")',
      "![ref][r]\n\n[r]: https://collector.invalid/r.png",
      "![](https://collector.invalid/empty-alt.png)",
    ]) {
      const html = renderMissionContent(source, "markdown");
      expect(html, source).not.toContain("<img");
      expect(html, source).toContain("camino-image-ref");
    }
    const html = renderMissionContent(
      "![diagram](https://collector.invalid/pixel.png)",
      "markdown",
    );
    expect(html).toContain("[image: diagram — https://collector.invalid/pixel.png]");
  });

  it("pins micromark's img emission shape so an upgrade cannot leak one silently", () => {
    // neutralizeImages matches micromark's exact emission. If a micromark
    // upgrade changes the shape, this test fails BEFORE an <img> can leak.
    expect(micromark("![a](https://x.invalid/p.png)")).toBe(
      '<p><img src="https://x.invalid/p.png" alt="a" /></p>',
    );
    expect(micromark('![a](https://x.invalid/p.png "t")')).toBe(
      '<p><img src="https://x.invalid/p.png" alt="a" title="t" /></p>',
    );
  });

  it("renders markdown above the bound as an escaped preformatted block with the reason stated (r1 finding 5)", () => {
    const oversized = "# heading\n" + "[".repeat(RENDER_MAX_INPUT_BYTES);
    const html = renderMissionContent(oversized, "markdown");
    expect(html).toContain("rendering bound");
    expect(html).toContain("<pre>");
    expect(html).not.toContain("<h1>"); // never fed to the markdown parser
    // The full content is shown, never truncated.
    expect(html.length).toBeGreaterThan(RENDER_MAX_INPUT_BYTES);
  });

  it("renders markdown at the bound normally", () => {
    const atBound = "a".repeat(RENDER_MAX_INPUT_BYTES);
    const html = renderMissionContent(atBound, "markdown");
    expect(html).toContain("<p>");
  });

  it("rendering is a projection: the input string is untouched", () => {
    const content = "# Title\n";
    renderMissionContent(content, "markdown");
    expect(content).toBe("# Title\n");
  });
});

describe("renderMissionContent — plain text", () => {
  it("renders text as an escaped preformatted block", () => {
    const html = renderMissionContent('notes with <tags> & "quotes"\nsecond line', "text");
    expect(html).toBe("<pre>notes with &lt;tags&gt; &amp; &quot;quotes&quot;\nsecond line</pre>");
  });
});
