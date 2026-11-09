import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ChangeEvent, FormEvent } from 'react';
import type { SupabaseClient, User } from '@supabase/supabase-js';
import { CheckCheck, Download, Mic, Paperclip, Pencil, Radio, Reply, Send, Square, Trash2, X } from 'lucide-react';
import { createOfficeCloudApi } from './lib/officeCloudFiles';
import type { CloudFile } from './lib/officeCloudFiles';
import { officeTeamApi } from './lib/officeTeamApi';
import type { OfficeChatAttachment, OfficeConversationRead, OfficeRichMessage } from './lib/officeTeamApi';
import './officeChat.css';

type Props = {
  client: SupabaseClient;
  user: User;
  publicKey: string;
  workspaceId: string;
  conversationId: string;
  disabled?: boolean;
  canModerate?: boolean;
};

const MAX_CHAT_FILE_BYTES = 25 * 1024 * 1024;
const formatBytes = (value: number) => value < 1024 * 1024 ? Math.max(1, Math.round(value / 1024)) + ' KB' : (value / (1024 * 1024)).toFixed(1) + ' MB';

function attachmentMessageType(items: OfficeChatAttachment[]): 'text' | 'image' | 'video' | 'audio' | 'document' | 'mixed' {
  if (items.length > 1) return 'mixed';
  if (!items.length) return 'text';
  const type = items[0].mimeType.toLowerCase();
  if (type.startsWith('image/')) return 'image';
  if (type.startsWith('video/')) return 'video';
  if (type.startsWith('audio/')) return 'audio';
  return 'document';
}

