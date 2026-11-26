export interface DocsOutlineEntry { id: string; position: number; level: 1 | 2 | 3; text: string; }
type OutlineNode = { type?: { name?: string }; attrs?: { level?: unknown }; textContent?: string };
type OutlineDocument = { descendants: (callback: (node: OutlineNode, position: number) => boolean | void) => void };
const MAX_OUTLINE_ENTRIES = 200;
const MAX_HEADING_TEXT = 180;
export function extractDocsOutline(document: OutlineDocument): DocsOutlineEntry[] {
  const entries: DocsOutlineEntry[] = [];
  document.descendants((node, position) => {
    if (entries.length >= MAX_OUTLINE_ENTRIES) return false;
    if (node.type?.name !== 'heading') return;
    const rawLevel = node.attrs?.level;
    if (rawLevel !== 1 && rawLevel !== 2 && rawLevel !== 3) return;
    const text = (node.textContent ?? '').replace(/\s+/gu, ' ').trim().slice(0, MAX_HEADING_TEXT);
    if (!text) return;
    entries.push({ id: `${position}:${rawLevel}`, position, level: rawLevel, text });
  });
  return entries;
}