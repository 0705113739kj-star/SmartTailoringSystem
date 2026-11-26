import { jsPDF } from 'jspdf';
import { isMobileNative } from './api';

export function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function sanitizePdfText(value: unknown): string {
  return String(value ?? '')
    .replace(/\u2212/g, '-')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/\u2013/g, '-')
    .replace(/\u2014/g, '--')
    .replace(/\u2192/g, '->')
    .replace(/\u00a0/g, ' ')
    .trim();
}

export const PRINT_STYLES = `
  @page {
    margin: 12mm;
  }
  .tp-doc {
    font-family: 'DM Sans', system-ui, -apple-system, sans-serif;
    color: #0f172a;
    background: #ffffff;
    max-width: 900px;
    margin: 0 auto;
  }
  .tp-doc.tp-receipt {
    max-width: 380px;
    border: 1px dashed #94a3b8;
    padding: 20px;
  }
  .tp-header {
    border-bottom: 2px solid #0f172a;
    padding-bottom: 12px;
    margin-bottom: 16px;
  }
  .tp-receipt .tp-header {
    text-align: center;
    border-bottom: 1px dashed #94a3b8;
  }
  .tp-title {
    font-size: 18px;
    font-weight: 700;
    margin: 0 0 4px 0;
  }
  .tp-subtitle {
    font-size: 12px;
    color: #475569;
    margin: 0;
  }
  .tp-meta {
    font-size: 11px;
    color: #64748b;
    margin-top: 4px;
  }
  .tp-row {
    display: flex;
    justify-content: space-between;
    gap: 12px;
    padding: 4px 0;
    font-size: 12px;
  }
  .tp-row-label {
    color: #475569;
  }
  .tp-row-val {
    font-weight: 600;
    text-align: right;
  }
  .tp-mono {
    font-family: 'JetBrains Mono', ui-monospace, SFMono-Regular, monospace;
    font-variant-numeric: tabular-nums;
  }
  .tp-total {
    border-top: 1px dashed #94a3b8;
    margin-top: 10px;
    padding-top: 10px;
    display: flex;
    justify-content: space-between;
    font-size: 15px;
    font-weight: 700;
  }
  .tp-footer {
    margin-top: 14px;
    padding-top: 10px;
    border-top: 1px solid #e2e8f0;
    text-align: center;
    font-size: 11px;
    color: #64748b;
  }
  .tp-kpis {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 10px;
    margin-bottom: 16px;
  }
  .tp-kpi {
    border: 1px solid #cbd5e1;
    border-radius: 6px;
    padding: 10px;
  }
  .tp-kpi-label {
    font-size: 11px;
    color: #64748b;
  }
  .tp-kpi-val {
    font-size: 14px;
    font-weight: 700;
    margin-top: 4px;
  }
  .tp-table {
    width: 100%;
    border-collapse: collapse;
    font-size: 11px;
  }
  .tp-table th,
  .tp-table td {
    border-bottom: 1px solid #e2e8f0;
    padding: 7px 8px;
    text-align: left;
  }
  .tp-table th {
    background: #f8fafc;
    font-weight: 700;
    color: #334155;
    border-top: 1px solid #cbd5e1;
    border-bottom: 1px solid #cbd5e1;
  }
  .tp-num {
    text-align: right !important;
    font-family: 'JetBrains Mono', ui-monospace, SFMono-Regular, monospace;
    font-variant-numeric: tabular-nums;
  }
  .tp-section-title {
    font-size: 13px;
    font-weight: 700;
    margin: 16px 0 8px 0;
    border-bottom: 1px solid #cbd5e1;
    padding-bottom: 4px;
  }
  .tp-grid-2 {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 16px;
  }
`;

export interface PrintableOptions {
  title: string;
  htmlBody: string;
  filename?: string;
}

export interface PdfKeyValueRow {
  label: string;
  value: string;
}

