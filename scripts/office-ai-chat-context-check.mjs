import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');
const edge = read('../supabase/functions/office-ai-chat/index.ts');
const drive = read('../supabase/functions/office-ai-chat/drive-context.ts');
const sector = read('../supabase/functions/office-ai-chat/sector-context.ts');
const sectorTest = read('../supabase/functions/office-ai-chat/sector-context.test.ts');
const migration = read('../supabase/migrations/20261109104406_office_ai_message_search.sql');
const aiUi = read('../src/OfficeAiWorkspace.tsx');
const aiTest = read('../src/OfficeAiWorkspace.test.tsx');
const chatUi = read('../src/OfficeChatPanel.tsx');
const workspaceAiMigration = read('../supabase/migrations/20261112102219_fix_office_workspace_ai_enabled_membership_schema.sql');

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
  assert.match(edge, /loadDriveInventory/);
  assert.match(edge, /includeDriveInventory/);
  assert.match(drive, /export async function loadDriveInventory/);
  assert.match(drive, /MAX_DRIVE_FILES = 3/);
  assert.match(drive, /MAX_DRIVE_FILE_BYTES = 512 \* 1024/);
  assert.match(drive, /MAX_DRIVE_CONTEXT_CHARS = 20_000/);
  assert.match(drive, /de-s3\.storage\.bunnycdn\.com/);
  assert.match(drive, /sha256Hex/);
});

test('selected Drive content requires per-request external provider consent', () => {
  assert.match(aiUi, /showDriveConsent/);
  assert.match(aiUi, /Let COCCE AI inspect your cloud files for this answer/);
  assert.match(aiUi, /Share selected Drive content with COCCE AI/);
  assert.match(aiUi, /OpenRouter's free-model router/);
  assert.match(aiUi, /Send selected content/);
  assert.match(aiUi, /This is not a zero-data-retention guarantee/);
  assert.match(aiTest, /requires explicit consent/);
});

test('sector work queue context is opt-in, membership-checked, bounded and excludes sensitive fields', () => {
  assert.match(edge, /includeSectorRecords/);
  assert.match(edge, /loadSectorWorkItems/);
  assert.match(edge, /office_industry_get_space/);
  assert.match(sector, /office_industry_list_work_items/);
  assert.match(sector, /MAX_WORKSPACES = 20/);
  assert.match(sector, /MAX_ITEMS_PER_WORKSPACE = 8/);
  assert.match(sector, /notes and personal identifiers are excluded/i);
  assert.doesNotMatch(sector, /assignee_user_id:/);
  assert.match(sectorTest, /omits notes and personal identifiers/);
});

test('sector work queue sharing requires per-request confirmation and remains read-only', () => {
  assert.match(aiUi, /Industry work queue context/);
  assert.match(aiUi, /Share sector context/);
  assert.match(aiUi, /includeSectorRecords: true/);
  assert.match(edge, /Never execute or claim to execute an action/);
});

test('AI provider delegates to the authenticated OpenRouter free router and rejects paid responses', () => {
  assert.ok(edge.includes('/api/office-ai-provider'));
  assert.ok(edge.includes('const FREE_MODEL = "openrouter/free"'));
  assert.ok(edge.includes('model !== FREE_MODEL && !model.endsWith(":free")'));
  assert.ok(edge.includes('result?.cost !== 0'));
  assert.doesNotMatch(edge, /OPENROUTER_API_KEY/);
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

test('workspace AI permission migration uses the real private schema, not a nested public schema', () => {
  assert.match(workspaceAiMigration, /if not office_private\.is_active_member\(p_workspace_id\)/);
  assert.doesNotMatch(workspaceAiMigration, /public\.office_private/);
  assert.match(workspaceAiMigration, /grant execute on function public\.office_get_workspace_ai_enabled\(uuid\) to authenticated/i);
});
