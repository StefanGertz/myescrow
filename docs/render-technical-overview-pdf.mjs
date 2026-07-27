import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const [
  markdownArg = "MYESCROW_TECHNICAL_OVERVIEW.md",
  htmlArg = "MYESCROW_TECHNICAL_OVERVIEW.html",
] = process.argv.slice(2);
const markdownPath = path.resolve(markdownArg);
const htmlPath = path.resolve(htmlArg);
const markdown = await readFile(markdownPath, "utf8");

const escapeHtml = (value) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

const inline = (value) => {
  const code = [];
  let rendered = value.replace(/`([^`]+)`/g, (_match, contents) => {
    const token = `@@CODE${code.length}@@`;
    code.push(`<code>${escapeHtml(contents)}</code>`);
    return token;
  });
  rendered = escapeHtml(rendered)
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(https:\/\/[^\s<]+)/g, '<a href="$1">$1</a>');
  code.forEach((contents, index) => {
    rendered = rendered.replace(`@@CODE${index}@@`, contents);
  });
  return rendered;
};

const tableCells = (line) =>
  line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());

const lines = markdown.split(/\r?\n/);
const output = [];
let paragraph = [];
let listType = null;
let listItemOpen = false;
let nestedListOpen = false;

const closeParagraph = () => {
  if (!paragraph.length) return;
  output.push(`<p>${inline(paragraph.join(" "))}</p>`);
  paragraph = [];
};

const closeNestedList = () => {
  if (!nestedListOpen) return;
  output.push("</ul>");
  nestedListOpen = false;
};

const closeListItem = () => {
  closeNestedList();
  if (!listItemOpen) return;
  output.push("</li>");
  listItemOpen = false;
};

const closeList = () => {
  if (!listType) return;
  closeListItem();
  output.push(`</${listType}>`);
  listType = null;
};

const openListItem = (type, contents) => {
  closeParagraph();
  if (listType !== type) {
    closeList();
    output.push(`<${type}>`);
    listType = type;
  } else {
    closeListItem();
  }
  output.push(`<li>${inline(contents)}`);
  listItemOpen = true;
};

for (let index = 0; index < lines.length; index += 1) {
  const line = lines[index];

  if (line.startsWith("```")) {
    closeParagraph();
    closeList();
    const language = line.slice(3).trim();
    const code = [];
    index += 1;
    while (index < lines.length && !lines[index].startsWith("```")) {
      code.push(lines[index]);
      index += 1;
    }
    output.push(
      `<pre data-language="${escapeHtml(language)}"><code>${escapeHtml(code.join("\n"))}</code></pre>`,
    );
    continue;
  }

  const heading = line.match(/^(#{1,3})\s+(.+)$/);
  if (heading) {
    closeParagraph();
    closeList();
    const level = heading[1].length;
    output.push(`<h${level}>${inline(heading[2])}</h${level}>`);
    continue;
  }

  const nextLine = lines[index + 1] ?? "";
  if (
    line.trim().startsWith("|")
    && /^\s*\|?(?:\s*:?-+:?\s*\|)+\s*:?-+:?\s*\|?\s*$/.test(nextLine)
  ) {
    closeParagraph();
    closeList();
    const headers = tableCells(line);
    output.push("<table><thead><tr>");
    headers.forEach((header) => output.push(`<th>${inline(header)}</th>`));
    output.push("</tr></thead><tbody>");
    index += 2;
    while (index < lines.length && lines[index].trim().startsWith("|")) {
      output.push("<tr>");
      tableCells(lines[index]).forEach((cell) => output.push(`<td>${inline(cell)}</td>`));
      output.push("</tr>");
      index += 1;
    }
    output.push("</tbody></table>");
    index -= 1;
    continue;
  }

  const nestedItem = line.match(/^\s{2,}[-*]\s+(.+)$/);
  if (nestedItem && listType === "ol" && listItemOpen) {
    closeParagraph();
    if (!nestedListOpen) {
      output.push('<ul class="nested-list">');
      nestedListOpen = true;
    }
    output.push(`<li>${inline(nestedItem[1])}</li>`);
    continue;
  }

  const unorderedItem = line.match(/^[-*]\s+(.+)$/);
  if (unorderedItem) {
    openListItem("ul", unorderedItem[1]);
    continue;
  }

  const orderedItem = line.match(/^\d+\.\s+(.+)$/);
  if (orderedItem) {
    openListItem("ol", orderedItem[1]);
    continue;
  }

  if (!line.trim()) {
    closeParagraph();
    closeList();
    continue;
  }

  if (listType && listItemOpen) {
    closeList();
  }
  paragraph.push(line.trim());
}

closeParagraph();
closeList();

const documentHtml = output.join("\n");
const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>MyEscrow product and technical overview</title>
    <style>
      @page { size: A4; margin: 20mm 17mm 18mm; }
      * { box-sizing: border-box; }
      html { background: #dfe9ed; }
      body {
        margin: 0;
        color: #263d49;
        background: #fff;
        font-family: Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        font-size: 9.2pt;
        line-height: 1.44;
        -webkit-print-color-adjust: exact;
        print-color-adjust: exact;
      }
      main { width: 100%; }
      h1, h2, h3 {
        color: #073b5c;
        line-height: 1.15;
        break-after: avoid;
        page-break-after: avoid;
      }
      h1 {
        margin: 44mm 0 8mm;
        max-width: 165mm;
        font-size: 34pt;
        letter-spacing: -.035em;
      }
      h1::before {
        content: "MYESCROW";
        display: block;
        margin-bottom: 5mm;
        color: #1c8f8b;
        font-size: 10pt;
        font-weight: 800;
        letter-spacing: .22em;
      }
      h1 + p,
      h1 + p + p,
      h1 + p + p + p {
        max-width: 145mm;
        color: #5b717d;
        font-size: 12pt;
      }
      h1 + p + p + p {
        margin-top: 8mm;
        padding: 6mm;
        border-left: 1.5mm solid #1c8f8b;
        background: #eef8f7;
        color: #173e4c;
        font-weight: 700;
      }
      h2 {
        margin: 0 0 6mm;
        padding: 6mm 0 3.5mm;
        border-bottom: .55mm solid #b9d6d7;
        font-size: 20pt;
        letter-spacing: -.015em;
        break-before: page;
        page-break-before: always;
      }
      h3 {
        margin: 6mm 0 3.5mm;
        padding-left: 3.5mm;
        border-left: 1.2mm solid #1c8f8b;
        font-size: 13.5pt;
      }
      p { margin: 0 0 3.6mm; }
      strong { color: #0b526b; }
      a { color: #087c83; text-decoration: none; }
      code {
        padding: .3mm 1mm;
        border-radius: 1mm;
        background: #edf3f5;
        color: #0b526b;
        font-family: "SFMono-Regular", Consolas, monospace;
        font-size: .88em;
      }
      pre {
        margin: 4mm 0 6mm;
        padding: 4.5mm;
        border-radius: 2.5mm;
        background: #102f43;
        color: #f3f8fa;
        font-family: "SFMono-Regular", Consolas, monospace;
        font-size: 7.9pt;
        line-height: 1.45;
        white-space: pre-wrap;
        overflow-wrap: anywhere;
        break-inside: avoid;
        page-break-inside: avoid;
      }
      pre code { padding: 0; background: transparent; color: inherit; font-size: inherit; }
      ul, ol { margin: 2.5mm 0 5mm; padding-left: 6.5mm; }
      li { padding-left: 1mm; }
      li + li { margin-top: 1.3mm; }
      .nested-list { margin: 2mm 0 1mm; }
      table {
        width: 100%;
        margin: 4mm 0 7mm;
        border-collapse: collapse;
        font-size: 8.15pt;
        line-height: 1.38;
      }
      thead { display: table-header-group; }
      tr { break-inside: avoid; page-break-inside: avoid; }
      th {
        padding: 2.6mm 2.4mm;
        background: #0b526b;
        color: #fff;
        font-weight: 700;
        text-align: left;
        vertical-align: top;
      }
      td {
        padding: 2.5mm 2.4mm;
        border-bottom: .25mm solid #d8e3e7;
        text-align: left;
        vertical-align: top;
      }
      tbody tr:nth-child(even) td { background: #f4f8f9; }
      table code { white-space: normal; }
      @media print {
        html, body { background: #fff; }
      }
    </style>
  </head>
  <body>
    <main>${documentHtml}</main>
  </body>
</html>`;

await writeFile(htmlPath, html, "utf8");
console.log(`Rendered ${markdownPath} to ${htmlPath}`);
