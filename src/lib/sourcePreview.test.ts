import { describe, expect, it } from "vitest";
import { buildSandboxedHtmlPreview, escapePreviewHtml, markdownToPreviewHtml } from "./sourcePreview";

describe("source editor previews", () => {
  it("escapes markup and quotes before Markdown formatting", () => {
    expect(escapePreviewHtml("<script>alert('x')</script>")).toBe("&lt;script&gt;alert(&#39;x&#39;)&lt;/script&gt;");
  });

  it("renders common Markdown blocks and inline formatting", () => {
    const tick = String.fromCharCode(96);
    const html = markdownToPreviewHtml("# Heading\n\n**Bold** and *italic* with " + tick + "code" + tick + ".\n\n- One\n- Two\n\n> Note");
    expect(html).toContain("<h1>Heading</h1>");
    expect(html).toContain("<strong>Bold</strong>");
    expect(html).toContain("<em>italic</em>");
    expect(html).toContain("<code>code</code>");
    expect(html).toContain("<ul>");
    expect(html).toContain("<blockquote>");
  });

  it("renders Markdown tables and horizontal rules", () => {
    const html = markdownToPreviewHtml("| Name | Total |\n| --- | ---: |\n| COCCE | **12** |\n\n---");
    expect(html).toContain("<table>");
    expect(html).toContain("<th>Name</th>");
    expect(html).toContain("<td><strong>12</strong></td>");
    expect(html).toContain("<hr>");
  });

  it("rejects unsafe link protocols while retaining safe HTTPS links", () => {
    const html = markdownToPreviewHtml("[safe](https://example.com) [bad](javascript:alert(1))");
    expect(html).toContain('href="https://example.com"');
    expect(html).not.toContain("javascript:");
  });

  it("adds a restrictive content policy to complete and fragment HTML documents", () => {
    expect(buildSandboxedHtmlPreview("<html><head></head><body>ok</body></html>")).toContain("default-src 'none'");
    expect(buildSandboxedHtmlPreview("<main>ok</main>")).toContain("<body><main>ok</main></body>");
  });
});