export interface PdfKpiItem {
  label: string;
  value: string;
}

export interface PdfTableSpec {
  title?: string;
  headers: string[];
  rows: Array<Array<string | number>>;
  numericColumns?: number[];
}

export interface PdfDocumentSpec {
  title: string;
  subtitle?: string;
  meta?: string;
  compactReceipt?: boolean;
  kpis?: PdfKpiItem[];
  sections?: Array<{
    title: string;
    rows: PdfKeyValueRow[];
  }>;
  paragraphs?: Array<{
    label: string;
    text: string;
  }>;
  tables?: PdfTableSpec[];
  totalRow?: { label: string; value: string };
  footer?: string;
}

export function isEmbeddedIframe(): boolean {
  try {
    if (typeof window !== 'undefined' && window.smartTailoringDesktop?.isElectron) {
      return false;
    }
    return typeof window !== 'undefined' && window.self !== window.top;
  } catch {
    return true;
  }
}

export function printHtmlDocument({ title, htmlBody }: PrintableOptions): {
  triggered: boolean;
  inIframe: boolean;
} {
  if (typeof document === 'undefined' || typeof window === 'undefined') {
    return { triggered: false, inIframe: false };
  }

  const prevTitle = document.title;
  const existing = document.getElementById('tailorpos-print-root');
  if (existing) existing.remove();

  const root = document.createElement('div');
  root.id = 'tailorpos-print-root';
  root.innerHTML = `<style>${PRINT_STYLES}</style>${htmlBody}`;
  document.body.appendChild(root);
  document.body.classList.add('tailorpos-printing');
  document.title = title;

  let cleaned = false;
  let fallbackTimer: ReturnType<typeof setTimeout> | null = null;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    if (fallbackTimer) clearTimeout(fallbackTimer);
    document.body.classList.remove('tailorpos-printing');
    document.title = prevTitle;
    root.remove();
    window.removeEventListener('afterprint', cleanup);
  };

  window.addEventListener('afterprint', cleanup);
  fallbackTimer = setTimeout(cleanup, 30000);

  let triggered = false;
  if (window.smartTailoringDesktop?.isElectron) {
    triggered = true;
    void window.smartTailoringDesktop
      .nativePrint()
      .catch(() => {
        try {
          window.print();
        } catch {
          // ignore
        }
      })
      .finally(() => {
        setTimeout(cleanup, 300);
      });
    return { triggered, inIframe: false };
  }

  try {
    window.focus();
    window.print();
    triggered = true;
  } catch {
    triggered = false;
  }

  return { triggered, inIframe: isEmbeddedIframe() };
}

export function buildStandaloneHtmlBlob({ title, htmlBody }: PrintableOptions): Blob {
  const fullHtml = `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${escapeHtml(title)}</title>
  <style>
    body { margin: 0; padding: 24px; background: #f8fafc; font-family: system-ui, -apple-system, sans-serif; }
    .tp-toolbar { max-width: 900px; margin: 0 auto 16px auto; display: flex; justify-content: space-between; align-items: center; background: #0f172a; color: #fff; padding: 10px 16px; border-radius: 8px; font-size: 13px; }
    .tp-toolbar button { background: #0f766e; color: #fff; border: none; border-radius: 6px; padding: 7px 14px; font-weight: 600; cursor: pointer; }
    @media print {
      body { padding: 0; background: #fff; }
      .tp-toolbar { display: none !important; }
    }
    ${PRINT_STYLES}
  </style>
</head>
<body>
  <div class="tp-toolbar">
    <span>${escapeHtml(title)}</span>
    <button onclick="window.print()">Print / Save as PDF</button>
  </div>
  ${htmlBody}
</body>
</html>`;

  return new Blob([fullHtml], { type: 'text/html;charset=utf-8' });
}

