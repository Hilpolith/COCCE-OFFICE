const CSP = "<meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; img-src data: blob:; style-src 'unsafe-inline'; font-src data:;\">";

export function escapePreviewHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character] ?? character);
}

function safeLink(value: string): string | null {
  const trimmed = value.trim();
  return /^(https?:\/\/|mailto:)/i.test(trimmed) && !/\s/.test(trimmed)
    ? trimmed.replace(/"/g, "%22")
    : null;
}

function inlineMarkdown(value: string): string {
  let output = escapePreviewHtml(value);
  output = output.replace(/\x60([^\x60]+)\x60/g, "<code>$1</code>");
  output = output.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_match, label: string, href: string) => {
    const safe = safeLink(href);
    return safe ? '<a href="' + escapePreviewHtml(safe) + '" rel="noopener noreferrer">' + label + "</a>" : label;
  });
  output = output.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  output = output.replace(/~~([^~]+)~~/g, "<del>$1</del>");
  output = output.replace(/(^|[^*])\*([^*]+)\*/g, "$1<em>$2</em>");
  return output;
}

export function markdownToPreviewHtml(markdown: string): string {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  const output: string[] = [];
  let paragraph: string[] = [];
  let list: "ul" | "ol" | null = null;
  let code: string[] | null = null;

  const flushParagraph = () => {
    if (paragraph.length) output.push("<p>" + paragraph.map(inlineMarkdown).join("<br>") + "</p>");
    paragraph = [];
  };
  const flushList = () => {
    if (list) output.push("</" + list + ">");
    list = null;
  };
  const flushCode = () => {
    if (code) output.push("<pre><code>" + escapePreviewHtml(code.join("\n")) + "</code></pre>");
    code = null;
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (code) {
      if (/^\s*\x60\x60\x60/.test(line)) flushCode();
      else code.push(line);
      continue;
    }
    if (/^\s*\x60\x60\x60/.test(line)) {
      flushParagraph();
      flushList();
      code = [];
      continue;
    }
    if (!line.trim()) {
      flushParagraph();
      flushList();
      continue;
    }
    if (/^\s*(?:---+|\*\*\*|___+)\s*$/.test(line)) {
      flushParagraph();
      flushList();
      output.push("<hr>");
      continue;
    }
    const tableSeparator = /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(lines[index + 1] ?? "");
    if (line.trim().startsWith("|") && tableSeparator) {
      flushParagraph();
      flushList();
      const cells = (value: string) => value.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((cell) => cell.trim());
      const header = cells(line);
      index += 2;
      const rows: string[][] = [];
      while (index < lines.length && lines[index]!.trim().startsWith("|")) rows.push(cells(lines[index++]!));
      index -= 1;
      const headerHtml = "<thead><tr>" + header.map((cell) => "<th>" + inlineMarkdown(cell) + "</th>").join("") + "</tr></thead>";
      const bodyHtml = rows.length ? "<tbody>" + rows.map((row) => "<tr>" + Array.from({ length: header.length }, (_, cell) => "<td>" + inlineMarkdown(row[cell] ?? "") + "</td>").join("") + "</tr>").join("") + "</tbody>" : "";
      output.push("<table>" + headerHtml + bodyHtml + "</table>");
      continue;
    }
    const heading = /^(#{1,6})\s+(.+)$/.exec(line);
    if (heading) {
      flushParagraph();
      flushList();
      const level = heading[1].length;
      output.push("<h" + level + ">" + inlineMarkdown(heading[2]) + "</h" + level + ">");
      continue;
    }
    const quote = /^\s*>\s?(.*)$/.exec(line);
    if (quote) {
      flushParagraph();
      flushList();
      output.push("<blockquote><p>" + inlineMarkdown(quote[1]) + "</p></blockquote>");
      continue;
    }
    const unordered = /^\s*[-*+]\s+(.+)$/.exec(line);
    const ordered = /^\s*\d+[.)]\s+(.+)$/.exec(line);
    if (unordered || ordered) {
      flushParagraph();
      const nextList = unordered ? "ul" : "ol";
      if (list !== nextList) {
        flushList();
        output.push("<" + nextList + ">");
        list = nextList;
      }
      output.push("<li>" + inlineMarkdown((unordered ?? ordered)![1]) + "</li>");
      continue;
    }
    flushList();
    paragraph.push(line);
  }
  flushParagraph();
  flushList();
  flushCode();
  return output.join("\n");
}

export function buildSandboxedHtmlPreview(source: string): string {
  const policy = CSP;
  if (/<head\b[^>]*>/i.test(source)) {
    return source.replace(/<head\b([^>]*)>/i, "<head$1>" + policy);
  }
  if (/<html\b[^>]*>/i.test(source)) {
    return source.replace(/<html\b([^>]*)>/i, "<html$1><head>" + policy + "</head>");
  }
  return "<!doctype html><html><head><meta charset=\"utf-8\">" + policy + "</head><body>" + source + "</body></html>";
}
