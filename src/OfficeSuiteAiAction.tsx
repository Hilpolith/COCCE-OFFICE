import { useState } from 'react';
import { ChevronDown, ClipboardList, FileText, ListChecks, MessageCircle, Sparkles } from 'lucide-react';
import './officeSuiteAiAction.css';

type AiAction = 'summary' | 'draft' | 'plan' | 'ask';

export default function OfficeSuiteAiAction({ workspaceId, suiteLabel, tabLabel }: {
  workspaceId: string;
  suiteLabel: string;
  tabLabel: string;
}) {
  const [open, setOpen] = useState(false);

  const openAssistant = (action: AiAction) => {
    const base = `I am working in the ${suiteLabel} Office suite, on the ${tabLabel} tab, inside workspace ${workspaceId}. Use only information I am authorised to access in this workspace, including relevant connected Drive files and Team conversations. Do not assume you can read sector records unless they are present in your authorised context. If the records needed for this task are unavailable, tell me exactly what to select or provide. Do not create, update, approve, send, or delete records, and do not take external action; prepare reviewable work and ask for explicit confirmation before any write.`;
    const tasks: Record<AiAction, string> = {
      summary: 'Summarise the authorised information relevant to this tab. Highlight key facts, missing information, risks, and practical next steps. Do not invent records or figures.',
      draft: 'Prepare a polished professional document or message relevant to this tab. Use clear headings, appropriate business language, and placeholders wherever facts are missing.',
      plan: 'Create an actionable step-by-step plan for this tab. Identify tasks, suggested owners, priorities, dependencies, and due-date suggestions only where the available context supports them.',
      ask: 'Help me complete the next task on this tab. Start with the most useful response and ask only one clarifying question if essential.',
    };
    setOpen(false);
    window.dispatchEvent(new CustomEvent('cocce-office:navigate', {
      detail: { page: 'ai', workspaceId, prompt: `${base}\n\nTask: ${tasks[action]}` },
    }));
  };

  return <div className="office-suite-ai-menu-wrap" onBlur={(event) => {
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOpen(false);
  }} onKeyDown={(event) => {
    if (event.key === 'Escape') setOpen(false);
  }}>
    <button type="button" className="office-suite-ai-action" onClick={() => setOpen((value) => !value)} aria-label={`Ask COCCE AI about ${suiteLabel}, ${tabLabel}`} aria-haspopup="menu" aria-expanded={open}>
      <span className="office-suite-ai-action-icon"><Sparkles size={15} /></span>
      <span className="office-suite-ai-action-copy"><strong>Ask COCCE AI</strong><small>Current tab</small></span>
      <ChevronDown size={14} className="office-suite-ai-action-chevron" />
    </button>
    {open && <div className="office-suite-ai-menu" role="menu" aria-label={`COCCE AI actions for ${tabLabel}`}>
      <button type="button" role="menuitem" onClick={() => openAssistant('summary')}><ListChecks size={15}/><span><strong>Summarise this tab</strong><small>Key facts, gaps and next steps</small></span></button>
      <button type="button" role="menuitem" onClick={() => openAssistant('draft')}><FileText size={15}/><span><strong>Draft a document</strong><small>Create a reviewable first draft</small></span></button>
      <button type="button" role="menuitem" onClick={() => openAssistant('plan')}><ClipboardList size={15}/><span><strong>Create an action plan</strong><small>Tasks, owners and priorities</small></span></button>
      <button type="button" role="menuitem" onClick={() => openAssistant('ask')}><MessageCircle size={15}/><span><strong>Ask anything</strong><small>Open the workspace assistant</small></span></button>
    </div>}
  </div>;
}
