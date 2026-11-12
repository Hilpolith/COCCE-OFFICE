import type { SupabaseClient } from '@supabase/supabase-js';
import type { OfficeLocalTimestamp, OfficePresenceStatus } from './officePersonStatus';

type RpcClient = SupabaseClient;

export type OfficeSuiteId = 'government' | 'school' | 'university' | 'business' | 'accounting' | 'manufacturing' | 'healthcare-admin' | 'ngo' | 'hospitality' | 'church';
export type OfficeWorkspace = { workspace_id: string; name: string; role: 'owner' | 'admin' | 'member'; created_at: string };
export type OfficeWorkspaceSuite = { workspace_id: string; suite_id: OfficeSuiteId | null; created_at: string };
export type OfficeUser = { user_id: string; username: string | null; display_name: string | null; avatar_url: string | null; is_vip: boolean | null; vip_expires_at: OfficeLocalTimestamp | null };
export type OfficeMember = OfficeUser & { role: 'owner' | 'admin' | 'member'; status: 'active' | 'suspended'; joined_at: string; job_title?: string };
export type OfficeSearchResult = OfficeUser & { membership_status: 'active' | 'suspended' | null; invitation_status: 'pending' | null; presence_status: OfficePresenceStatus; last_seen_at: string | null };
export type OfficeInvitation = { invitation_id: string; workspace_id: string; workspace_name: string; inviter_id: string; inviter_name: string; inviter_avatar_url: string | null; inviter_is_vip: boolean | null; inviter_vip_expires_at: OfficeLocalTimestamp | null; inviter_presence_status: OfficePresenceStatus | null; inviter_last_seen_at: string | null; role: 'admin' | 'member'; created_at: string; expires_at: string };
export type OfficeWorkspaceInvitation = { invitation_id: string; invitee_id: string; username: string | null; display_name: string | null; avatar_url: string | null; is_vip: boolean | null; vip_expires_at: OfficeLocalTimestamp | null; presence_status: OfficePresenceStatus | null; last_seen_at: string | null; role: 'admin' | 'member'; created_at: string; expires_at: string };
export type OfficeStory = { story_id: string; workspace_id: string; author_id: string; author_name: string; author_avatar_url: string | null; caption: string; media_file_id: string | null; media_type: 'text' | 'image' | 'video'; media_content_type: string; created_at: string; expires_at: string; view_count: number; viewed_by_me: boolean };
export type OfficeConversation = { conversation_id: string; kind: 'channel' | 'direct' | 'group'; title: string; last_message_at: string; direct_user_id: string | null; direct_user_username: string | null; direct_user_display_name: string | null; direct_user_avatar_url: string | null; direct_user_is_vip: boolean | null; direct_user_vip_expires_at: OfficeLocalTimestamp | null; direct_user_presence_status: OfficePresenceStatus | null; direct_user_last_seen_at: string | null };
export type OfficeMessage = { message_id: string; author_id: string; author_name: string; author_avatar_url: string | null; author_is_vip: boolean | null; author_vip_expires_at: OfficeLocalTimestamp | null; author_presence_status: OfficePresenceStatus | null; author_last_seen_at: string | null; body: string; created_at: string };
export type OfficeChatAttachment = { fileId: string; name: string; sizeBytes: number; mimeType: string };
export type OfficeRichMessage = OfficeMessage & { workspace_id: string; conversation_id: string; edited_at: string | null; message_type: 'text' | 'image' | 'video' | 'audio' | 'document' | 'mixed'; attachments: OfficeChatAttachment[]; reply_to_message_id: string | null; reply_body: string | null; reply_author_name: string | null; deleted_at: string | null };
export type OfficeConversationRead = { user_id: string; display_name: string; avatar_url: string | null; last_read_message_id: string | null; last_read_at: string };
export type OfficeNotification = { notification_id: string; workspace_id: string; kind: string; actor_id: string | null; actor_name: string | null; actor_avatar_url: string | null; actor_is_vip: boolean | null; actor_vip_expires_at: OfficeLocalTimestamp | null; actor_presence_status: OfficePresenceStatus | null; actor_last_seen_at: string | null; payload: Record<string, unknown>; created_at: string; read_at: string | null };
export type OfficePresence = OfficeUser & { status: OfficePresenceStatus | null; last_seen_at: string | null };

