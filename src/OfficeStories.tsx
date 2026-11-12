import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import { Clock3, Eye, ImagePlus, LoaderCircle, Plus, Trash2, Video, X } from 'lucide-react';
import { officeTeamApi, type OfficeStory } from './lib/officeTeamApi';
import { createOfficeCloudApi, OFFICE_CLOUD_MAX_FILE_BYTES, type CloudFile } from './lib/officeCloudFiles';
import './officeStories.css';

const STORY_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'video/mp4', 'video/webm']);

function createIdempotencyKey() {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function storyTimeLeft(expiresAt: string) {
  const remaining = Math.max(0, Date.parse(expiresAt) - Date.now());
  const hours = Math.floor(remaining / 3_600_000);
  const minutes = Math.floor((remaining % 3_600_000) / 60_000);
  return hours ? `${hours}h left` : `${minutes}m left`;
}

export default function OfficeStories({
  client, publicKey, userId, workspaceId,
}: {
  client: SupabaseClient;
  publicKey: string;
  userId: string;
  workspaceId: string;
}) {
  const cloud = useMemo(() => createOfficeCloudApi(client, publicKey, userId), [client, publicKey, userId]);
  const [stories, setStories] = useState<OfficeStory[]>([]);
  const [loading, setLoading] = useState(true);
  const [publishing, setPublishing] = useState(false);
  const [composeOpen, setComposeOpen] = useState(false);
  const [caption, setCaption] = useState('');
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [activeStory, setActiveStory] = useState<OfficeStory | null>(null);
  const [viewerUrl, setViewerUrl] = useState('');
  const [viewerLoading, setViewerLoading] = useState(false);
  const [error, setError] = useState('');
  const fileInput = useRef<HTMLInputElement>(null);
  const viewerUrlRef = useRef('');

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      setStories(await officeTeamApi.listStories(client, workspaceId));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Stories could not be loaded.');
    } finally {
      setLoading(false);
    }
  }, [client, workspaceId]);

  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => () => {
    if (viewerUrlRef.current) URL.revokeObjectURL(viewerUrlRef.current);
  }, []);

  const closeViewer = () => {
    if (viewerUrlRef.current) URL.revokeObjectURL(viewerUrlRef.current);
    viewerUrlRef.current = '';
    setViewerUrl('');
    setActiveStory(null);
    setViewerLoading(false);
  };

  const publish = async () => {
    const cleanCaption = caption.trim();
    if (!cleanCaption && !selectedFile) return;
    setPublishing(true);
    setError('');
    let uploadedFileId: string | null = null;
    try {
      let mediaType: OfficeStory['media_type'] = 'text';
      let mediaContentType = 'text/plain';
      if (selectedFile) {
        const mime = selectedFile.type.toLowerCase();
        if (!STORY_MIME_TYPES.has(mime)) throw new Error('Choose a JPEG, PNG, WebP, MP4 or WebM file.');
        if (selectedFile.size < 1 || selectedFile.size > OFFICE_CLOUD_MAX_FILE_BYTES) throw new Error('Story media must be between 1 byte and 25 MiB.');
        mediaType = mime.startsWith('image/') ? 'image' : 'video';
        mediaContentType = mime;
        const bytes = new Uint8Array(await selectedFile.arrayBuffer());
        const reservation = await cloud.reserve(workspaceId, selectedFile.name, bytes, createIdempotencyKey());
        uploadedFileId = reservation.fileId;
        if (reservation.status === 'upload_pending') {
          await cloud.upload(reservation, bytes);
          await cloud.finalize(reservation.uploadSessionId);
        }
      }
      await officeTeamApi.createStory(client, workspaceId, cleanCaption, uploadedFileId, mediaType, mediaContentType);
      setCaption('');
      setSelectedFile(null);
      if (fileInput.current) fileInput.current.value = '';
      setComposeOpen(false);
      await refresh();
    } catch (cause) {
      if (uploadedFileId) await cloud.trash(uploadedFileId).catch(() => undefined);
      setError(cause instanceof Error ? cause.message : 'The story could not be published.');
    } finally {
      setPublishing(false);
    }
  };

  const openStory = async (story: OfficeStory) => {
    closeViewer();
    setActiveStory(story);
    setViewerLoading(Boolean(story.media_file_id));
    setError('');
    try {
      if (story.author_id !== userId && !story.viewed_by_me) {
        try {
          await officeTeamApi.markStoryViewed(client, story.story_id);
          setStories((current) => current.map((item) => item.story_id === story.story_id ? { ...item, viewed_by_me: true, view_count: item.view_count + 1 } : item));
        } catch { /* A view-count write failure must not block reading the story. */ }
      }
      if (story.media_file_id) {
        const sync = await cloud.getSyncState(story.media_file_id);
        if (!sync) throw new Error('This story media is no longer available.');
        const file: CloudFile = {
          fileId: sync.fileId, workspaceId: sync.workspaceId, displayName: sync.displayName,
          sizeBytes: sync.sizeBytes, sha256Hex: sync.sha256Hex, createdAt: sync.updatedAt,
        };
        const bytes = await cloud.download(file);
        const url = URL.createObjectURL(new Blob([bytes], { type: story.media_content_type }));
        viewerUrlRef.current = url;
        setViewerUrl(url);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Story media could not be opened.');
    } finally {
      setViewerLoading(false);
    }
  };

  const removeStory = async () => {
    if (!activeStory || activeStory.author_id !== userId) return;
    const story = activeStory;
    try {
      await officeTeamApi.deleteStory(client, story.story_id);
      if (story.media_file_id) await cloud.trash(story.media_file_id).catch(() => undefined);
      closeViewer();
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The story could not be deleted.');
    }
  };

  return <section className="office-stories" aria-label="Workspace stories">
    <div className="office-stories-heading"><div><strong>Stories</strong><span>Disappearing after 24 hours</span></div><button type="button" className="office-story-add-button" onClick={() => setComposeOpen(true)}><Plus size={15} /> Add story</button></div>
    <div className="office-stories-strip">
      <button type="button" className="office-story-bubble is-add" onClick={() => setComposeOpen(true)} aria-label="Add your story"><span className="office-story-avatar"><Plus size={19} /></span><small>Your story</small></button>
      {loading && <span className="office-stories-loading"><LoaderCircle size={15} /> Loading stories</span>}
      {!loading && stories.map((story) => <button type="button" key={story.story_id} className={`office-story-bubble ${story.viewed_by_me || story.author_id === userId ? 'is-seen' : 'is-new'}`} onClick={() => void openStory(story)} aria-label={`View story from ${story.author_name}`}>
        <span className="office-story-avatar">{story.author_avatar_url ? <img src={story.author_avatar_url} alt="" /> : <span>{story.author_name.trim().slice(0, 1).toUpperCase()}</span>}</span>
        <small>{story.author_id === userId ? 'Your story' : story.author_name}</small>
      </button>)}
      {!loading && !stories.length && <p className="office-stories-empty">No stories yet. Share a quick update with this workspace.</p>}
    </div>
    {error && <p className="office-stories-error" role="alert">{error}</p>}

    {composeOpen && <div className="office-story-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !publishing) setComposeOpen(false); }}>
      <section className="office-story-compose" role="dialog" aria-modal="true" aria-label="Create a story">
        <header><div><span className="eyebrow">WORKSPACE MOMENT</span><h3>Create story</h3></div><button type="button" aria-label="Close story composer" onClick={() => setComposeOpen(false)} disabled={publishing}><X size={18} /></button></header>
        <textarea value={caption} onChange={(event) => setCaption(event.target.value.slice(0, 500))} maxLength={500} placeholder="Share an update with your workspace…" rows={4} />
        <div className="office-story-compose-footer"><label className="office-story-media-pick"><ImagePlus size={16} /> Photo or video<input ref={fileInput} type="file" accept="image/jpeg,image/png,image/webp,video/mp4,video/webm" onChange={(event) => setSelectedFile(event.target.files?.[0] ?? null)} /></label><small>{selectedFile ? selectedFile.name : `${caption.length}/500 · 24-hour story`}</small></div>
        <button type="button" className="office-story-publish" onClick={() => void publish()} disabled={publishing || (!caption.trim() && !selectedFile)}>{publishing ? <><LoaderCircle size={15} /> Publishing…</> : 'Share story'}</button>
      </section>
    </div>}

    {activeStory && <div className="office-story-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) closeViewer(); }}>
      <section className="office-story-viewer" role="dialog" aria-modal="true" aria-label={`Story from ${activeStory.author_name}`}>
        <header><div className="office-story-viewer-author">{activeStory.author_avatar_url ? <img src={activeStory.author_avatar_url} alt="" /> : <span>{activeStory.author_name.trim().slice(0, 1).toUpperCase()}</span>}<div><strong>{activeStory.author_name}</strong><small><Clock3 size={11} /> {storyTimeLeft(activeStory.expires_at)}</small></div></div><div className="office-story-viewer-actions">{activeStory.author_id === userId && <button type="button" aria-label="Delete story" onClick={() => void removeStory()}><Trash2 size={16} /></button>}<button type="button" aria-label="Close story" onClick={closeViewer}><X size={18} /></button></div></header>
        <div className="office-story-media-stage">
          {viewerLoading && <span className="office-stories-loading"><LoaderCircle size={18} /> Loading media…</span>}
          {!viewerLoading && viewerUrl && activeStory.media_type === 'image' && <img src={viewerUrl} alt={activeStory.caption || 'Workspace story'} />}
          {!viewerLoading && viewerUrl && activeStory.media_type === 'video' && <video src={viewerUrl} controls autoPlay playsInline />}
          {!viewerLoading && !viewerUrl && <p>{activeStory.caption}</p>}
        </div>
        {activeStory.caption && viewerUrl && <p className="office-story-viewer-caption">{activeStory.caption}</p>}
        <footer><span><Eye size={13} /> {activeStory.view_count} views</span><span>{activeStory.media_type === 'video' ? <Video size={13} /> : null}{activeStory.media_type.toUpperCase()}</span></footer>
      </section>
    </div>}
  </section>;
}
