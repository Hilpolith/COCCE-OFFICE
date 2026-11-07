import type { ReactNode } from "react";
import type { OfficeMember } from "./officeTeamApi";
import type {
  BusinessAction,
  BusinessCapabilities,
  BusinessCommandResult,
  BusinessRecord,
  BusinessResource,
  BusinessRole,
} from "./officeBusinessManagement";
export type BusinessTab =
  | "overview"
  | "crm"
  | "sales"
  | "receivables"
  | "procurement"
  | "projects"
  | "compliance"
  | "settings";
export type BusinessCommand = (
  action: BusinessAction,
  payload: BusinessRecord,
  success?: string,
) => Promise<BusinessCommandResult | null>;
export type BusinessReadRows = (
  resource: BusinessResource,
  filter?: BusinessRecord,
  limit?: number,
  offset?: number,
) => Promise<BusinessRecord[]>;
export interface BusinessWorkspacePanelsProps {
  tab: BusinessTab;
  data: Partial<Record<BusinessResource, BusinessRecord[]>>;
  capabilities: BusinessCapabilities;
  role: BusinessRole;
  settings: BusinessRecord | null;
  members: OfficeMember[];
  busy: boolean;
  hasMore: Partial<Record<BusinessResource, boolean>>;
  loadingMore: Partial<Record<BusinessResource, boolean>>;
  loadMore: (resource: BusinessResource) => Promise<void>;
  readRows: BusinessReadRows;
  command: BusinessCommand;
  reportError: (message: string) => void;
  privateContacts: ReactNode;
  onNavigate: (tab: BusinessTab) => void;
  officeName: string;
}
