import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const [markdownPathArg, htmlPathArg, mermaidScriptArg] = process.argv.slice(2);

if (!markdownPathArg || !htmlPathArg || !mermaidScriptArg) {
  throw new Error(
    "Usage: node render-unhappy-workflows-pdf.mjs <markdown> <html-output> <mermaid-script>",
  );
}

const markdownPath = path.resolve(markdownPathArg);
const htmlPath = path.resolve(htmlPathArg);
const mermaidScriptPath = path.resolve(mermaidScriptArg);
const markdown = await readFile(markdownPath, "utf8");

const sections = [];
const sectionPattern = /^##\s+(.+?)\n\n```mermaid\n([\s\S]*?)\n```/gm;
let match;

while ((match = sectionPattern.exec(markdown)) !== null) {
  if (!match[1] || !match[2]) continue;
  sections.push({ title: match[1], diagram: match[2] });
}

if (sections.length === 0) {
  throw new Error(`No Mermaid diagrams found in ${markdownPath}`);
}

const escapeHtml = (value) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");

const pageDescriptions = [
  "Implemented lifecycle, including stalls and unsupported exits",
  "Invitation delivery, onboarding, negotiation, and signature integrity",
  "Money movement paths that can lose or over-release held funds",
  "Rejection, resubmission, evidence, and escalation gaps",
  "Versioned consent, reliable invitation delivery, and recoverable funding",
  "Evidence-based review, dispute resolution, settlement, and refunds",
];

const pages = sections
  .map(
    ({ title, diagram }, index) => `
      <section class="page">
        <header class="page-header">
          <div>
            <div class="eyebrow">MYESCROW PROCESS REVIEW</div>
            <h1>${escapeHtml(title)}</h1>
            <p>${escapeHtml(pageDescriptions[index] ?? "Escrow workflow")}</p>
          </div>
          <div class="legend" aria-label="Diagram legend">
            <span><i class="safe"></i>Supported / recoverable</span>
            <span><i class="warning"></i>Action or delay</span>
            <span><i class="danger"></i>Dead end / integrity risk</span>
          </div>
        </header>
        <main class="diagram-frame">
          <pre class="mermaid">${escapeHtml(diagram)}</pre>
        </main>
        <footer>
          <span>MyEscrow unhappy workflow analysis</span>
          <span>${index + 1} / ${sections.length}</span>
        </footer>
      </section>`,
  )
  .join("\n");

const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>MyEscrow unhappy workflow diagrams</title>
    <style>
      @page { size: A3 landscape; margin: 0; }
      * { box-sizing: border-box; }
      html, body { margin: 0; padding: 0; background: #e8eef3; color: #0b3553; }
      body { font-family: Inter, ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
      .page {
        width: 419mm;
        height: 296mm;
        padding: 12mm 14mm 9mm;
        background: #f8fbfc;
        display: grid;
        grid-template-rows: auto minmax(0, 1fr) auto;
        gap: 5mm;
        break-inside: avoid;
        page-break-inside: avoid;
        overflow: hidden;
      }
      .page-header { display: flex; justify-content: space-between; gap: 12mm; align-items: flex-end; }
      .eyebrow { color: #66788a; font-size: 8.5pt; font-weight: 750; letter-spacing: 0.16em; }
      h1 { margin: 2.2mm 0 1mm; font-size: 21pt; line-height: 1.08; color: #073b5c; }
      .page-header p { margin: 0; color: #526779; font-size: 10.5pt; }
      .legend {
        display: flex;
        flex-wrap: wrap;
        justify-content: flex-end;
        gap: 3.5mm 6mm;
        color: #526779;
        font-size: 8.5pt;
        padding-bottom: 0.8mm;
      }
      .legend span { display: inline-flex; align-items: center; gap: 1.5mm; white-space: nowrap; }
      .legend i { width: 4mm; height: 4mm; border-radius: 1mm; border: 0.4mm solid; }
      .legend .safe { background: #dcfce7; border-color: #15803d; }
      .legend .warning { background: #fef3c7; border-color: #d97706; }
      .legend .danger { background: #fee2e2; border-color: #dc2626; }
      .diagram-frame {
        min-height: 0;
        padding: 3mm;
        border: 0.35mm solid #d8e3e9;
        border-radius: 4mm;
        background: #ffffff;
        display: flex;
        align-items: center;
        justify-content: center;
        overflow: hidden;
      }
      .mermaid { width: 100%; height: 100%; margin: 0; display: flex; align-items: center; justify-content: center; }
      .mermaid svg { width: 100% !important; height: 100% !important; max-width: none !important; }
      .mermaid .nodeLabel, .mermaid .edgeLabel { font-weight: 560; }
      footer {
        display: flex;
        justify-content: space-between;
        color: #718293;
        font-size: 8pt;
        border-top: 0.3mm solid #d8e3e9;
        padding-top: 2.5mm;
      }
    </style>
  </head>
  <body>
    ${pages}
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
console.log(`Prepared ${sections.length} diagram pages at ${htmlPath}`);