export function buildPdfBlob(spec: PdfDocumentSpec): Blob {
  const isReceipt = Boolean(spec.compactReceipt);
  const doc = new jsPDF({
    orientation: 'portrait',
    unit: 'mm',
    format: isReceipt ? 'a5' : 'a4',
  });

  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();
  const margin = isReceipt ? 12 : 14;
  const contentWidth = pageWidth - margin * 2;
  let y = margin + 2;

  const ensureSpace = (neededMm: number) => {
    if (y + neededMm > pageHeight - margin) {
      doc.addPage();
      y = margin + 2;
    }
  };

  // Document Header
  doc.setTextColor(15, 23, 42);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(isReceipt ? 14 : 16);
  const titleLines = doc.splitTextToSize(sanitizePdfText(spec.title), contentWidth);
  doc.text(titleLines, isReceipt ? pageWidth / 2 : margin, y, {
    align: isReceipt ? 'center' : 'left',
  });
  y += titleLines.length * (isReceipt ? 5.5 : 6.5);

  if (spec.subtitle) {
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(isReceipt ? 9.5 : 10);
    doc.setTextColor(71, 85, 105);
    const subLines = doc.splitTextToSize(sanitizePdfText(spec.subtitle), contentWidth);
    doc.text(subLines, isReceipt ? pageWidth / 2 : margin, y, {
      align: isReceipt ? 'center' : 'left',
    });
    y += subLines.length * 4.5;
  }

  if (spec.meta) {
    doc.setFont('helvetica', isReceipt ? 'bold' : 'normal');
    doc.setFontSize(8.5);
    doc.setTextColor(100, 116, 139);
    const metaLines = doc.splitTextToSize(sanitizePdfText(spec.meta), contentWidth);
    doc.text(metaLines, isReceipt ? pageWidth / 2 : margin, y, {
      align: isReceipt ? 'center' : 'left',
    });
    y += metaLines.length * 4;
  }

  y += 2;
  doc.setDrawColor(15, 23, 42);
  doc.setLineWidth(isReceipt ? 0.3 : 0.5);
  doc.line(margin, y, pageWidth - margin, y);
  y += 6;

  // KPI Grid
  if (spec.kpis && spec.kpis.length > 0) {
    const cols = Math.min(3, spec.kpis.length);
    const gap = 4;
    const boxW = (contentWidth - gap * (cols - 1)) / cols;
    const boxH = 16;

    for (let i = 0; i < spec.kpis.length; i += cols) {
      ensureSpace(boxH + 4);
      const rowItems = spec.kpis.slice(i, i + cols);
      rowItems.forEach((kpi, idx) => {
        const x = margin + idx * (boxW + gap);
        doc.setDrawColor(203, 213, 225);
        doc.setFillColor(248, 250, 252);
        doc.roundedRect(x, y, boxW, boxH, 1.5, 1.5, 'FD');

        doc.setFont('helvetica', 'normal');
        doc.setFontSize(7.5);
        doc.setTextColor(100, 116, 139);
        const label = doc.splitTextToSize(sanitizePdfText(kpi.label), boxW - 5)[0] || '';
        doc.text(label, x + 2.5, y + 5.5);

        doc.setFont('helvetica', 'bold');
        doc.setFontSize(10.5);
        doc.setTextColor(15, 23, 42);
        const val = doc.splitTextToSize(sanitizePdfText(kpi.value), boxW - 5)[0] || '';
        doc.text(val, x + 2.5, y + 12.2);
      });
      y += boxH + 4;
    }
    y += 2;
  }

  // Key-Value Sections
  if (spec.sections && spec.sections.length > 0) {
    for (const sec of spec.sections) {
      ensureSpace(14);
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(10.5);
      doc.setTextColor(15, 23, 42);
      doc.text(sanitizePdfText(sec.title), margin, y);
      y += 2;
      doc.setDrawColor(203, 213, 225);
      doc.setLineWidth(0.25);
      doc.line(margin, y, pageWidth - margin, y);
      y += 4.5;

      if (sec.rows.length === 0) {
        doc.setFont('helvetica', 'italic');
        doc.setFontSize(8.5);
        doc.setTextColor(100, 116, 139);
        doc.text('No records.', margin, y);
        y += 6;
      } else {
        for (const r of sec.rows) {
          const valWidth = contentWidth * 0.56;
          const labelWidth = contentWidth * 0.42;
          const labelLines = doc.splitTextToSize(sanitizePdfText(r.label), labelWidth);
          const valLines = doc.splitTextToSize(sanitizePdfText(r.value), valWidth);
          const rowH = Math.max(labelLines.length, valLines.length) * 4.2 + 1.8;
          ensureSpace(rowH);

          doc.setFont('helvetica', 'normal');
          doc.setFontSize(9);
          doc.setTextColor(71, 85, 105);
          doc.text(labelLines, margin, y);

          doc.setFont('helvetica', 'bold');
          doc.setTextColor(15, 23, 42);
          doc.text(valLines, pageWidth - margin, y, { align: 'right' });

          y += rowH;
        }
      }
      y += 3;
    }
  }

  // Paragraphs (Design specs, notes, notices)
  if (spec.paragraphs && spec.paragraphs.length > 0) {
    for (const p of spec.paragraphs) {
      if (!p.text.trim()) continue;
      const lines = doc.splitTextToSize(sanitizePdfText(`${p.label}: ${p.text}`), contentWidth);
      ensureSpace(lines.length * 4.2 + 4);
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(8.8);
      doc.setTextColor(51, 65, 85);
      doc.text(lines, margin, y);
      y += lines.length * 4.2 + 3;
    }
  }

  // Tables
  if (spec.tables && spec.tables.length > 0) {
    for (const tbl of spec.tables) {
      if (tbl.title) {
        ensureSpace(12);
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(10.5);
        doc.setTextColor(15, 23, 42);
        doc.text(sanitizePdfText(tbl.title), margin, y);
        y += 5;
      }

      if (tbl.headers.length === 0) continue;
      const colCount = tbl.headers.length;
      const colWidth = contentWidth / colCount;
      const numericSet = new Set(tbl.numericColumns || []);

      const drawTableHeader = () => {
        ensureSpace(9);
        doc.setFillColor(248, 250, 252);
        doc.setDrawColor(203, 213, 225);
        doc.rect(margin, y - 4, contentWidth, 7, 'FD');
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(7.8);
        doc.setTextColor(51, 65, 85);
        tbl.headers.forEach((h, idx) => {
          const isNum = numericSet.has(idx);
          const x = isNum ? margin + (idx + 1) * colWidth - 1.5 : margin + idx * colWidth + 1.5;
          const text = doc.splitTextToSize(sanitizePdfText(h), colWidth - 3)[0] || '';
          doc.text(text, x, y, { align: isNum ? 'right' : 'left' });
        });
        y += 5.5;
      };

      drawTableHeader();

      if (tbl.rows.length === 0) {
        ensureSpace(7);
        doc.setFont('helvetica', 'italic');
        doc.setFontSize(8);
        doc.setTextColor(100, 116, 139);
        doc.text('No records in selected range.', margin + 1.5, y);
        y += 6;
      } else {
        for (const row of tbl.rows) {
          const cellLines = row.map((cell) =>
            doc.splitTextToSize(sanitizePdfText(cell), colWidth - 3)
          );
          const maxLines = Math.max(1, ...cellLines.map((l) => l.length));
          const rowH = maxLines * 3.8 + 2.5;

          if (y + rowH > pageHeight - margin) {
            doc.addPage();
            y = margin + 4;
            drawTableHeader();
          }

          doc.setFont('helvetica', 'normal');
          doc.setFontSize(7.8);
          doc.setTextColor(15, 23, 42);
          cellLines.forEach((lines, idx) => {
            const isNum = numericSet.has(idx);
            const x = isNum ? margin + (idx + 1) * colWidth - 1.5 : margin + idx * colWidth + 1.5;
            doc.text(lines, x, y, { align: isNum ? 'right' : 'left' });
          });

          y += rowH - 1;
          doc.setDrawColor(226, 232, 240);
          doc.setLineWidth(0.15);
          doc.line(margin, y, pageWidth - margin, y);
          y += 3;
        }
      }
      y += 4;
    }
  }

  // Highlighted Total Row
  if (spec.totalRow) {
    ensureSpace(14);
    doc.setDrawColor(148, 163, 184);
    doc.setLineWidth(0.35);
    doc.line(margin, y, pageWidth - margin, y);
    y += 6;
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(isReceipt ? 11.5 : 12);
    doc.setTextColor(15, 23, 42);
    doc.text(sanitizePdfText(spec.totalRow.label), margin, y);
    doc.setTextColor(15, 118, 110);
    doc.text(sanitizePdfText(spec.totalRow.value), pageWidth - margin, y, { align: 'right' });
    y += 7;
  }

  // Footer
  if (spec.footer) {
    ensureSpace(12);
    y += 3;
    doc.setDrawColor(226, 232, 240);
    doc.setLineWidth(0.2);
    doc.line(margin, y, pageWidth - margin, y);
    y += 5;
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8);
    doc.setTextColor(100, 116, 139);
    const footLines = doc.splitTextToSize(sanitizePdfText(spec.footer), contentWidth);
    doc.text(footLines, pageWidth / 2, y, { align: 'center' });
  }

  return doc.output('blob');
}

