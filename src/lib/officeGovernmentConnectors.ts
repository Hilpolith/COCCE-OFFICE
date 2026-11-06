import type { SupabaseClient } from '@supabase/supabase-js';
import type { OfficeTeamConfigState } from './officeTeamSupabase';

export type GovernmentConnectorState = 'not_configured' | 'ready' | 'needs_attention';
export type GovernmentConnectorName = 'graph' | 'cmis';

export type GovernmentConnectorStatus = {
  graph: {
    state: GovernmentConnectorState;
    lastCheckedAt: string | null;
    errorCode: string | null;
    configured: boolean;
    senderConfigured: boolean;
  };
  cmis: {
    state: GovernmentConnectorState;
    lastCheckedAt: string | null;
    errorCode: string | null;
    configured: boolean;
    binding: 'browser' | null;
    repositoryConfigured: boolean;
    folderConfigured: boolean;
  };
};

export type GraphConnectorSetup = {
  tenantId: string;
  clientId: string;
  clientSecret: string;
  senderMailbox: string;
};

export type CmisConnectorSetup = {
  bindingUrl: string;
  repositoryId: string;
  folderId: string;
  authMode: 'bearer' | 'basic';
  bearerToken?: string;
  username?: string;
  password?: string;
};

export type GovernmentConnectorResult = {
  status: 'accepted' | 'archived' | 'failed' | 'unknown';
  attemptId: string;
  httpStatus?: number | null;
  providerObjectId?: string;
  deliveryVerified?: false;
  errorCode?: string;
};

export type GovernmentSendRequest = {
  workspaceId: string;
  correspondenceId: string;
  expectedRecordVersion: number;
  recipient: string;
  subject: string;
  body: string;
  attachmentIds: string[];
  idempotencyKey: string;
  nonSensitiveConfirmed: true;
};

export type GovernmentArchiveRequest = {
  workspaceId: string;
  attachmentId: string;
  idempotencyKey: string;
};

type Fetcher = typeof fetch;
type RpcClient = SupabaseClient;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const STATE_VALUES: GovernmentConnectorState[] = ['not_configured', 'ready', 'needs_attention'];

export class GovernmentConnectorError extends Error {
  readonly code: string;
  readonly status?: number;

  constructor(code: string, message: string, status?: number) {
    super(message);
    this.name = 'GovernmentConnectorError';
    this.code = code;
    this.status = status;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

async function readJson(response: Response): Promise<unknown> {
  try { return await response.json(); } catch { return null; }
}

function safeError(value: unknown, status: number): GovernmentConnectorError {
  if (isRecord(value) && typeof value.error === 'string' && typeof value.message === 'string') {
    const code = /^[A-Z0-9_]{1,48}$/.test(value.error) ? value.error : 'CONNECTOR_FAILED';
    return new GovernmentConnectorError(code, value.message.slice(0, 300), status);
  }
  if (status === 401) return new GovernmentConnectorError('AUTH_REQUIRED', 'Sign in again to continue.', status);
  if (status === 403) return new GovernmentConnectorError('ACCESS_DENIED', 'This Government workspace role cannot run that connector.', status);
  if (status === 503) return new GovernmentConnectorError('CONNECTOR_NOT_CONFIGURED', 'The Government connector is not configured on the secure server yet.', status);
  return new GovernmentConnectorError('CONNECTOR_UNAVAILABLE', 'The Government connector could not complete the request. Check its attempt history before trying again.', status);
}

function safeTimestamp(value: unknown): string | null {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value)) ? value : null;
}

function safeCode(value: unknown): string | null {
  return typeof value === 'string' && /^[A-Z0-9_]{1,48}$/.test(value) ? value : null;
}

function parseState(value: unknown, fallback: GovernmentConnectorState): GovernmentConnectorState {
  return typeof value === 'string' && STATE_VALUES.includes(value as GovernmentConnectorState) ? value as GovernmentConnectorState : fallback;
}

