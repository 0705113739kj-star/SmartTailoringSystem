import React from 'react';
import { Download, ExternalLink, FileDown, Printer, X } from 'lucide-react';
import {
  downloadPrintableHtml,
  isEmbeddedIframe,
  PRINT_STYLES,
  printHtmlDocument,
  savePdfToDesktop,
  type PdfDocumentSpec,
} from '../lib/print';

export interface PrintableDocumentPayload {
  title: string;
  filenameBase: string;
  htmlBody: string;
  pdfSpec: PdfDocumentSpec;
}

interface PrintDocumentModalProps {
  doc: PrintableDocumentPayload;
  onClose: () => void;
  onNotify: (msg: string, type?: 'success' | 'error') => void;
}

export const PrintDocumentModal: React.FC<PrintDocumentModalProps> = ({ doc, onClose, onNotify }) => {
  const inIframe = isEmbeddedIframe();

  const handlePrint = () => {
    const res = printHtmlDocument({
      title: doc.title,
      htmlBody: doc.htmlBody,
    });
    if (res.inIframe) {
      onNotify(
        'Print dialog requested. If blocked by the preview frame, open in a full tab or click Save PDF to Desktop.',
        'success'
      );
    }
  };

  const handleSavePdf = async () => {
    try {
      const res = await savePdfToDesktop(doc.pdfSpec, `${doc.filenameBase}.pdf`);
      if (res.cancelled) return;
      onNotify(
        res.method === 'picker'
          ? `Saved ${doc.filenameBase}.pdf to your selected location.`
          : res.reason === 'iframe_blocked'
          ? `Downloaded ${doc.filenameBase}.pdf (browser blocked Desktop File Explorer inside preview iframe — click "Open Full Tab" to choose a folder).`
          : `Downloaded ${doc.filenameBase}.pdf to your computer.`,
        'success'
      );
    } catch (err) {
      onNotify(err instanceof Error ? err.message : 'Failed to generate PDF.', 'error');
    }
  };

  const handleSaveHtml = async () => {
    try {
      const res = await downloadPrintableHtml({
        title: doc.title,
        filename: `${doc.filenameBase}.html`,
        htmlBody: doc.htmlBody,
      });
      if (res.cancelled) return;
      onNotify(
        res.method === 'picker'
          ? `Saved ${doc.filenameBase}.html to your selected location.`
          : `Downloaded ${doc.filenameBase}.html. Open it in your browser to print.`,
        'success'
      );
    } catch (err) {
      onNotify(err instanceof Error ? err.message : 'Failed to save HTML document.', 'error');
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 p-4 overflow-y-auto no-print">
      <div className="w-full max-w-4xl rounded-xl border border-slate-200 bg-white shadow-2xl flex flex-col max-h-[90vh]">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 px-5 py-3.5 bg-slate-50 rounded-t-xl">
          <div>
            <h3 className="font-display text-sm font-bold text-slate-900">{doc.title}</h3>
            {inIframe && (
              <p className="text-[11px] text-slate-600 flex flex-wrap items-center gap-2 mt-0.5">
                <span>
                  Preview iframe restricts Desktop File Explorer &amp; printing. To pick any Desktop folder directly:
                </span>
                <a
                  href={typeof window !== 'undefined' ? window.location.href : '#'}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 font-semibold text-teal-700 hover:text-teal-800 underline"
                >
                  Open Full Tab
                  <ExternalLink className="h-3 w-3" />
                </a>
              </p>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg p-1 text-slate-400 hover:bg-slate-200 hover:text-slate-700"
            aria-label="Close print preview"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-6 bg-slate-100">
          <div className="bg-white border border-slate-200 rounded-lg p-6 shadow-sm mx-auto max-w-[900px]">
            <style>{PRINT_STYLES}</style>
            <div dangerouslySetInnerHTML={{ __html: doc.htmlBody }} />
          </div>
        </div>

        <div className="flex flex-wrap items-center justify-end gap-2 border-t border-slate-200 px-5 py-3.5 bg-white rounded-b-xl">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-slate-300 px-3.5 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50"
          >
            Close
          </button>
          <button
            type="button"
            onClick={() => void handleSaveHtml()}
            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3.5 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50"
          >
            <Download className="h-3.5 w-3.5" />
            Save Printable HTML
          </button>
          <button
            type="button"
            onClick={() => void handleSavePdf()}
            className="inline-flex items-center gap-1.5 rounded-lg bg-teal-700 px-4 py-2 text-xs font-semibold text-white hover:bg-teal-800"
          >
            <FileDown className="h-3.5 w-3.5" />
            Save PDF to Desktop
          </button>
          <button
            type="button"
            onClick={handlePrint}
            className="inline-flex items-center gap-1.5 rounded-lg bg-slate-900 px-4 py-2 text-xs font-semibold text-white hover:bg-slate-800"
          >
            <Printer className="h-3.5 w-3.5" />
            Print Document
          </button>
        </div>
      </div>
    </div>
  );
};
