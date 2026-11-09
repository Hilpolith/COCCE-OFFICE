import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');
const edge = read('../supabase/functions/office-ai-chat/index.ts');
const drive = read('../supabase/functions/office-ai-chat/drive-context.ts');
const migration = read('../supabase/migrations/20261109104406_office_ai_message_search.sql');
const aiUi = read('../src/OfficeAiWorkspace.tsx');
const aiTest = read('../src/OfficeAiWorkspace.test.tsx');
const chatUi = read('../src/OfficeChatPanel.tsx');

test('COCCE AI uses authenticated relevance search and excludes deleted fallback messages', () => {
  assert.match(edge, /office_search_ai_messages/);
  assert.match(edge, /p_query: body\.prompt\.trim\(\)/);
  assert.match(edge, /office_list_rich_messages/);
  assert.match(edge, /message\.deleted_at !== null/);
  assert.match(edge, /MAX_HISTORY = 24/);
  assert.match(edge, /office_get_workspace_ai_enabled/);
});

test('COCCE AI supports bounded multi-turn chat without persisting private chat text', () => {
  assert.match(edge, /MAX_CHAT_HISTORY = 12/);
  assert.match(edge, /MAX_CHAT_TURN_CHARS = 3_000/);
  assert.match(edge, /function isValidChatHistory/);
  assert.match(edge, /body\.history !== undefined && !isValidChatHistory\(body\.history\)/);
  assert.match(edge, /\.\.\.chatHistory/);
  assert.match(aiUi, /turns\.slice\(-12\)/);
  assert.match(aiUi, /New chat/);
  assert.match(aiTest, /multi-turn chat thread/);
});

test('selected Drive file context remains bounded and pinned to Bunny', () => {
  assert.match(edge, /loadSelectedDriveFiles/);
  assert.match(drive, /MAX_DRIVE_FILES = 3/);
  assert.match(drive, /MAX_DRIVE_FILE_BYTES = 512 \* 1024/);
  assert.match(drive, /MAX_DRIVE_CONTEXT_CHARS = 20_000/);
  assert.match(drive, /de-s3\.storage\.bunnycdn\.com/);
  assert.match(drive, /sha256Hex/);
});

test('selected Drive content requires per-request external provider consent', () => {
  assert.match(aiUi, /showDriveConsent/);
  assert.match(aiUi, /Share selected Drive content with COCCE AI/);
  assert.match(aiUi, /OpenRouter's Google AI Studio free-model provider/);
  assert.match(aiUi, /Send selected content/);
  assert.match(aiUi, /This is not a zero-data-retention guarantee/);
  assert.match(aiTest, /requires explicit consent/);
});

test('AI provider is pinned to the free Google AI Studio route without fallback', () => {
  assert.match(edge, /google\/gemma-4-31b-it:free/);
  assert.match(edge, /only: \["google-ai-studio"\], allow_fallbacks: false/);
  assert.match(edge, /result\?\.model !== FREE_MODEL/);
  assert.match(edge, /positiveCost/);
  assert.match(edge, /\|\| positiveCost/);
  assert.match(edge, /OPENROUTER_API_KEY/);
});

test('chat media previews use a strict MIME allowlist and release object URLs', () => {
  assert.match(chatUi, /SAFE_PREVIEW_MIMES/);
  assert.match(chatUi, /previewAttachment/);
  assert.match(chatUi, /decodeAudioData/);
  assert.match(chatUi, /URL\.revokeObjectURL/);
  assert.match(chatUi, /office-chat-image-preview/);
  assert.match(chatUi, /office-chat-video-preview/);
  assert.match(chatUi, /office-chat-audio-preview/);
});

test('restored message-search migration retains server-side membership and ACL guards', () => {
  assert.match(migration, /office_private\.is_active_member/);
  assert.match(migration, /office_private\.can_read_conversation/);
  assert.match(migration, /m\.deleted_at\s+is\s+null/i);
  assert.match(migration, /SECURITY DEFINER/);
  assert.match(migration, /revoke all on function/i);
  assert.match(migration, /grant execute on function .*authenticated, service_role/i);
});
