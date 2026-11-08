import type { OfficeRecordsCiphertext } from './lib/officePrivateRecordsCrypto';
import type { InstitutionsAction,InstitutionsBootstrap,InstitutionsDataResource,InstitutionsFilter,InstitutionsKeyConfigs,InstitutionsMutationResult,InstitutionsPage,InstitutionsPrivateKind,InstitutionsRow,InstitutionsSaveResource } from './lib/officeInstitutionsTypes';
export interface InstitutionsWorkspaceContext {
 workspaceId:string;actorId:string;bootstrap:InstitutionsBootstrap;busy:boolean;revision:number;feedback:string;keyConfigs:InstitutionsKeyConfigs;unlocked:Record<InstitutionsPrivateKind,boolean>;
 load:(resource:InstitutionsDataResource,filter?:InstitutionsFilter,offset?:number)=>Promise<InstitutionsPage>;
 save:(resource:InstitutionsSaveResource,data:InstitutionsRow,existing?:InstitutionsRow,recordId?:string)=>Promise<InstitutionsMutationResult>;
 transition:(resource:InstitutionsSaveResource,row:InstitutionsRow,toState:string,data?:InstitutionsRow)=>Promise<InstitutionsMutationResult>;
 run:(action:InstitutionsAction,payload:InstitutionsRow)=>Promise<InstitutionsMutationResult>;
 unlock:(kind:InstitutionsPrivateKind,passphrase:string)=>Promise<void>;
 configureKey:(kind:InstitutionsPrivateKind,passphrase:string)=>Promise<void>;
 lock:()=>void;
 seal:(kind:InstitutionsPrivateKind,resource:'people'|'attendance'|'safeguarding',recordId:string,value:InstitutionsRow)=>Promise<OfficeRecordsCiphertext>;
 decrypt:(kind:InstitutionsPrivateKind,resource:'people'|'attendance'|'safeguarding',row:InstitutionsRow)=>Promise<InstitutionsRow>;
 notify:(message:string)=>void;
}
export type InstitutionsPanelProps={context:InstitutionsWorkspaceContext};
