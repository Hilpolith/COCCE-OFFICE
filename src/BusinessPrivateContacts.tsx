import { useCallback, useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  businessRecordsContext,
  normalizeBusinessPrivateContact,
  officeBusinessManagementApi,
  type BusinessPrivateContact,
  type BusinessRecord,
  type BusinessRole,
} from "./lib/officeBusinessManagement";
import {
  createOfficeRecordsKeyConfig,
  decryptOfficePrivateRecord,
  encryptOfficePrivateRecord,
  unlockOfficeRecordsKeyConfig,
  type OfficeRecordsKeyConfig,
} from "./lib/officePrivateRecordsCrypto";
import type { BusinessCommand } from "./lib/businessWorkspaceUi";

const EMPTY_CONTACT: BusinessPrivateContact = {
  contact_name: "",
  email: "",
  phone: "",
  address: "",
  tax_or_registration_reference: "",
};
const FIELDS: Array<{ key: keyof BusinessPrivateContact; label: string }> = [
  { key: "contact_name", label: "Contact name" },
  { key: "email", label: "Email" },
  { key: "phone", label: "Phone" },
  { key: "address", label: "Address" },
  {
    key: "tax_or_registration_reference",
    label: "Tax or registration reference",
  },
];

type PrivateRecord = {
  nonce?: unknown;
  ciphertext?: unknown;
  version?: unknown;
};

type Props = {
  workspaceId: string;
  role: BusinessRole;
  client: SupabaseClient;
  keyConfig: OfficeRecordsKeyConfig;
  accounts: BusinessRecord[];
  busy: boolean;
  command: BusinessCommand;
  reportError: (message: string) => void;
};

function accountId(account: BusinessRecord): string {
  return String(account.account_id ?? "");
}

function accountLabel(account: BusinessRecord): string {
  const publicName =
    account.display_name ?? account.legal_name ?? account.name ?? account.title;
  const reference = account.public_reference;
  const name = publicName ? String(publicName) : "Account";
  return reference ? `${name} · ${String(reference)}` : name;
}

