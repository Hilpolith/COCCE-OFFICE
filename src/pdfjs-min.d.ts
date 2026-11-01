declare module 'pdfjs-dist/build/pdf.min.mjs' {
  import type * as PdfJs from 'pdfjs-dist';

  export const GlobalWorkerOptions: typeof PdfJs.GlobalWorkerOptions;
  export const getDocument: typeof PdfJs.getDocument;
}
