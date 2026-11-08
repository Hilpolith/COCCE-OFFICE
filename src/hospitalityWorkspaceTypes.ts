import type { OfficeRecordsCiphertext } from './lib/officePrivateRecordsCrypto';
import type { HospitalityAction, HospitalityBootstrap, HospitalityDataResource, HospitalityFilter, HospitalityKeyConfigs, HospitalityMutationResult, HospitalityPage, HospitalityPrivateKind, HospitalityRow, HospitalitySaveResource } from './lib/officeHospitalityTypes';
export interface HospitalityWorkspaceContext {
  workspaceId: string;
  actorId: string;
  bootstrap: HospitalityBootstrap;
  busy: boolean;
  revision: number;
  feedback: string;
  keyConfigs: HospitalityKeyConfigs;
  unlocked: Record<HospitalityPrivateKind, boolean>;
  load: (resource: HospitalityDataResource, filter?: HospitalityFilter, offset?: number) => Promise<HospitalityPage>;
  save: (resource: HospitalitySaveResource, data: HospitalityRow, existing?: HospitalityRow, recordId?: string) => Promise<HospitalityMutationResult>;
  transition: (resource: HospitalitySaveResource, row: HospitalityRow, toState: string, data?: HospitalityRow) => Promise<HospitalityMutationResult>;
  run: (action: HospitalityAction, payload: HospitalityRow) => Promise<HospitalityMutationResult>;
  unlock: (kind: HospitalityPrivateKind, passphrase: string) => Promise<void>;
  configureKey: (kind: HospitalityPrivateKind, passphrase: string) => Promise<void>;
  lock: () => void;
  seal: (kind: HospitalityPrivateKind, recordId: string, value: HospitalityRow) => Promise<OfficeRecordsCiphertext>;
  decrypt: (kind: HospitalityPrivateKind, row: HospitalityRow) => Promise<HospitalityRow>;
  notify: (message: string) => void;
}
export type HospitalityPanelProps = { context: HospitalityWorkspaceContext };