export interface SaveFileResult {
  method: 'picker' | 'download';
  reason?: 'iframe_blocked' | 'unsupported' | 'error';
  cancelled?: boolean;
}

export async function saveFileToDesktop(
  blob: Blob,
  filename: string,
  mimeType: 'application/pdf' | 'text/html' = 'application/pdf'
): Promise<SaveFileResult> {
  if (typeof window !== 'undefined' && window.smartTailoringDesktop?.isElectron) {
    const buffer = new Uint8Array(await blob.arrayBuffer());
    const filters =
      mimeType === 'application/pdf'
        ? [{ name: 'PDF Document', extensions: ['pdf'] }]
        : [{ name: 'Printable HTML Document', extensions: ['html'] }];
    const res = await window.smartTailoringDesktop.saveFile({
      defaultPath: filename,
      data: buffer,
      filters,
    });
    if (res.cancelled) {
      return { method: 'picker', cancelled: true };
    }
    return { method: 'picker' };
  }

  if (isMobileNative()) {
    try {
      const [{ Directory, Filesystem }, { Share }, { uint8ToBase64 }] = await Promise.all([
        import('@capacitor/filesystem'),
        import('@capacitor/share'),
        import('../mobile/sqlJsDb'),
      ]);
      const bytes = new Uint8Array(await blob.arrayBuffer());
      await Filesystem.writeFile({
        path: filename,
        data: uint8ToBase64(bytes),
        directory: Directory.Cache,
        recursive: true,
      });
      const uriRes = await Filesystem.getUri({
        path: filename,
        directory: Directory.Cache,
      });
      await Share.share({
        title: filename,
        url: uriRes.uri,
        dialogTitle: 'Save, View, or Print Document',
      });
      return { method: 'picker' };
    } catch {
      // Fall through to standard browser download
    }
  }

  const win = window as Window & {
    showSaveFilePicker?: (options?: {
      suggestedName?: string;
      startIn?: string;
      types?: Array<{ description: string; accept: Record<string, string[]> }>;
    }) => Promise<{
      createWritable: () => Promise<{
        write: (data: Blob) => Promise<void>;
        close: () => Promise<void>;
      }>;
    }>;
  };

  let fallbackReason: SaveFileResult['reason'] = 'unsupported';

  if (typeof win.showSaveFilePicker === 'function') {
    const types =
      mimeType === 'application/pdf'
        ? [{ description: 'PDF Document', accept: { 'application/pdf': ['.pdf'] } }]
        : [{ description: 'Printable HTML Document', accept: { 'text/html': ['.html'] } }];

    const attempts: Array<{
      suggestedName: string;
      startIn?: string;
      types?: Array<{ description: string; accept: Record<string, string[]> }>;
    }> = [
      { suggestedName: filename, startIn: 'desktop', types },
      { suggestedName: filename, types },
      { suggestedName: filename },
    ];

    for (const opts of attempts) {
      try {
        const handle = await win.showSaveFilePicker(opts);
        const writable = await handle.createWritable();
        await writable.write(blob);
        await writable.close();
        return { method: 'picker' };
      } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') {
          return { method: 'picker', cancelled: true };
        }
        if (err instanceof DOMException && err.name === 'SecurityError') {
          fallbackReason = isEmbeddedIframe() ? 'iframe_blocked' : 'error';
          break;
        }
        fallbackReason = isEmbeddedIframe() ? 'iframe_blocked' : 'error';
      }
    }
  } else if (isEmbeddedIframe()) {
    fallbackReason = 'iframe_blocked';
  }

  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
  return { method: 'download', reason: fallbackReason };
}

