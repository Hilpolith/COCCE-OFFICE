import { MessageCircle, ShieldCheck } from 'lucide-react';
import OfficeTeamCollaboration from './OfficeTeamCollaboration';

export default function ChatsWorkspace() {
  return (
    <div className="page subpage office-chats-page">
      <div className="page-title-row">
        <div>
          <span className="eyebrow">COCCE OFFICE · TEAM COMMUNICATION</span>
          <h1>Chats</h1>
          <p className="page-lede">Direct conversations, group discussions and workspace channels. Conversations use existing COCCE accounts and workspace membership permissions.</p>
        </div>
        <span className="local-only-chip"><ShieldCheck size={13} /> Permission-gated</span>
      </div>
      <section className="glass-card" style={{ padding: 'clamp(14px, 2vw, 24px)' }}>
        <div className="settings-heading" style={{ marginBottom: 16 }}>
          <div className="settings-icon"><MessageCircle size={19} /></div>
          <div><h2>Workspace conversations</h2><p>Choose a workspace, start a direct or group conversation, or open a channel.</p></div>
        </div>
        <OfficeTeamCollaboration />
      </section>
    </div>
  );
}
