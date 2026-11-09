import { MessageCircle, ShieldCheck, Sparkles, Users, Video } from 'lucide-react';
import OfficeTeamCollaboration from './OfficeTeamCollaboration';
import './chatsWorkspace.css';

export default function ChatsWorkspace() {
  return (
    <div className="page subpage office-chats-page">
      <header className="chats-hero">
        <div className="chats-hero-glow" />
        <div className="chats-hero-mark"><MessageCircle size={27} /></div>
        <div className="chats-hero-copy">
          <span className="eyebrow">COCCE OFFICE · CONNECTED WORK</span>
          <h1>Chats</h1>
          <p>Conversations that keep your people, projects and decisions in sync.</p>
        </div>
        <div className="chats-hero-actions">
          <span><span className="chats-live-dot" /> PRIVATE WORKSPACES</span>
          <span><ShieldCheck size={13} /> MEMBERSHIP CONTROLLED</span>
        </div>
      </header>
      <div className="chats-feature-strip">
        <div><span className="chats-feature-icon"><Users size={16} /></span><span><strong>People & teams</strong><small>COCCE members and groups</small></span></div>
        <div><span className="chats-feature-icon"><MessageCircle size={16} /></span><span><strong>Workspace channels</strong><small>Project conversations</small></span></div>
        <div><span className="chats-feature-icon"><Video size={16} /></span><span><strong>Rich messaging</strong><small>Media features in progress</small></span></div>
        <div><span className="chats-feature-icon"><Sparkles size={16} /></span><span><strong>COCCE AI</strong><small>Conversation assistant</small></span></div>
      </div>
      <section className="chats-workbench glass-card">
        <div className="chats-workbench-heading">
          <div><span className="eyebrow">YOUR COMMUNICATION HUB</span><h2>Workspace conversations</h2><p>Choose a space, start a direct or group conversation, and keep discussions together.</p></div>
          <span className="chats-secure-chip"><ShieldCheck size={14} /> Access checked by COCCE</span>
        </div>
        <OfficeTeamCollaboration />
      </section>
    </div>
  );
}
