import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ChangeEvent, FormEvent } from 'react';
import type { SupabaseClient, User } from '@supabase/supabase-js';
import { CheckCheck, Download, Mic, Paperclip, Pencil, Play, Radio, Reply, Send, Square, Trash2, X } from 'lucide-react';
import { createOfficeCloudApi } from './lib/officeCloudFiles';
import type { CloudFile } from './lib/officeCloudFiles';
import { officeTeamApi } from './lib/officeTeamApi';
import type { OfficeChatAttachment, OfficeConversationRead, OfficeRichMessage } from './lib/officeTeamApi';
import { buildAudioWaveform, buildLiveAudioWaveform } from './lib/officeAudioWaveform';
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

function createChatUploadUuid() {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('');
  return hex.slice(0, 8) + '-' + hex.slice(8, 12) + '-' + hex.slice(12, 16) + '-' + hex.slice(16, 20) + '-' + hex.slice(20);
}

function previewMimeType(attachment: OfficeChatAttachment) {
  const supplied = attachment.mimeType.split(';')[0].trim().toLowerCase();
  if (supplied && supplied !== 'application/octet-stream') return supplied;
  const name = attachment.name.toLowerCase();
  if (name.endsWith('.png')) return 'image/png';
  if (/\.(jpe?g)$/.test(name)) return 'image/jpeg';
  if (name.endsWith('.gif')) return 'image/gif';
  if (name.endsWith('.webp')) return 'image/webp';
  if (name.endsWith('.avif')) return 'image/avif';
  if (/\.(mp4|m4v)$/.test(name)) return 'video/mp4';
  if (name.endsWith('.webm')) return 'video/webm';
  if (name.endsWith('.mov')) return 'video/quicktime';
  if (name.endsWith('.wav')) return 'audio/wav';
  if (name.endsWith('.ogg')) return 'audio/ogg';
  if (name.endsWith('.m4a')) return 'audio/mp4';
  if (name.endsWith('.aac')) return 'audio/aac';
  if (name.endsWith('.flac')) return 'audio/flac';
  if (name.endsWith('.mp3')) return 'audio/mpeg';
  return supplied || 'application/octet-stream';
}
const SAFE_PREVIEW_MIMES = new Set(['image/png','image/jpeg','image/gif','image/webp','image/avif','video/mp4','video/webm','video/quicktime','audio/webm','audio/ogg','audio/mpeg','audio/mp4','audio/wav','audio/aac','audio/flac']);
const canPreviewAttachment = (attachment: OfficeChatAttachment) => SAFE_PREVIEW_MIMES.has(previewMimeType(attachment));

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
  const [previewUrls, setPreviewUrls] = useState<Record<string, string>>({});
  const [waveforms, setWaveforms] = useState<Record<string, number[]>>({});
  const [recordingWaveform, setRecordingWaveform] = useState<number[]>([]);
  const [playbackProgress, setPlaybackProgress] = useState<Record<string, number>>({});
  const fileInput = useRef<HTMLInputElement>(null);
  const recorder = useRef<MediaRecorder | null>(null);
  const recordingStream = useRef<MediaStream | null>(null);
  const recordingParts = useRef<BlobPart[]>([]);
  const recordingConversation = useRef<string | null>(null);
  const recordingAudioContext = useRef<AudioContext | null>(null);
  const recordingAnalyser = useRef<AnalyserNode | null>(null);
  const recordingAnimation = useRef<number | null>(null);
  const previewUrlsRef = useRef<Record<string, string>>({});
  const scopeRef = useRef(conversationId);

  useEffect(() => {
    scopeRef.current = conversationId;
    setBody('');
    setReply(null);
    setEditing(null);
    setPending([]);
    setError('');
    for (const url of Object.values(previewUrlsRef.current)) URL.revokeObjectURL(url);
    previewUrlsRef.current = {};
    setPreviewUrls({});
    setWaveforms({});
    setPlaybackProgress({});
    setRecordingWaveform([]);
    if (recorder.current?.state === 'recording') recorder.current.stop();
  }, [conversationId]);

  useEffect(() => () => {
    const activeRecorder = recorder.current;
    if (activeRecorder) {
      activeRecorder.ondataavailable = null;
      activeRecorder.onstop = null;
      if (activeRecorder.state === 'recording') activeRecorder.stop();
    }
    recordingStream.current?.getTracks().forEach((track) => track.stop());
    recordingStream.current = null;
    if (recordingAnimation.current !== null) window.cancelAnimationFrame(recordingAnimation.current);
    void recordingAudioContext.current?.close().catch(() => undefined);
    for (const url of Object.values(previewUrlsRef.current)) URL.revokeObjectURL(url);
  }, []);

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
    let fallback: ReturnType<typeof setInterval> | null = null;
    const poll = () => {
      if (fallback) return;
      fallback = setInterval(() => { void refresh().catch((cause) => { if (alive) setError(cause instanceof Error ? cause.message : 'Could not refresh chat.'); }); }, 15000);
    };
    const stopPoll = () => {
      if (fallback) clearInterval(fallback);
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
    for (const url of Object.values(previewUrlsRef.current)) URL.revokeObjectURL(url);
    previewUrlsRef.current = {};
  }, []);

  const uploadFiles = async (files: File[]) => {
    if (!files.length) return;
    if (pending.length + files.length > 10) { setError('A message can include up to 10 attachments.'); return; }
    const scope = conversationId;
    const activeUploadSessions: string[] = [];
    setUploading(true);
    setError('');
    try {
      for (const file of files) {
        if (!file.size || file.size > MAX_CHAT_FILE_BYTES) throw new Error(file.name + ' exceeds the 25 MiB attachment limit.');
        const normalizedName = file.name.normalize('NFC').trim().replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 180);
        if (!normalizedName) throw new Error('Choose a file with a valid name.');
        const bytes = new Uint8Array(await file.arrayBuffer());
        const reservation = await cloud.reserve(workspaceId, normalizedName, bytes, createChatUploadUuid());
        let fileId: string;
        if (reservation.status === 'upload_pending') {
          activeUploadSessions.push(reservation.uploadSessionId);
          await cloud.upload(reservation, bytes);
          const result = await cloud.finalize(reservation.uploadSessionId);
          const finalizedFileId = result.fileId;
          if (typeof finalizedFileId !== 'string' || !finalizedFileId) throw new Error('Cloud upload finalized without a file ID.');
          activeUploadSessions.splice(activeUploadSessions.indexOf(reservation.uploadSessionId), 1);
          fileId = finalizedFileId;
        } else {
          if (typeof reservation.fileId !== 'string' || !reservation.fileId) throw new Error('Cloud upload reservation did not return a file ID.');
          fileId = reservation.fileId;
        }
        const attachment = { fileId, name: normalizedName, sizeBytes: file.size, mimeType: file.type || 'application/octet-stream' };
        if (scopeRef.current === scope) setPending((current) => [...current, attachment]);
        else {
          await cloud.trash(fileId).catch(() => undefined);
        }
      }
    } catch (cause) {
      await Promise.all(activeUploadSessions.map((sessionId) => cloud.abandonUpload(sessionId).catch(() => undefined)));
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
      recordingConversation.current = conversationId;
      recordingParts.current = [];
      const preferred = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : undefined;
      const instance = preferred ? new MediaRecorder(stream, { mimeType: preferred }) : new MediaRecorder(stream);
      recorder.current = instance;
      instance.ondataavailable = (event) => { if (event.data.size) recordingParts.current.push(event.data); };
      if (typeof window.AudioContext === 'function') {
        try {
          const audioContext = new AudioContext();
          const analyser = audioContext.createAnalyser();
          analyser.fftSize = 128;
          audioContext.createMediaStreamSource(stream).connect(analyser);
          recordingAudioContext.current = audioContext;
          recordingAnalyser.current = analyser;
          const bins = new Uint8Array(analyser.frequencyBinCount);
          const drawWaveform = () => {
            if (!recordingAnalyser.current) return;
            recordingAnalyser.current.getByteFrequencyData(bins);
            setRecordingWaveform(buildLiveAudioWaveform(bins));
            recordingAnimation.current = window.requestAnimationFrame(drawWaveform);
          };
          void audioContext.resume().then(drawWaveform, drawWaveform);
        } catch { setRecordingWaveform(Array.from({ length: 40 }, (_, index) => 18 + ((index * 17) % 29))); }
      }
      instance.onstop = () => {
        const blob = new Blob(recordingParts.current, { type: instance.mimeType || 'audio/webm' });
        if (recordingAnimation.current !== null) window.cancelAnimationFrame(recordingAnimation.current);
        recordingAnimation.current = null;
        recordingAnalyser.current = null;
        void recordingAudioContext.current?.close().catch(() => undefined);
        recordingAudioContext.current = null;
        setRecordingWaveform([]);
        stream.getTracks().forEach((track) => track.stop());
        recordingStream.current = null;
        recorder.current = null;
        setRecording(false);
        const belongsToOpenConversation = recordingConversation.current === scopeRef.current;
        recordingConversation.current = null;
        if (blob.size && belongsToOpenConversation) void uploadFiles([new File([blob], 'voice-message-' + Date.now() + (blob.type.includes('mp4') ? '.m4a' : blob.type.includes('ogg') ? '.ogg' : '.webm'), { type: blob.type })]);
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

  const readAttachmentBlob = async (attachment: OfficeChatAttachment) => {
    let file: CloudFile | null = null;
    for (let offset = 0; offset <= 10000; offset += 50) {
      const page = await cloud.list(workspaceId, false, offset);
      file = page.find((item) => item.fileId === attachment.fileId) ?? null;
      if (file || page.length < 50) break;
    }
    if (!file) throw new Error('This attachment is no longer available in the workspace cloud.');
    const bytes = await cloud.download(file);
    const safeBuffer = bytes.slice().buffer as ArrayBuffer;
    return new Blob([safeBuffer], { type: previewMimeType(attachment) });
  };

  const downloadAttachment = async (attachment: OfficeChatAttachment) => {
    try {
      setError('');
      const blob = await readAttachmentBlob(attachment);
      const url = URL.createObjectURL(blob);
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

  const previewAttachment = async (attachment: OfficeChatAttachment) => {
    const existing = previewUrls[attachment.fileId];
    if (existing) {
      URL.revokeObjectURL(existing);
      delete previewUrlsRef.current[attachment.fileId];
      setPreviewUrls((current) => { const next = { ...current }; delete next[attachment.fileId]; return next; });
      setWaveforms((current) => { const next = { ...current }; delete next[attachment.fileId]; return next; });
      return;
    }
    const scope = conversationId;
    try {
      setError('');
      const blob = await readAttachmentBlob(attachment);
      const url = URL.createObjectURL(blob);
      if (scopeRef.current !== scope) { URL.revokeObjectURL(url); return; }
      previewUrlsRef.current[attachment.fileId] = url;
      setPreviewUrls((current) => ({ ...current, [attachment.fileId]: url }));
      if (previewMimeType(attachment).startsWith('audio/') && typeof window.AudioContext !== 'undefined') {
        let context: AudioContext | null = null;
        try {
          context = new window.AudioContext();
          const decoded = await context.decodeAudioData(await blob.arrayBuffer());
          const samples = decoded.getChannelData(0);
          const bars = buildAudioWaveform(samples, 48);
          if (scopeRef.current === scope) setWaveforms((current) => ({ ...current, [attachment.fileId]: bars }));
        } catch { /* Audio playback remains available when waveform decoding is unsupported. */ }
        finally { await context?.close().catch(() => undefined); }
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The attachment preview could not be loaded.');
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
            {message.attachments.map((attachment) => {
              const mime = previewMimeType(attachment);
              const previewUrl = previewUrls[attachment.fileId];
              const previewable = canPreviewAttachment(attachment);
              return <div className="office-chat-attachment-wrap" key={attachment.fileId}>
                <div className="office-chat-attachment">
                  <span><Paperclip size={14} /><span><strong>{attachment.name}</strong><small>{formatBytes(attachment.sizeBytes)} · {mime}</small></span></span>
                  <span className="office-chat-attachment-actions">
                    {previewable && <button type="button" onClick={() => void previewAttachment(attachment)} aria-label={(previewUrl ? 'Hide preview of ' : 'Preview ') + attachment.name}>{previewUrl ? <X size={15} /> : <Play size={15} />}</button>}
                    <button type="button" onClick={() => void downloadAttachment(attachment)} aria-label={'Download ' + attachment.name}><Download size={15} /></button>
                  </span>
                </div>
                {previewUrl && mime.startsWith('image/') && <img className="office-chat-image-preview" src={previewUrl} alt={attachment.name} loading="lazy" />}
                {previewUrl && mime.startsWith('video/') && <video className="office-chat-video-preview" src={previewUrl} controls preload="metadata" />}
                {previewUrl && mime.startsWith('audio/') && <div className="office-chat-audio-preview">
                  {waveforms[attachment.fileId] && <div className="office-chat-waveform" aria-label="Audio waveform">{waveforms[attachment.fileId].map((height, index) => <span key={index} className={index / waveforms[attachment.fileId].length <= (playbackProgress[attachment.fileId] ?? 0) ? 'is-played' : ''} style={{ height: height + '%' }} />)}</div>}
                  <audio src={previewUrl} controls preload="metadata" onTimeUpdate={(event) => { const audio = event.currentTarget; setPlaybackProgress((current) => ({ ...current, [attachment.fileId]: audio.duration > 0 ? audio.currentTime / audio.duration : 0 })); }} onEnded={() => setPlaybackProgress((current) => ({ ...current, [attachment.fileId]: 1 }))} />
                </div>}
              </div>;
            })}
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
    {recording && <div className="office-chat-recording" role="status" aria-label="Live audio recording waveform"><span className="office-chat-recording-dot" /><strong>Recording voice note</strong><div className="office-chat-waveform is-live" aria-hidden="true">{(recordingWaveform.length ? recordingWaveform : Array(40).fill(12)).map((height, index) => <span key={index} style={{ height: height + '%' }} />)}</div><small>Tap stop to send</small></div>}
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
