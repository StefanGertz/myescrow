import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const [markdownPathArg, htmlPathArg, mermaidScriptArg, markedScriptArg] = process.argv.slice(2);

if (!markdownPathArg || !htmlPathArg || !mermaidScriptArg || !markedScriptArg) {
  throw new Error(
    "Usage: node render-unhappy-workflows-pdf.mjs <markdown> <html-output> <mermaid-script> <marked-script>",
  );
}

const markdownPath = path.resolve(markdownPathArg);
const htmlPath = path.resolve(htmlPathArg);
const mermaidScriptPath = path.resolve(mermaidScriptArg);
const markedScriptPath = path.resolve(markedScriptArg);
const markdown = await readFile(markdownPath, "utf8");
const { marked } = await import(pathToFileURL(markedScriptPath).href);

const escapeHtml = (value) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");

const renderer = new marked.Renderer();
renderer.code = (token) => {
  const text = typeof token === "string" ? token : token.text;
  const language = typeof token === "string" ? "" : token.lang ?? "";
  if (language.trim().toLowerCase() === "mermaid") {
    return `<div class="diagram-shell"><pre class="mermaid">${escapeHtml(text)}</pre></div>`;
  }
  return `<pre><code>${escapeHtml(text)}</code></pre>`;
};

const documentHtml = marked.parse(markdown, {
  renderer,
  gfm: true,
});

const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>MyEscrow unhappy workflow analysis</title>
    <style>
      @page { size: A3 landscape; margin: 14mm 16mm 12mm; }
      * { box-sizing: border-box; }
      html { background: #e7eef2; }
      body {
        margin: 0;
        color: #183f56;
        background: #ffffff;
        font-family: Inter, ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        font-size: 11.5pt;
        line-height: 1.55;
        -webkit-print-color-adjust: exact;
        print-color-adjust: exact;
      }
      .markdown-body { max-width: none; }
      h1, h2, h3 { color: #073b5c; line-height: 1.12; }
      h1 {
        margin: 23mm 0 5mm;
        max-width: 290mm;
        font-size: 34pt;
        letter-spacing: -0.025em;
      }
      h1::before {
        content: "MYESCROW PROCESS REVIEW";
        display: block;
        margin-bottom: 5mm;
        color: #6b7f90;
        font-size: 9pt;
        font-weight: 800;
        letter-spacing: 0.18em;
      }
      h1 + p {
        max-width: 290mm;
        margin: 0 0 15mm;
        color: #506879;
        font-size: 15pt;
      }
      h2 {
        margin: 0 0 7mm;
        padding-bottom: 3mm;
        border-bottom: 0.45mm solid #cbdbe3;
        font-size: 23pt;
        break-before: page;
        page-break-before: always;
      }
      h2:first-of-type {
        max-width: 290mm;
        margin-top: 0;
        font-size: 17pt;
        break-before: auto;
        page-break-before: auto;
      }
      h2:first-of-type + ul {
        max-width: 290mm;
        margin-top: 5mm;
        padding: 7mm 9mm 7mm 13mm;
        border: 0.4mm solid #ccdae2;
        border-radius: 4mm;
        background: #f4f9fb;
      }
      h3 {
        margin: 0 0 8mm;
        padding: 5mm 7mm;
        border-left: 2mm solid #1682a3;
        background: #edf7fa;
        font-size: 21pt;
        break-before: page;
        page-break-before: always;
      }
      p { margin: 0 0 5mm; }
      p:has(> strong:only-child) {
        margin: 8mm 0 3mm;
        color: #0c607d;
        font-size: 13.5pt;
        line-height: 1.2;
      }
      h3 + p:has(> strong:only-child) { margin-top: 0; }
      ul, ol { margin: 3mm 0 7mm; padding-left: 8mm; }
      li { padding-left: 1.5mm; }
      li + li { margin-top: 2.4mm; }
      strong { color: #0b5874; }
      .diagram-shell {
        width: 100%;
        height: 223mm;
        padding: 4mm;
        border: 0.4mm solid #d2e0e7;
        border-radius: 4mm;
        background: #ffffff;
        display: flex;
        align-items: center;
        justify-content: center;
        overflow: hidden;
        break-inside: avoid;
        page-break-inside: avoid;
      }
      .mermaid {
        width: 100%;
        height: 100%;
        margin: 0;
        display: flex;
        align-items: center;
        justify-content: center;
      }
      .mermaid svg { width: 100% !important; height: 100% !important; max-width: none !important; }
      .mermaid .nodeLabel, .mermaid .edgeLabel { font-weight: 560; }
      pre:not(.mermaid) {
        padding: 5mm;
        border-radius: 3mm;
        background: #102f43;
        color: #f4f8fa;
        white-space: pre-wrap;
      }
      h3 ~ p,
      h3 ~ ul,
      h3 ~ ol { max-width: 345mm; }
      h2:last-of-type + ol {
        max-width: 340mm;
        padding: 8mm 10mm 8mm 16mm;
        border: 0.4mm solid #bcd8c5;
        border-radius: 4mm;
        background: #f2fbf5;
        font-size: 13pt;
      }
    </style>
  </head>
  <body>
    <main class="markdown-body">${documentHtml}</main>
    <script src="${pathToFileURL(mermaidScriptPath).href}"></script>
    <script>
      (async () => {
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: "loose",
          theme: "base",
          fontFamily: 'Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
          flowchart: { htmlLabels: true, curve: "basis", useMaxWidth: false, nodeSpacing: 34, rankSpacing: 42 },
          themeVariables: {
            primaryColor: "#eef7fa",
            primaryBorderColor: "#0f6685",
            primaryTextColor: "#163a50",
            lineColor: "#607789",
            secondaryColor: "#f7fafb",
            tertiaryColor: "#ffffff",
            edgeLabelBackground: "#ffffff",
            fontSize: "15px"
          }
        });
        await mermaid.run({ querySelector: ".mermaid" });
        document.body.dataset.rendered = "true";
      })().catch((error) => {
        document.body.dataset.rendered = "error";
        document.body.insertAdjacentHTML("afterbegin", "<pre>" + String(error.stack || error) + "</pre>");
      });
    </script>
  </body>
</html>`;

await writeFile(htmlPath, html, "utf8");
console.log(`Prepared the complete Markdown document at ${htmlPath}`);
