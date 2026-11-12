import { MessageCircle, ShieldCheck } from 'lucide-react';
import OfficeTeamCollaboration from './OfficeTeamCollaboration';
import './chatsWorkspace.css';

export default function ChatsWorkspace() {
  return (
    <div className="page subpage office-chats-page">
      <header className="chats-vision-header">
        <div className="chats-vision-icon"><MessageCircle size={20} /></div>
        <div><span className="eyebrow">COCCE OFFICE · PRIVATE MESSAGING</span><h1>Chats</h1><p>People, groups, stories and shared moments in one calm space.</p></div>
        <span className="chats-secure-chip"><ShieldCheck size={14} /> Workspace access controlled</span>
      </header>
      <section className="chats-workbench glass-card">
        
        <OfficeTeamCollaboration showStories />
      </section>
    </div>
  );
}
