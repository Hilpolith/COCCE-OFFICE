import type {
  HealthAdminAccessPurpose,
  HealthAdminAction,
  HealthAdminCapabilities,
  HealthAdminPage,
  HealthAdminRecord,
  HealthAdminResource,
  HealthAdminRole,
  HealthAdminResidencyAction,
  HealthAdminResidencyPayload,
  HealthAdminSettings,
} from "./lib/officeHealthAdminManagement";

export type HealthAdminPrivateScope =
  | "patient_identity"
  | "clinical"
  | "triage"
  | "diagnostic"
  | "pharmacy"
  | "inpatient"
  | "billing_claims"
  | "workforce_private"
  | "privacy_private";

export type HealthAdminPanelId =
  | "overview"
  | "patients"
  | "appointments"
  | "encounters"
  | "diagnostics"
  | "inpatient"
  | "pharmacy"
  | "billing"
  | "facilities"
  | "assets"
  | "privacy"
  | "reports";

export type HealthAdminIndexKind =
  | "facility_mrn"
  | "national_id"
  | "passport"
  | "phone";

export type HealthAdminKeyConfig = {
  configured: boolean;
  version?: number;
  salt?: string;
  nonce?: string;
  ciphertext?: string;
  index_key_nonce?: string;
  index_key_ciphertext?: string;
};

export type HealthAdminWorkspaceContext = {
  workspaceId: string;
  officeName: string;
  country: string;
  userId: string;
  role: HealthAdminRole;
  capabilities: HealthAdminCapabilities;
  storageReady: boolean;
  storageState: string;
  settings: HealthAdminSettings | null;
  keyConfig: HealthAdminKeyConfig;
  recordsKey: CryptoKey | null;
  indexKey: CryptoKey | null;
  busy: boolean;
  data: Partial<Record<HealthAdminResource, HealthAdminRecord[]>>;
  pages: Partial<Record<HealthAdminResource, HealthAdminPage>>;
  read(
    resource: HealthAdminResource,
    filter?: HealthAdminRecord,
    offset?: number,
    purpose?: HealthAdminAccessPurpose,
  ): Promise<HealthAdminPage<HealthAdminRecord> | null>;
  command(
    action: HealthAdminAction,
    payload: HealthAdminRecord,
  ): Promise<HealthAdminRecord>;
  residencyCommand(
    action: HealthAdminResidencyAction,
    payload: HealthAdminResidencyPayload,
  ): Promise<HealthAdminRecord>;
  sealPrivate<T extends Record<string, unknown>>(
    recordId: string,
    scope: HealthAdminPrivateScope,
    value: T,
  ): Promise<{ nonce: string; ciphertext: string }>;
  openPrivate<T extends Record<string, unknown>>(
    recordId: string,
    scope: HealthAdminPrivateScope,
    payload: { nonce: string; ciphertext: string },
  ): Promise<T>;
  makeBlindIndex(
    kind: HealthAdminIndexKind,
    value: string,
  ): Promise<{ index_type: HealthAdminIndexKind; digest: string }>;
  findPatient(
    kind: HealthAdminIndexKind,
    value: string,
    purpose: HealthAdminAccessPurpose,
  ): Promise<HealthAdminRecord[]>;
  auditExport(
    resource: HealthAdminResource,
    entityIds: string[],
    format: "csv" | "pdf" | "print",
    purpose: HealthAdminAccessPurpose,
  ): Promise<void>;
  refresh(): Promise<void>;
  lockPrivate(): void;
  setFeedback(message: string): void;
};

export type HealthAdminPanelProps = {
  context: HealthAdminWorkspaceContext;
};
