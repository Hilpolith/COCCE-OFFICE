import type { SupabaseClient } from '@supabase/supabase-js';
import type { OfficeLocalTimestamp, OfficePresenceStatus } from './officePersonStatus';

type RpcClient = SupabaseClient;

export type OfficeWorkspace = { workspace_id: string; name: string; role: 'owner' | 'admin' | 'member'; created_at: string };
export type OfficeUser = { user_id: string; username: string | null; display_name: string | null; avatar_url: string | null; is_vip: boolean | null; vip_expires_at: OfficeLocalTimestamp | null };
export type OfficeMember = OfficeUser & { role: 'owner' | 'admin' | 'member'; status: 'active' | 'suspended'; joined_at: string; job_title?: string };
export type OfficeSearchResult = OfficeUser & { membership_status: 'active' | 'suspended' | null; invitation_status: 'pending' | null; presence_status: OfficePresenceStatus; last_seen_at: string | null };
export type OfficeInvitation = { invitation_id: string; workspace_id: string; workspace_name: string; inviter_id: string; inviter_name: string; inviter_avatar_url: string | null; inviter_is_vip: boolean | null; inviter_vip_expires_at: OfficeLocalTimestamp | null; inviter_presence_status: OfficePresenceStatus | null; inviter_last_seen_at: string | null; role: 'admin' | 'member'; created_at: string; expires_at: string };
export type OfficeWorkspaceInvitation = { invitation_id: string; invitee_id: string; username: string | null; display_name: string | null; avatar_url: string | null; is_vip: boolean | null; vip_expires_at: OfficeLocalTimestamp | null; presence_status: OfficePresenceStatus | null; last_seen_at: string | null; role: 'admin' | 'member'; created_at: string; expires_at: string };
export type OfficeConversation = { conversation_id: string; kind: 'channel' | 'direct' | 'group'; title: string; last_message_at: string; direct_user_id: string | null; direct_user_username: string | null; direct_user_display_name: string | null; direct_user_avatar_url: string | null; direct_user_is_vip: boolean | null; direct_user_vip_expires_at: OfficeLocalTimestamp | null; direct_user_presence_status: OfficePresenceStatus | null; direct_user_last_seen_at: string | null };
export type OfficeMessage = { message_id: string; author_id: string; author_name: string; author_avatar_url: string | null; author_is_vip: boolean | null; author_vip_expires_at: OfficeLocalTimestamp | null; author_presence_status: OfficePresenceStatus | null; author_last_seen_at: string | null; body: string; created_at: string };
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
  searchUsers: (client: RpcClient, workspaceId: string, query: string) => rpc<OfficeSearchResult[]>(client, 'office_search_users', { p_workspace_id: workspaceId, p_query: query }),
  createInvitation: (client: RpcClient, workspaceId: string, userId: string, role: 'admin' | 'member') => rpc<string>(client, 'office_create_invitation', { p_workspace_id: workspaceId, p_invitee_id: userId, p_role: role }),
  listWorkspaceInvitations: (client: RpcClient, workspaceId: string) => rpc<OfficeWorkspaceInvitation[]>(client, 'office_list_workspace_invitations', { p_workspace_id: workspaceId }),
  cancelInvitation: (client: RpcClient, invitationId: string) => rpc<void>(client, 'office_cancel_invitation', { p_invitation_id: invitationId }),
  manageMember: (client: RpcClient, workspaceId: string, userId: string, action: 'role' | 'suspend' | 'restore' | 'remove', role?: 'admin' | 'member') => rpc<void>(client, 'office_manage_member', { p_workspace_id: workspaceId, p_user_id: userId, p_action: action, p_role: role ?? null }),
  transferOwnership: (client: RpcClient, workspaceId: string, userId: string) => rpc<void>(client, 'office_transfer_ownership', { p_workspace_id: workspaceId, p_new_owner_id: userId }),
  listConversations: (client: RpcClient, workspaceId: string) => rpc<OfficeConversation[]>(client, 'office_list_conversations', { p_workspace_id: workspaceId }),
  createConversation: (client: RpcClient, workspaceId: string, kind: 'direct' | 'group' | 'channel', memberIds: string[], title: string | null) => rpc<string>(client, 'office_create_conversation', { p_workspace_id: workspaceId, p_kind: kind, p_member_ids: memberIds, p_title: title }),
  listMessages: (client: RpcClient, conversationId: string, limit = 60) => rpc<OfficeMessage[]>(client, 'office_list_messages', { p_conversation_id: conversationId, p_limit: limit }),
  sendMessage: (client: RpcClient, conversationId: string, body: string) => rpc<string>(client, 'office_send_message', { p_conversation_id: conversationId, p_body: body }),
  listNotifications: (client: RpcClient, limit = 30) => rpc<OfficeNotification[]>(client, 'office_list_notifications', { p_limit: limit }),
  markNotificationRead: (client: RpcClient, notificationId: string) => rpc<void>(client, 'office_mark_notification_read', { p_notification_id: notificationId }),
  listPresence: (client: RpcClient, workspaceId: string) => rpc<OfficePresence[]>(client, 'office_list_presence', { p_workspace_id: workspaceId }),
  touchPresence: (client: RpcClient, workspaceId: string, status: 'online' | 'away' | 'offline' = 'online') => rpc<void>(client, 'office_touch_presence', { p_workspace_id: workspaceId, p_status: status }),
};