function errorMessage(error: unknown): string {
  const message =
    error instanceof Error
      ? error.message
      : "The private-contact request could not be completed.";
  if (/permission|row-level|42501/i.test(message))
    return "Your Office Team membership or Business role does not allow that action.";
  return message;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function emptyContact(): BusinessPrivateContact {
  return { ...EMPTY_CONTACT };
}

export default function BusinessPrivateContacts({
  workspaceId,
  role,
  client,
  keyConfig,
  accounts,
  busy,
  command,
  reportError,
}: Props) {
  const [key, setKey] = useState<CryptoKey | null>(null);
  const [passphrase, setPassphrase] = useState("");
  const [selectedAccountId, setSelectedAccountId] = useState("");
  const [form, setForm] = useState<BusinessPrivateContact>(emptyContact);
  const [loadedVersion, setLoadedVersion] = useState<number | null>(null);
  const [loadedRecord, setLoadedRecord] = useState(false);
  const [revealed, setRevealed] = useState(false);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const epoch = useRef(0);
  const mounted = useRef(true);
  const context = businessRecordsContext(workspaceId);
  const admin = role === "business_admin";

  const clearPrivateState = useCallback(() => {
    epoch.current += 1;
    setKey(null);
    setPassphrase("");
    setSelectedAccountId("");
    setForm(emptyContact());
    setLoadedVersion(null);
    setLoadedRecord(false);
    setRevealed(false);
    setStatus("");
    setError("");
  }, []);

  const fail = useCallback(
    (value: unknown, token: number) => {
      if (!mounted.current || token !== epoch.current) return;
      const message = errorMessage(value);
      setError(message);
      if (/permission|row-level|42501/i.test(message)) {
        clearPrivateState();
        reportError(message);
      }
    },
    [clearPrivateState, reportError],
  );

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      epoch.current += 1;
      setKey(null);
      setPassphrase("");
      setForm(emptyContact());
      setRevealed(false);
    };
  }, []);

  useEffect(() => {
    clearPrivateState();
  }, [workspaceId, role, clearPrivateState]);

  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === "hidden") clearPrivateState();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [clearPrivateState]);

  useEffect(() => {
    if (!key) return undefined;
    const timer = window.setTimeout(clearPrivateState, 10 * 60 * 1000);
    return () => window.clearTimeout(timer);
  }, [key, clearPrivateState]);

  const unlock = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    const snapshot = passphrase;
    setPassphrase("");
    const token = epoch.current;
    setError("");
    try {
      if (!snapshot) throw new Error("Enter the Office records passphrase.");
      if (!keyConfig.configured && !admin) {
        setStatus(
          "An administrator must configure the private-contact key before it can be unlocked.",
        );
        return;
      }
      if (!keyConfig.configured) {
        const created = await createOfficeRecordsKeyConfig(snapshot, context);
        if (!mounted.current || token !== epoch.current) return;
        const result = await command(
          "configure_contact_key",
          created.payload,
          "Private contact key configured.",
        );
        if (!mounted.current || token !== epoch.current) return;
        if (result === null)
          throw new Error(
            "The private-contact key configuration was not confirmed by the server.",
          );
        setKey(created.key);
        setStatus("Private contacts unlocked in memory only.");
      } else {
        const unlocked = await unlockOfficeRecordsKeyConfig(
          snapshot,
          keyConfig,
          context,
        );
        if (!mounted.current || token !== epoch.current) return;
        setKey(unlocked);
        setStatus("Private contacts unlocked in memory only.");
      }
    } catch (caught) {
      fail(caught, token);
    }
  };

  const selectAccount = (nextId: string) => {
    epoch.current += 1;
    setSelectedAccountId(nextId);
    setForm(emptyContact());
    setLoadedVersion(null);
    setLoadedRecord(false);
    setRevealed(false);
    setStatus("");
    setError("");
  };

  const loadContact = async () => {
    if (!key || !selectedAccountId) return;
    const token = epoch.current;
    setError("");
    setStatus("");
    try {
      const raw: unknown = await officeBusinessManagementApi.read(
        client,
        workspaceId,
        "account_private",
        { account_id: selectedAccountId },
      );
      if (!mounted.current || token !== epoch.current) return;
      if (raw === null) {
        setForm(emptyContact());
        setLoadedRecord(false);
        setLoadedVersion(null);
        setRevealed(true);
        setStatus("No encrypted private contact is saved for this account.");
        return;
      }
      if (!isObject(raw))
        throw new Error("The private-contact response was malformed.");
      const record = raw as PrivateRecord;
      if (
        typeof record.nonce !== "string" ||
        typeof record.ciphertext !== "string"
      )
        throw new Error("The private-contact response was malformed.");
      const decrypted = await decryptOfficePrivateRecord<
        Record<string, unknown>
      >(key, { nonce: record.nonce, ciphertext: record.ciphertext }, context);
      if (!mounted.current || token !== epoch.current) return;
      const normalized = normalizeBusinessPrivateContact(decrypted);
      const version = Number(record.version);
      if (!Number.isSafeInteger(version) || version < 1)
        throw new Error("The private-contact version was malformed.");
      setForm(normalized);
      setLoadedVersion(version);
      setLoadedRecord(true);
      setRevealed(true);
      setStatus("Private contact loaded into this device only.");
    } catch (caught) {
      fail(caught, token);
    }
  };

  const saveContact = async (event: FormEvent) => {
    event.preventDefault();
    if (!key || !selectedAccountId || busy) return;
    const token = epoch.current;
    setError("");
    setStatus("");
    try {
      const normalized = normalizeBusinessPrivateContact(form);
      if (loadedRecord && loadedVersion === null)
        throw new Error(
          "Load the current private contact before overwriting it.",
        );
      if (!loadedRecord) {
        const raw: unknown = await officeBusinessManagementApi.read(
          client,
          workspaceId,
          "account_private",
          { account_id: selectedAccountId },
        );
        if (!mounted.current || token !== epoch.current) return;
        if (raw !== null)
          throw new Error(
            "A private contact already exists. Load the current contact before overwriting it.",
          );
      }
      const encrypted = await encryptOfficePrivateRecord(
        key,
        normalized,
        context,
      );
      if (!mounted.current || token !== epoch.current) return;
      const payload: BusinessRecord = {
        account_id: selectedAccountId,
        nonce: encrypted.nonce,
        ciphertext: encrypted.ciphertext,
      };
      if (loadedVersion !== null) payload.expected_version = loadedVersion;
      const result = await command(
        "save_account_private",
        payload,
        "Private contact encrypted and saved.",
      );
      if (!mounted.current || token !== epoch.current) return;
      const nextVersion = Number(result?.version);
      if (Number.isSafeInteger(nextVersion) && nextVersion > 0)
        setLoadedVersion(nextVersion);
      setLoadedRecord(true);
      setRevealed(false);
      setStatus("Private contact encrypted and saved.");
    } catch (caught) {
      fail(caught, token);
    }
  };

  const changeField = (field: keyof BusinessPrivateContact, value: string) => {
    setForm((previous) => ({ ...previous, [field]: value }));
    setRevealed(true);
  };

  return (
    <section
      className="business-panel business-card"
      aria-label="Private contact details"
    >
      <div className="business-card-head">
        <div>
          <span className="business-eyebrow">Encrypted contacts</span>
          <h3>Private contact details</h3>
        </div>
      </div>
      <p className="business-note">
        Contact details are normalized and encrypted in this browser. Plaintext
        and passphrases are never sent to the server.
      </p>
      {error && (
        <div className="business-alert" role="alert">
          {error}
        </div>
      )}
      {status && (
        <div className="business-note" role="status">
          {status}
        </div>
      )}
      {!key ? (
        <form className="business-form" onSubmit={unlock}>
          {!keyConfig.configured && !admin && (
            <p className="business-note">
              Private-contact key setup is waiting for a Business administrator.
            </p>
          )}
          {!keyConfig.configured && admin && (
            <p className="business-note">
              Configure the private-contact key once. The derived key remains
              non-extractable and memory-only.
            </p>
          )}
          {keyConfig.configured && (
            <p className="business-note">
              Unlock the configured private-contact key. A wrong passphrase will
              not change saved records.
            </p>
          )}
          <label>
            Passphrase
            <input
              aria-label="Passphrase"
              type="password"
              value={passphrase}
              onChange={(event) => setPassphrase(event.target.value)}
              autoComplete="new-password"
            />
          </label>
          <button
            className="business-button primary"
            type="submit"
            disabled={busy || (!keyConfig.configured && !admin)}
          >
            {keyConfig.configured ? "Unlock" : "Configure key"}
          </button>
        </form>
      ) : (
        <>
          <form className="business-form" onSubmit={saveContact}>
            <label>
              Account
              <select
                aria-label="Account"
                value={selectedAccountId}
                onChange={(event) => selectAccount(event.target.value)}
              >
                <option value="">Choose an account…</option>
                {accounts.map((account) => (
                  <option key={accountId(account)} value={accountId(account)}>
                    {accountLabel(account)}
                  </option>
                ))}
              </select>
            </label>
            {FIELDS.map((field) => (
              <label key={field.key}>
                {field.label}
                <input
                  aria-label={field.label}
                  value={String(form[field.key])}
                  onChange={(event) =>
                    changeField(field.key, event.target.value)
                  }
                  maxLength={
                    field.key === "address"
                      ? 500
                      : field.key === "email"
                        ? 160
                        : field.key === "contact_name" ||
                            field.key === "tax_or_registration_reference"
                          ? 120
                          : 40
                  }
                />
              </label>
            ))}
            <button
              className="business-button primary"
              type="submit"
              disabled={busy || !selectedAccountId}
            >
              Save encrypted contact
            </button>
          </form>
          <div className="business-action-row">
            <button
              className="business-button secondary"
              type="button"
              onClick={() => void loadContact()}
              disabled={busy || !selectedAccountId}
            >
              Load contact
            </button>
            <button
              className="business-button secondary"
              type="button"
              onClick={clearPrivateState}
            >
              Lock and clear private data
            </button>
          </div>
          {selectedAccountId && !loadedRecord && (
            <p className="business-note">
              Load the contact before overwriting an existing encrypted record.
            </p>
          )}
          {revealed && selectedAccountId && (
            <p className="business-note">
              The loaded private contact is visible only in this form.
            </p>
          )}
        </>
      )}
    </section>
  );
}
