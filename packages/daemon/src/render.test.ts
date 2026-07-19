/**
 * Mission-content rendering tests (WP-103, CAM-CORE-02: attached markdown
 * renders; retained content is untrusted input, so raw HTML must render as
 * text, never as markup).
 */
import { describe, expect, it } from "vitest";
import { renderMissionContent } from "./render.js";

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