function parseStatus(result: Record<string, unknown>): GovernmentConnectorStatus {
  if (!isRecord(result.graph) || !isRecord(result.cmis)) throw new GovernmentConnectorError('CONNECTOR_RESPONSE_INVALID', 'The Government connector status is incomplete.');
  const graph = result.graph;
  const cmis = result.cmis;
  const cmisBinding = cmis.binding;
  if ((cmisBinding !== undefined && cmisBinding !== null && cmisBinding !== 'browser') ||
      (graph.state !== undefined && !STATE_VALUES.includes(graph.state as GovernmentConnectorState)) ||
      (cmis.state !== undefined && !STATE_VALUES.includes(cmis.state as GovernmentConnectorState))) {
    throw new GovernmentConnectorError('CONNECTOR_RESPONSE_INVALID', 'The Government connector status is incomplete.');
  }
  const graphState = parseState(graph.state, graph.configured === true && graph.senderConfigured === true ? 'ready' : 'not_configured');
  const cmisState = parseState(cmis.state, cmis.configured === true && cmis.repositoryConfigured === true && cmis.folderConfigured === true ? 'ready' : 'not_configured');
  return {
    graph: {
      state: graphState,
      lastCheckedAt: safeTimestamp(graph.lastCheckedAt), errorCode: safeCode(graph.errorCode),
      configured: graph.configured === true || graphState === 'ready', senderConfigured: graph.senderConfigured === true || graphState === 'ready',
    },
    cmis: {
      state: cmisState,
      lastCheckedAt: safeTimestamp(cmis.lastCheckedAt), errorCode: safeCode(cmis.errorCode),
      configured: cmis.configured === true || cmisState === 'ready', binding: (cmisBinding ?? (cmisState === 'ready' ? 'browser' : null)) as 'browser' | null,
      repositoryConfigured: cmis.repositoryConfigured === true || cmisState === 'ready', folderConfigured: cmis.folderConfigured === true || cmisState === 'ready',
    },
  };
}

