import type { OfficeRecordsCiphertext } from './lib/officePrivateRecordsCrypto';
import type { NgoAction, NgoBootstrap, NgoDataResource, NgoFilter, NgoKeyConfigs, NgoMutationResult, NgoPage, NgoPrivateKind, NgoRow, NgoSaveResource } from './lib/officeNgoTypes';

export interface NgoWorkspaceContext {
  workspaceId: string;
  actorId: string;
  bootstrap: NgoBootstrap;
  busy: boolean;
  revision: number;
  feedback: string;
  summaryError: string;
  keyConfigs: NgoKeyConfigs;
  unlocked: Record<NgoPrivateKind, boolean>;
  load: (resource: NgoDataResource, filter?: NgoFilter, offset?: number) => Promise<NgoPage>;
  save: (resource: NgoSaveResource, data: NgoRow, existing?: NgoRow, recordId?: string) => Promise<NgoMutationResult>;
  transition: (resource: NgoSaveResource, row: NgoRow, toState: string, data?: NgoRow) => Promise<NgoMutationResult>;
  run: (action: NgoAction, payload: NgoRow) => Promise<NgoMutationResult>;
  unlock: (kind: NgoPrivateKind, passphrase: string) => Promise<void>;
  configureKey: (kind: NgoPrivateKind, passphrase: string) => Promise<void>;
  lock: () => void;
  seal: (kind: NgoPrivateKind, recordId: string, value: NgoRow) => Promise<OfficeRecordsCiphertext>;
  decrypt: (kind: NgoPrivateKind, row: NgoRow) => Promise<NgoRow>;
  notify: (message: string) => void;
}
export type NgoPanelProps = { context: NgoWorkspaceContext };