export default function OfficeChatPanel({ client, user, publicKey, workspaceId, conversationId, disabled = false, canModerate = false }: Props) {
  const cloud = useMemo(() => createOfficeCloudApi(client, publicKey, user.id), [client, publicKey, user.id]);
  const [messages, setMessages] = useState<OfficeRichMessage[]>([]);
  const [reads, setReads] = useState<OfficeConversationRead[]>([]);
  const [body, setBody] = useState('');
  const [reply, setReply] = useState<OfficeRichMessage | null>(null);
  const [editing, setEditing] = useState<OfficeRichMessage | null>(null);
  const [editBody, setEditBody] = useState('');
  const [pending, setPending] = useState<OfficeChatAttachment[]>([]);
  const [uploading, setUploading] = useState(false);
  const [recording, setRecording] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [live, setLive] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const recorder = useRef<MediaRecorder | null>(null);
  const recordingStream = useRef<MediaStream | null>(null);
  const recordingParts = useRef<BlobPart[]>([]);
  const scopeRef = useRef(conversationId);

  useEffect(() => {
    scopeRef.current = conversationId;
    setBody('');
    setReply(null);
    setEditing(null);
    setPending([]);
    setError('');
  }, [conversationId]);

  const refresh = useCallback(async () => {
    const [nextMessages, nextReads] = await Promise.all([
      officeTeamApi.listRichMessages(client, conversationId),
      officeTeamApi.listConversationReads(client, conversationId),
    ]);
    if (scopeRef.current !== conversationId) return;
    const ordered = nextMessages.slice().reverse();
    setMessages(ordered);
    setReads(nextReads);
    const latestMessageId = ordered[ordered.length - 1]?.message_id ?? null;
    const ownRead = nextReads.find((reader) => reader.user_id === user.id)?.last_read_message_id ?? null;
    if (latestMessageId && latestMessageId !== ownRead && document.visibilityState === 'visible') {
      await officeTeamApi.markConversationRead(client, conversationId);
    }
  }, [client, conversationId, user.id]);

  useEffect(() => {
    let alive = true;
    let fallback: ReturnType<typeof window.setInterval> | null = null;
    const poll = () => {
      if (fallback) return;
      fallback = window.setInterval(() => { void refresh().catch((cause) => { if (alive) setError(cause instanceof Error ? cause.message : 'Could not refresh chat.'); }); }, 15000);
    };
    const stopPoll = () => {
      if (fallback) window.clearInterval(fallback);
      fallback = null;
    };
    setLoading(true);
    void refresh().catch((cause) => { if (alive) setError(cause instanceof Error ? cause.message : 'Could not load messages.'); })
      .finally(() => { if (alive) setLoading(false); });
    poll();
    const onVisibilityChange = () => { if (document.visibilityState === 'visible') void refresh().catch(() => undefined); };
    document.addEventListener('visibilitychange', onVisibilityChange);
    const channel = client.channel('office-chat-' + conversationId)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'office_messages', filter: 'conversation_id=eq.' + conversationId }, () => {
        void refresh().catch((cause) => { if (alive) setError(cause instanceof Error ? cause.message : 'Could not refresh messages.'); });
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'office_conversation_reads', filter: 'conversation_id=eq.' + conversationId }, () => {
        void refresh().catch(() => undefined);
      })
      .subscribe((status) => {
        if (!alive) return;
        if (status === 'SUBSCRIBED') { setLive(true); stopPoll(); }
        else { setLive(false); poll(); }
      });
    return () => {
      alive = false;
      stopPoll();
      document.removeEventListener('visibilitychange', onVisibilityChange);
      setLive(false);
      void client.removeChannel(channel);
    };
  }, [client, conversationId, refresh]);

  useEffect(() => () => {
    const activeRecorder = recorder.current;
    if (activeRecorder) {
      activeRecorder.ondataavailable = null;
      activeRecorder.onstop = null;
      try { activeRecorder.stop(); } catch { /* It may already be stopped. */ }
    }
    recordingStream.current?.getTracks().forEach((track) => track.stop());
  }, []);

  const uploadFiles = async (files: File[]) => {
    if (!files.length) return;
    if (pending.length + files.length > 10) { setError('A message can include up to 10 attachments.'); return; }
    const scope = conversationId;
    setUploading(true);
    setError('');
    try {
      for (const file of files) {
        if (!file.size || file.size > MAX_CHAT_FILE_BYTES) throw new Error(file.name + ' exceeds the 25 MiB attachment limit.');
        const bytes = new Uint8Array(await file.arrayBuffer());
        const reservation = await cloud.reserve(workspaceId, file.name, bytes, crypto.randomUUID());
        let fileId: string;
        if (reservation.status === 'upload_pending') {
          await cloud.upload(reservation, bytes);
          const result = await cloud.finalize(reservation.uploadSessionId);
          const finalizedFileId = result.fileId;
          if (typeof finalizedFileId !== 'string' || !finalizedFileId) throw new Error('Cloud upload finalized without a file ID.');
          fileId = finalizedFileId;
        } else {
          if (typeof reservation.fileId !== 'string' || !reservation.fileId) throw new Error('Cloud upload reservation did not return a file ID.');
          fileId = reservation.fileId;
        }
        const attachment = { fileId, name: file.name, sizeBytes: file.size, mimeType: file.type || 'application/octet-stream' };
        if (scopeRef.current === scope) setPending((current) => [...current, attachment]);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The Bunny upload could not be completed.');
    } finally {
      setUploading(false);
    }
  };

  const onFiles = (event: ChangeEvent<HTMLInputElement>) => {
    const files = event.target.files ? Array.from(event.target.files) : [];
    event.target.value = '';
    void uploadFiles(files);
  };

  const startRecording = async () => {
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
      setError('Voice recording is not supported by this browser.');
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      recordingStream.current = stream;
      recordingParts.current = [];
      const preferred = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : undefined;
      const instance = preferred ? new MediaRecorder(stream, { mimeType: preferred }) : new MediaRecorder(stream);
      recorder.current = instance;
      instance.ondataavailable = (event) => { if (event.data.size) recordingParts.current.push(event.data); };
      instance.onstop = () => {
        const blob = new Blob(recordingParts.current, { type: instance.mimeType || 'audio/webm' });
        stream.getTracks().forEach((track) => track.stop());
        recordingStream.current = null;
        recorder.current = null;
        setRecording(false);
        if (blob.size) void uploadFiles([new File([blob], 'voice-message-' + Date.now() + (blob.type.includes('mp4') ? '.m4a' : blob.type.includes('ogg') ? '.ogg' : '.webm'), { type: blob.type })]);
      };
      instance.start(250);
      setRecording(true);
      setError('');
    } catch (cause) {
      recordingStream.current?.getTracks().forEach((track) => track.stop());
      recordingStream.current = null;
      setError(cause instanceof Error ? cause.message : 'Microphone permission was not granted.');
    }
  };

  const send = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const clean = body.trim();
    if (!clean && pending.length === 0) return;
    const scope = conversationId;
    try {
      setError('');
      await officeTeamApi.sendRichMessage(client, conversationId, clean || (pending.length ? 'Attachment' : ''), attachmentMessageType(pending), pending, reply?.message_id ?? null);
      if (scopeRef.current !== scope) return;
      setBody('');
      setPending([]);
      setReply(null);
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The message could not be sent.');
    }
  };

  const saveEdit = async () => {
    if (!editing || !editBody.trim()) return;
    try {
      await officeTeamApi.editMessage(client, editing.message_id, editBody.trim());
      setEditing(null);
      setEditBody('');
      await refresh();
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'The message could not be edited.'); }
  };

  const removeMessage = async (message: OfficeRichMessage) => {
    if (!window.confirm('Delete this message for everyone in this conversation?')) return;
    try {
      await officeTeamApi.deleteMessage(client, message.message_id);
      await refresh();
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'The message could not be deleted.'); }
  };

  const downloadAttachment = async (attachment: OfficeChatAttachment) => {
    try {
      setError('');
      let file: CloudFile | null = null;
      for (let offset = 0; offset <= 10000; offset += 50) {
        const page = await cloud.list(workspaceId, false, offset);
        file = page.find((item) => item.fileId === attachment.fileId) ?? null;
        if (file || page.length < 50) break;
      }
      if (!file) throw new Error('This attachment is no longer available in the workspace cloud.');
      const bytes = await cloud.download(file);
      const safeBuffer = bytes.slice().buffer as ArrayBuffer;
      const url = URL.createObjectURL(new Blob([safeBuffer], { type: attachment.mimeType }));
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = attachment.name;
      anchor.rel = 'noopener';
      anchor.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1500);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The attachment could not be downloaded.');
    }
  };

  const readIndex = (messageId: string | null) => messageId ? messages.findIndex((message) => message.message_id === messageId) : -1;

  return <section className="office-chat-panel" aria-label="Conversation messages">
    <div className="office-chat-toolbar">
      <div><span className="office-chat-kicker">SECURE TEAM MESSAGING</span><strong>Conversation</strong></div>
      <span className={live ? 'office-chat-connection is-live' : 'office-chat-connection'}><Radio size={13} /> {live ? 'LIVE' : 'RECONNECTING'}</span>
    </div>
    {error && <div className="office-chat-error" role="alert">{error}</div>}
    <div className="office-chat-messages" aria-live="polite">
      {loading ? <p className="office-chat-empty">Loading conversation…</p> : messages.length === 0 ? <p className="office-chat-empty">Your conversation is ready. Send a message, attach a file, or record a voice note.</p> : messages.map((message, index) => {
        const own = message.author_id === user.id;
        const seenCount = reads.filter((reader) => reader.user_id !== user.id && readIndex(reader.last_read_message_id) >= index).length;
        return <article className={'office-chat-message' + (own ? ' is-own' : '') + (message.deleted_at ? ' is-deleted' : '')} key={message.message_id}>
          <div className="office-chat-message-head"><strong>{own ? 'You' : message.author_name}</strong><time>{new Date(message.created_at).toLocaleString()}</time></div>
          {message.reply_to_message_id && <div className="office-chat-reply-preview"><Reply size={12} /><span>{message.reply_author_name || 'Earlier message'}: {message.reply_body || 'Reply'}</span></div>}
          {message.deleted_at ? <p className="office-chat-deleted">This message was deleted</p> : <>
            {message.body && !(message.body === 'Attachment' && message.attachments.length > 0) && <p className="office-chat-message-body">{message.body}</p>}
            {message.attachments.map((attachment) => <div className="office-chat-attachment" key={attachment.fileId}>
              <span><Paperclip size={14} /><span><strong>{attachment.name}</strong><small>{formatBytes(attachment.sizeBytes)} · {attachment.mimeType}</small></span></span>
              <button type="button" onClick={() => void downloadAttachment(attachment)} aria-label={'Download ' + attachment.name}><Download size={15} /></button>
            </div>)}
            {editing?.message_id === message.message_id ? <div className="office-chat-edit"><textarea value={editBody} onChange={(event) => setEditBody(event.target.value)} maxLength={4000} /><button type="button" onClick={() => void saveEdit()}>Save</button><button type="button" onClick={() => setEditing(null)}>Cancel</button></div> : <div className="office-chat-message-actions">
              <button type="button" onClick={() => setReply(message)}><Reply size={13} /> Reply</button>
              {own && <button type="button" onClick={() => { setEditing(message); setEditBody(message.body); }} disabled={message.attachments.length > 0}><Pencil size={13} /> Edit</button>}
              {(own || canModerate) && <button type="button" onClick={() => void removeMessage(message)}><Trash2 size={13} /> Delete</button>}
            </div>}
          </>}
          {own && !message.deleted_at && <span className="office-chat-seen"><CheckCheck size={12} /> {seenCount ? 'Seen by ' + seenCount : 'Sent'}</span>}
        </article>;
      })}
    </div>
    {reply && <div className="office-chat-composer-context"><Reply size={14} /><span>Replying to {reply.author_name}: {reply.body || 'Attachment'}</span><button type="button" onClick={() => setReply(null)} aria-label="Cancel reply"><X size={14} /></button></div>}
    {pending.length > 0 && <div className="office-chat-pending">{pending.map((item) => <span key={item.fileId}>{item.name}<button type="button" onClick={() => setPending((current) => current.filter((entry) => entry.fileId !== item.fileId))} aria-label={'Remove ' + item.name}><X size={12} /></button></span>)}</div>}
    <form className="office-chat-composer" onSubmit={send}>
      <input ref={fileInput} type="file" multiple hidden onChange={onFiles} />
      <button type="button" title="Attach files" aria-label="Attach files" disabled={disabled || uploading} onClick={() => fileInput.current?.click()}><Paperclip size={17} /></button>
      <button type="button" title={recording ? 'Stop recording' : 'Record voice message'} aria-label={recording ? 'Stop recording' : 'Record voice message'} disabled={disabled || uploading} className={recording ? 'is-recording' : ''} onClick={() => recording ? recorder.current?.stop() : void startRecording()}>{recording ? <Square size={15} /> : <Mic size={17} />}</button>
      <textarea value={body} onChange={(event) => setBody(event.target.value)} maxLength={4000} placeholder="Write a message…" disabled={disabled || uploading || recording} aria-label="Write a message" />
      <button type="submit" className="office-chat-send" disabled={disabled || uploading || (!body.trim() && pending.length === 0)}><Send size={16} /><span>Send</span></button>
    </form>
    <p className="office-chat-footnote">{uploading ? 'Uploading securely to Bunny cloud…' : 'Files up to 25 MiB · workspace quota applies · secure Bunny uploads with checksum verification · ' + (live ? 'Realtime connected' : '15-second fallback refresh')}</p>
  </section>;
}