export async function savePdfToDesktop(
  spec: PdfDocumentSpec,
  filename: string
): Promise<SaveFileResult> {
  const safeName = filename.endsWith('.pdf') ? filename : `${filename}.pdf`;
  const blob = buildPdfBlob(spec);
  return saveFileToDesktop(blob, safeName, 'application/pdf');
}

export async function downloadPrintableHtml({
  title,
  filename = 'document.html',
  htmlBody,
}: PrintableOptions): Promise<SaveFileResult> {
  const safeName = filename.endsWith('.html') ? filename : `${filename}.html`;
  const blob = buildStandaloneHtmlBlob({ title, htmlBody });
  return saveFileToDesktop(blob, safeName, 'text/html');
}

export function extractReportSpecFromDom(
  container: HTMLElement | null,
  header: { title: string; subtitle?: string; meta?: string; footer?: string }
): PdfDocumentSpec {
  const kpis: PdfKpiItem[] = [];
  const tables: PdfTableSpec[] = [];
  const paragraphs: Array<{ label: string; text: string }> = [];

  if (container) {
    // Extract KPI grids
    const grids = container.querySelectorAll('.grid');
    grids.forEach((grid) => {
      Array.from(grid.children).forEach((card) => {
        const textNodes = Array.from(card.querySelectorAll('p, span'))
          .map((el) => el.textContent?.trim() || '')
          .filter(Boolean);
        if (textNodes.length >= 2) {
          kpis.push({ label: textNodes[0], value: textNodes[1] });
        }
      });
    });

    // Extract notice banner if present
    const alerts = container.querySelectorAll('.bg-amber-50');
    alerts.forEach((al) => {
      const txt = al.textContent?.trim();
      if (txt) paragraphs.push({ label: 'Notice', text: txt });
    });

    // Extract tables
    const tableEls = container.querySelectorAll('table');
    tableEls.forEach((tbl) => {
      const ths = Array.from(tbl.querySelectorAll('thead th'));
      const headers = ths.map((th) => th.textContent?.trim() || '');
      const numericColumns = ths
        .map((th, idx) => (th.className.includes('text-right') ? idx : -1))
        .filter((idx) => idx >= 0);

      const rows = Array.from(tbl.querySelectorAll('tbody tr')).map((tr) =>
        Array.from(tr.querySelectorAll('td')).map((td) => td.textContent?.trim() || '')
      );

      tables.push({ headers, rows, numericColumns });
    });
  }

  return {
    title: header.title,
    subtitle: header.subtitle,
    meta: header.meta,
    kpis,
    paragraphs,
    tables,
    footer: header.footer,
  };
}
