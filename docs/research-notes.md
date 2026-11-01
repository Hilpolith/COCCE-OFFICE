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
