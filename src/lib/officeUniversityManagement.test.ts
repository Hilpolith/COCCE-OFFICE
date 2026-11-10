// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import {
  createUniversityKeyConfig,
  decryptUniversityPrivatePerson,
  encryptUniversityPrivatePerson,
  officeUniversityManagementApi,
  unlockUniversityKey,
} from "./officeUniversityManagement";
import type {
  UniversityPrivatePersonRecord,
  UniversityRpcClient,
} from "./officeUniversityManagement";
const person: UniversityPrivatePersonRecord = {
  legal_name: "Synthetic Applicant",
  preferred_name: "Applicant",
  date_of_birth: "2000-01-02",
  email: "applicant@example.test",
  phone: "+255000000000",
  national_reference: "REF-TEST",
};
function mock(rpc: ReturnType<typeof vi.fn>) {
  return { rpc } as unknown as UniversityRpcClient;
}
describe("University Management adapter and crypto", () => {
  it("round-trips encrypted identity and rejects wrong passphrase", async () => {
    const x = await createUniversityKeyConfig("university test passphrase");
    const c = await encryptUniversityPrivatePerson(x.key, person);
    expect(JSON.stringify(c)).not.toContain("Synthetic Applicant");
    await expect(decryptUniversityPrivatePerson(x.key, c)).resolves.toEqual(
      person,
    );
    await expect(
      unlockUniversityKey("wrong passphrase", {
        configured: true,
        iterations: 600000,
        ...x.payload,
      }),
    ).rejects.toThrow(/did not unlock/i);
  });
  it("enforces passphrase and identity validation", async () => {
    await expect(createUniversityKeyConfig("short")).rejects.toThrow(
      /12 and 256/i,
    );
    const { key } = await createUniversityKeyConfig(
      "university test passphrase",
    );
    await expect(
      encryptUniversityPrivatePerson(key, { ...person, legal_name: "" }),
    ).rejects.toThrow(/Legal name/i);
    await expect(
      encryptUniversityPrivatePerson(key, { ...person, date_of_birth: "bad" }),
    ).rejects.toThrow(/YYYY-MM-DD/i);
  });
  it("reads full-scope role-authorized KPI counts through the dedicated summary RPC", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: { terms_count: 2, students_count: 7 }, error: null });
    await expect(officeUniversityManagementApi.summary(mock(rpc), "ws-1")).resolves.toEqual({ terms_count: 2, students_count: 7 });
    expect(rpc).toHaveBeenCalledWith("office_university_summary", { p_workspace_id: "ws-1" });
  });
    it("uses University RPC names and bounds/paginates reads", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: [], error: null });
    const c = mock(rpc);
    await officeUniversityManagementApi.read(c, "ws-1", "students", {}, 999, 4);
    await officeUniversityManagementApi.command(c, "ws-1", "lock_results", {
      expected_version: 2,
    });
    expect(rpc).toHaveBeenNthCalledWith(1, "office_university_read", {
      p_workspace_id: "ws-1",
      p_resource: "students",
      p_filter: {},
      p_limit: 200,
      p_offset: 4,
    });
    expect(rpc).toHaveBeenNthCalledWith(2, "office_university_command", {
      p_workspace_id: "ws-1",
      p_action: "lock_results",
      p_payload: { expected_version: 2 },
    });
  });
});

describe('University security edge cases', () => {
  it('rejects impossible dates and tampered ciphertext', async () => {
    const x = await createUniversityKeyConfig('university test passphrase');
    await expect(encryptUniversityPrivatePerson(x.key, {...person,date_of_birth:'2026-02-30'})).rejects.toThrow(/calendar date/i);
    const cipher = await encryptUniversityPrivatePerson(x.key,person);
    const bytes = Buffer.from(cipher.ciphertext,'base64'); bytes[0] ^= 1;
    await expect(decryptUniversityPrivatePerson(x.key,{...cipher,ciphertext:bytes.toString('base64')})).rejects.toThrow(/Could not decrypt/i);
    await expect(unlockUniversityKey('university test passphrase',{configured:true,...x.payload,key_version:2})).rejects.toThrow(/Unsupported/i);
  });
  it('uses safe finite pagination defaults and propagates RPC errors', async () => {
    const rpc=vi.fn().mockResolvedValue({data:[],error:null});
    await officeUniversityManagementApi.read(mock(rpc),'ws-1','students',{},NaN,Infinity);
    expect(rpc).toHaveBeenCalledWith('office_university_read',expect.objectContaining({p_limit:100,p_offset:0}));
    rpc.mockResolvedValueOnce({data:null,error:{message:'version conflict'}});
    await expect(officeUniversityManagementApi.command(mock(rpc),'ws-1','set_score',{})).rejects.toThrow('version conflict');
  });
});
