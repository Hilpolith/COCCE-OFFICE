import { ChevronRight, Sparkles } from 'lucide-react';

export default function OfficeSuiteAiAction({ workspaceId, suiteLabel, tabLabel }: {
  workspaceId: string;
  suiteLabel: string;
  tabLabel: string;
}) {
  const openAssistant = () => {
    const prompt = `I am working in the ${suiteLabel} Office suite, on the ${tabLabel} tab, inside the active Office workspace. Help me complete the next task for this tab. Use only information I am authorised to access in this workspace, including relevant connected Drive files and Team conversations. First give me a concise plan, then prepare a reviewable draft or recommendation. Do not claim to create, update, approve, send, or delete records. Ask for explicit confirmation before any write or external action. If the suite records needed for the task are not available in your authorised context, tell me exactly what to select or provide.`;
    window.dispatchEvent(new CustomEvent('cocce-office:navigate', {
      detail: { page: 'ai', workspaceId, prompt },
    }));
  };

  return <button type="button" className="office-suite-ai-action" onClick={openAssistant} aria-label={`Ask COCCE AI about ${suiteLabel}, ${tabLabel}`}>
    <span className="office-suite-ai-action-icon"><Sparkles size={15} /></span>
    <span className="office-suite-ai-action-copy"><strong>Ask COCCE AI</strong><small>{tabLabel}</small></span>
    <ChevronRight size={15} className="office-suite-ai-action-chevron" />
  </button>;
}