export function createOfficeGovernmentConnectorApi(client: RpcClient, config: OfficeTeamConfigState, fetchImpl: Fetcher = fetch) {
  if (config.status !== 'ready') throw new GovernmentConnectorError('OFFICE_CONFIG_UNAVAILABLE', 'Office Team configuration is unavailable.');
  const readyConfig = config;

  async function request(path: string, method: 'GET' | 'POST', body?: Record<string, unknown>): Promise<Record<string, unknown>> {
    const sessionResult = await client.auth.getSession();
    const session = sessionResult.data?.session;
    if (sessionResult.error || !session?.access_token) throw new GovernmentConnectorError('AUTH_REQUIRED', 'Sign in again to continue.', 401);
    const query = method === 'GET' && body ? `?${new URLSearchParams(Object.entries(body).map(([key, value]) => [key, String(value)]))}` : '';
    let response: Response;
    try {
      response = await fetchImpl(`${readyConfig.url}/functions/v1/office-government-connectors${path}${query}`, {
        method, headers: { apikey: readyConfig.anonKey, Authorization: `Bearer ${session.access_token}`, Accept: 'application/json', ...(method === 'POST' ? { 'Content-Type': 'application/json' } : {}) },
        ...(method === 'POST' ? { body: JSON.stringify(body ?? {}) } : {}), cache: 'no-store', credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer',
      });
    } catch { throw new GovernmentConnectorError('CONNECTOR_UNAVAILABLE', 'The Government connector could not be reached. Check its attempt history before retrying.'); }
    const result = await readJson(response);
    if (!response.ok) throw safeError(result, response.status);
    if (!isRecord(result)) throw new GovernmentConnectorError('CONNECTOR_RESPONSE_INVALID', 'The Government connector returned an invalid response.');
    return result;
  }

  const status = async (workspaceId: string): Promise<GovernmentConnectorStatus> => {
    if (!UUID_RE.test(workspaceId)) throw new GovernmentConnectorError('INVALID_WORKSPACE', 'The Government workspace ID is invalid.');
    return parseStatus(await request('/status', 'GET', { workspaceId }));
  };
  const checkStatus = async (workspaceId: string): Promise<GovernmentConnectorStatus> => {
    if (!UUID_RE.test(workspaceId)) throw new GovernmentConnectorError('INVALID_WORKSPACE', 'The Government workspace ID is invalid.');
    return parseStatus(await request('/connections/check', 'POST', { workspaceId }));
  };

  const setup = async (path: string, workspaceId: string, values: Record<string, unknown>) => {
    if (!UUID_RE.test(workspaceId)) throw new GovernmentConnectorError('INVALID_WORKSPACE', 'The Government workspace ID is invalid.');
    // Setup values exist only in this POST body and are never persisted or copied into a response.
    return parseStatus(await request(path, 'POST', { workspaceId, ...values }));
  };

  return {
    status,
    checkStatus,
    configureGraph: (workspaceId: string, values: GraphConnectorSetup) => setup('/connections/graph/test-and-save', workspaceId, {
      tenantId: values.tenantId, clientId: values.clientId, clientSecret: values.clientSecret, senderUpn: values.senderMailbox,
    }),
    configureCmis: (workspaceId: string, values: CmisConnectorSetup) => setup('/connections/cmis/test-and-save', workspaceId, {
      serviceUrl: values.bindingUrl, repositoryId: values.repositoryId, folderId: values.folderId, authMode: values.authMode,
      bearerToken: values.authMode === 'bearer' ? values.bearerToken ?? '' : '',
      username: values.authMode === 'basic' ? values.username ?? '' : '',
      password: values.authMode === 'basic' ? values.password ?? '' : '',
    }),
    disconnect: async (workspaceId: string, connector: GovernmentConnectorName) => {
      if (!['graph', 'cmis'].includes(connector)) throw new GovernmentConnectorError('INVALID_CONNECTOR', 'The connector name is invalid.');
      return parseStatus(await request('/connections/disconnect', 'POST', { workspaceId, provider: connector }));
    },
    async sendMail(input: GovernmentSendRequest): Promise<GovernmentConnectorResult> {
      if (!UUID_RE.test(input.workspaceId) || !UUID_RE.test(input.correspondenceId) || !UUID_RE.test(input.idempotencyKey) || !Number.isSafeInteger(input.expectedRecordVersion) || input.expectedRecordVersion < 1 || !input.nonSensitiveConfirmed || !Array.isArray(input.attachmentIds) || input.attachmentIds.length > 3 || input.attachmentIds.some((id) => !UUID_RE.test(id))) throw new GovernmentConnectorError('INVALID_OUTBOUND_REQUEST', 'Complete the non-sensitive confirmation and check the selected record and attachments.');
      return parseResult(await request('/outbound/send', 'POST', input as unknown as Record<string, unknown>), 'accepted');
    },
    async archiveFile(input: GovernmentArchiveRequest): Promise<GovernmentConnectorResult> {
      if (!UUID_RE.test(input.workspaceId) || !UUID_RE.test(input.attachmentId) || !UUID_RE.test(input.idempotencyKey)) throw new GovernmentConnectorError('INVALID_ARCHIVE_REQUEST', 'The Government archive request is invalid.');
      return parseResult(await request('/archive/file', 'POST', input as unknown as Record<string, unknown>), 'archived');
    },
  };
}

function parseResult(value: Record<string, unknown>, success: 'accepted' | 'archived'): GovernmentConnectorResult {
  if (typeof value.attemptId !== 'string' || !UUID_RE.test(value.attemptId) || !['accepted', 'archived', 'failed', 'unknown'].includes(String(value.status))) throw new GovernmentConnectorError('CONNECTOR_RESPONSE_INVALID', 'The Government connector returned an invalid attempt result.');
  if (value.status === 'accepted' && (success !== 'accepted' || value.deliveryVerified !== false)) throw new GovernmentConnectorError('CONNECTOR_RESPONSE_INVALID', 'The outbound response did not preserve the delivery-unverified warning.');
  if (value.status === 'archived' && success !== 'archived') throw new GovernmentConnectorError('CONNECTOR_RESPONSE_INVALID', 'The archive connector returned an unexpected result.');
  return { status: value.status as GovernmentConnectorResult['status'], attemptId: value.attemptId, ...(Number.isInteger(value.httpStatus) ? { httpStatus: value.httpStatus as number } : {}), ...(typeof value.providerObjectId === 'string' ? { providerObjectId: value.providerObjectId.slice(0, 256) } : {}), ...(value.deliveryVerified === false ? { deliveryVerified: false as const } : {}), ...(typeof value.errorCode === 'string' ? { errorCode: value.errorCode.slice(0, 48) } : {}) };
}