async function rpc<T>(client: RpcClient, name: string, params?: Record<string, unknown>): Promise<T> {
  const { data, error } = await client.rpc(name, params);
  if (error) throw new Error(error.message);
  return data as T;
}

export const officeTeamApi = {
  listWorkspaces: (client: RpcClient) => rpc<OfficeWorkspace[]>(client, 'office_list_workspaces'),
  createWorkspace: (client: RpcClient, name: string, description = '') => rpc<string>(client, 'office_create_workspace', { p_name: name, p_description: description }),
  createWorkspaceWithSuite: (client: RpcClient, name: string, description: string, suiteId: OfficeSuiteId) => rpc<string>(client, 'office_create_workspace_with_suite', { p_name: name, p_description: description, p_suite_id: suiteId }),
  listWorkspaceSuites: (client: RpcClient) => rpc<OfficeWorkspaceSuite[]>(client, 'office_list_workspace_suites'),
  setWorkspaceSuite: (client: RpcClient, workspaceId: string, suiteId: OfficeSuiteId) => rpc<void>(client, 'office_set_workspace_suite', { p_workspace_id: workspaceId, p_suite_id: suiteId }),
  listMyInvitations: (client: RpcClient) => rpc<OfficeInvitation[]>(client, 'office_list_my_invitations'),
  respondInvitation: (client: RpcClient, invitationId: string, accept: boolean) => rpc<void>(client, 'office_respond_invitation', { p_invitation_id: invitationId, p_accept: accept }),
  listMembers: async (client: RpcClient, workspaceId: string) => {
    const [members, titles] = await Promise.all([
      rpc<OfficeMember[]>(client, 'office_list_members', { p_workspace_id: workspaceId }),
      rpc<Array<{ user_id: string; job_title: string }>>(client, 'office_list_member_titles', { p_workspace_id: workspaceId }),
    ]);
    const titleByUser = new Map(titles.map((item) => [item.user_id, item.job_title]));
    return members.map((member) => ({ ...member, job_title: titleByUser.get(member.user_id) ?? '' }));
  },
  setMemberTitle: (client: RpcClient, workspaceId: string, userId: string, jobTitle: string) => rpc<void>(client, 'office_set_member_title', { p_workspace_id: workspaceId, p_user_id: userId, p_job_title: jobTitle }),
  getWorkspaceAiEnabled: (client: RpcClient, workspaceId: string) => rpc<boolean>(client, 'office_get_workspace_ai_enabled', { p_workspace_id: workspaceId }),
  setWorkspaceAiEnabled: (client: RpcClient, workspaceId: string, enabled: boolean) => rpc<void>(client, 'office_set_workspace_ai_enabled', { p_workspace_id: workspaceId, p_enabled: enabled }),
  searchUsers: (client: RpcClient, workspaceId: string, query: string) => rpc<OfficeSearchResult[]>(client, 'office_search_users', { p_workspace_id: workspaceId, p_query: query }),
  createInvitation: (client: RpcClient, workspaceId: string, userId: string, role: 'admin' | 'member', jobTitle = '') => rpc<string>(client, 'office_create_invitation', { p_workspace_id: workspaceId, p_invitee_id: userId, p_role: role, p_job_title: jobTitle }),
  listWorkspaceInvitations: (client: RpcClient, workspaceId: string) => rpc<OfficeWorkspaceInvitation[]>(client, 'office_list_workspace_invitations', { p_workspace_id: workspaceId }),
  cancelInvitation: (client: RpcClient, invitationId: string) => rpc<void>(client, 'office_cancel_invitation', { p_invitation_id: invitationId }),
  manageMember: (client: RpcClient, workspaceId: string, userId: string, action: 'role' | 'suspend' | 'restore' | 'remove', role?: 'admin' | 'member') => rpc<void>(client, 'office_manage_member', { p_workspace_id: workspaceId, p_user_id: userId, p_action: action, p_role: role ?? null }),
  transferOwnership: (client: RpcClient, workspaceId: string, userId: string) => rpc<void>(client, 'office_transfer_ownership', { p_workspace_id: workspaceId, p_new_owner_id: userId }),
  listConversations: (client: RpcClient, workspaceId: string) => rpc<OfficeConversation[]>(client, 'office_list_conversations', { p_workspace_id: workspaceId }),
  listStories: (client: RpcClient, workspaceId: string) => rpc<OfficeStory[]>(client, 'office_list_stories', { p_workspace_id: workspaceId }),
  createStory: (client: RpcClient, workspaceId: string, caption: string, mediaFileId: string | null, mediaType: OfficeStory['media_type'], mediaContentType: string) => rpc<string>(client, 'office_create_story', { p_workspace_id: workspaceId, p_caption: caption, p_media_file_id: mediaFileId, p_media_type: mediaType, p_media_content_type: mediaContentType }),
  markStoryViewed: (client: RpcClient, storyId: string) => rpc<void>(client, 'office_mark_story_viewed', { p_story_id: storyId }),
  deleteStory: (client: RpcClient, storyId: string) => rpc<void>(client, 'office_delete_story', { p_story_id: storyId }),
  createConversation: (client: RpcClient, workspaceId: string, kind: 'direct' | 'group' | 'channel', memberIds: string[], title: string | null) => rpc<string>(client, 'office_create_conversation', { p_workspace_id: workspaceId, p_kind: kind, p_member_ids: memberIds, p_title: title }),
  listMessages: (client: RpcClient, conversationId: string, limit = 60) => rpc<OfficeMessage[]>(client, 'office_list_messages', { p_conversation_id: conversationId, p_limit: limit }),
  sendMessage: (client: RpcClient, conversationId: string, body: string) => rpc<string>(client, 'office_send_message', { p_conversation_id: conversationId, p_body: body }),
  listRichMessages: (client: RpcClient, conversationId: string, limit = 60) => rpc<OfficeRichMessage[]>(client, 'office_list_rich_messages', { p_conversation_id: conversationId, p_limit: limit }),
  sendRichMessage: (client: RpcClient, conversationId: string, body: string, messageType: OfficeRichMessage['message_type'], attachments: OfficeChatAttachment[] = [], replyToMessageId: string | null = null) => rpc<string>(client, 'office_send_rich_message', { p_conversation_id: conversationId, p_body: body, p_message_type: messageType, p_attachments: attachments, p_reply_to_message_id: replyToMessageId }),
  editMessage: (client: RpcClient, messageId: string, body: string) => rpc<void>(client, 'office_edit_message', { p_message_id: messageId, p_body: body }),
  deleteMessage: (client: RpcClient, messageId: string) => rpc<void>(client, 'office_delete_message', { p_message_id: messageId }),
  markConversationRead: (client: RpcClient, conversationId: string) => rpc<void>(client, 'office_mark_conversation_read', { p_conversation_id: conversationId }),
  listConversationReads: (client: RpcClient, conversationId: string) => rpc<OfficeConversationRead[]>(client, 'office_list_conversation_reads', { p_conversation_id: conversationId }),
  listNotifications: (client: RpcClient, limit = 30) => rpc<OfficeNotification[]>(client, 'office_list_notifications', { p_limit: limit }),
  markNotificationRead: (client: RpcClient, notificationId: string) => rpc<void>(client, 'office_mark_notification_read', { p_notification_id: notificationId }),
  listPresence: (client: RpcClient, workspaceId: string) => rpc<OfficePresence[]>(client, 'office_list_presence', { p_workspace_id: workspaceId }),
  touchPresence: (client: RpcClient, workspaceId: string, status: 'online' | 'away' | 'offline' = 'online') => rpc<void>(client, 'office_touch_presence', { p_workspace_id: workspaceId, p_status: status }),
};
