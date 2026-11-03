# Read-only research notes

## GenOffice source review

The reference repository was inspected read-only at commit `36a509e8fc16ace85ed7afa3c37acb7b9c441adad` (2026-10-30). It is a TypeScript/JavaScript workspace with React 19 and Vite/Electron-Vite, and Electron 43 is the desktop runtime. The Docs editor uses Tiptap/ProseMirror and OOXML patching; Sheets uses Univer and a Rust XLSX sidecar; Slides uses React/Konva and PPTX packages; PDF uses PDF.js with PDFium/pdf-lib paths. These tools have desktop IPC, local filesystem, native sidecar, or native PDF assumptions, so the source does not constitute a ready-to-host web Office editor.

The root and open-source apps declare Apache-2.0. The `ee/` directory has a separate GenOffice Enterprise License; it was not copied. A production reuse review must also preserve `NOTICE`, generate third-party notices, and review fonts, Unicode data, and dependency licenses.

## Source links

- [GenOffice README](https://github.com/genspark-ai/genoffice/blob/main/README.md)
- [Repository layout and contribution guide](https://github.com/genspark-ai/genoffice/blob/main/CONTRIBUTING.md)
- [Apache-2.0 license](https://github.com/genspark-ai/genoffice/blob/main/LICENSE)
- [NOTICE](https://github.com/genspark-ai/genoffice/blob/main/NOTICE)
- [Enterprise code license](https://github.com/genspark-ai/genoffice/blob/main/ee/LICENSE)
- [Enterprise code guide](https://github.com/genspark-ai/genoffice/blob/main/ee/README.md)
- [Security notes](https://github.com/genspark-ai/genoffice/blob/main/SECURITY.md)
- [Privacy notes](https://github.com/genspark-ai/genoffice/blob/main/PRIVACY.md)
- [Docs package manifest](https://github.com/genspark-ai/genoffice/blob/main/apps/docs/package.json)
- [Sheets package manifest](https://github.com/genspark-ai/genoffice/blob/main/apps/sheets/package.json)
- [Slides package manifest](https://github.com/genspark-ai/genoffice/blob/main/apps/slides/package.json)
- [PDF package manifest](https://github.com/genspark-ai/genoffice/blob/main/apps/pdf/package.json)

This review is informational and is not legal advice or a substitute for package-level license review before redistribution.


## 2026-11-03 — bounded local DOCX interchange

The next native-format increment is deliberately limited to browser-local DOCX import/export for the existing Docs rich-text subset. It does not claim full OOXML round-trip fidelity. Import will create a new local document, stream and bound ZIP decompression, parse only the main Word XML plus simple styles/numbering, never resolve relationships or fetch external targets, and pass generated HTML through COCCE Office's existing allow-list sanitizer. The original file is not retained or uploaded. Files, expanded package bytes, package-entry count, XML parts, text length, and paragraph count have explicit limits; macros and embedded objects are rejected. Tables are flattened to text; image, page-layout, review, comment, and advanced formatting support is out of scope.

The browser DOCX writer uses the `docx` package's documented `Packer.toBlob` API and only emits headings 1–3, paragraphs, bold/italic/underline/strikethrough, simple lists, and indented quotes supported by the COCCE editor. Before packing, it rejects drafts over 200,000 text characters, 10,000 paragraphs, or 2 MiB of sanitized markup; generated files are capped at 5 MiB.

## Source links

- [docx.js project and API](https://docx.js.org/)
- [docx.js Packer.toBlob API](https://docx.js.org/api/classes/index.Packer.html)
- [docx.js TextRun API](https://docx.js.org/api/classes/index.TextRun.html)
- [docx.js Paragraph API](https://docx.js.org/api/classes/index.Paragraph.html)
- [fflate ZIP streaming API](https://github.com/101arrowz/fflate/blob/master/docs/interfaces/UnzipFile.md)
- [fflate project documentation](https://github.com/101arrowz/fflate)
- [Mammoth.js upstream documentation](https://github.com/mwilliamson/mammoth.js/) was reviewed as an import candidate; this tranche does not depend on Mammoth and instead keeps XML parsing and markup allow-listing explicit.
- [nanoid repository](https://github.com/ai/nanoid)

The implementation uses `docx@9.15.1`, `fflate@0.8.3`, and `nanoid@6.0.2` (a docx runtime dependency); all are MIT-licensed and their complete notices are included in the shipped third-party notice file. No GenOffice source or `ee/` material is used.
The browser DOCX writer uses the `docx` package's documented `Packer.toBlob` API and only emits headings 1–3, paragraphs, bold/italic/underline/strikethrough, simple lists, and indented quotes supported by the COCCE editor. Before packing, it rejects drafts over 200,000 text characters, 10,000 paragraphs, or 2 MiB of sanitized markup; generated files are capped at 5 MiB.
