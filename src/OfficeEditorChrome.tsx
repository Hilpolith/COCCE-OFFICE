import { FileSearch, FileSpreadsheet, FileText, LockKeyhole, Presentation } from 'lucide-react';
import './officeWorkbench.css';

type EditorModule = 'docs' | 'sheets' | 'slides' | 'pdf' | 'vault';

const modules = [
  { id: 'docs', label: 'Docs', icon: FileText },
  { id: 'sheets', label: 'Sheets', icon: FileSpreadsheet },
  { id: 'slides', label: 'Slides', icon: Presentation },
  { id: 'pdf', label: 'PDF', icon: FileSearch },
  { id: 'vault', label: 'Vault', icon: LockKeyhole },
] as const;

export default function OfficeEditorChrome({
  active,
  storageLabel,
  onNavigate,
}: {
  active: EditorModule;
  storageLabel: string;
  onNavigate: (module: EditorModule) => void;
}) {
  return <section className="office-editor-chrome glass-card" aria-label="Office editor navigation">
    <nav className="office-module-pills" aria-label="Office editors">
      {modules.map(({ id, label, icon: Icon }) => <button
        key={id}
        type="button"
        className="office-module-pill"
        aria-label={`Open ${label}`}
        aria-current={active === id ? 'page' : undefined}
        onClick={() => onNavigate(id)}
      ><Icon size={15} /><span>{label}</span></button>)}
    </nav>
    <div className="office-storage-pill" role="status" title="Office files are stored in this browser unless a separate cloud-copy action is enabled and explicitly used.">
      <LockKeyhole size={14} /><span>{storageLabel}</span>
    </div>
  </section>;
}
