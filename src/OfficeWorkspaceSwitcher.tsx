import { useEffect, useMemo, useRef, useState } from 'react';
import { Building2, ChevronDown, LoaderCircle, Plus } from 'lucide-react';
import { officeTeamApi, type OfficeWorkspace, type OfficeWorkspaceSuite } from './lib/officeTeamApi';
import { getOfficeTeamClient, resolveOfficeTeamConfig } from './lib/officeTeamSupabase';
import type { OfficeTeamEnvironment } from './lib/officeTeamSupabase';
import { industryCatalog, type IndustryId } from './lib/industryWorkspaces';
import './officeWorkspaceSwitcher.css';

export default function OfficeWorkspaceSwitcher() {
  const config = useMemo(() => resolveOfficeTeamConfig(import.meta.env as unknown as OfficeTeamEnvironment), []);
  const client = useMemo(() => getOfficeTeamClient(config), [config]);
  const schemaReady = config.status === 'ready' && config.schemaReady;
  const [userId, setUserId] = useState('');
  const userIdRef = useRef('');
  const [workspaces, setWorkspaces] = useState<OfficeWorkspace[]>([]);
  const [suites, setSuites] = useState<OfficeWorkspaceSuite[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const selectedIdRef = useRef('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!client || !schemaReady) {
      setLoading(false);
      return undefined;
    }
    let alive = true;
    let authVersion = 0;

    const clearWorkspaceContext = () => {
      setWorkspaces([]);
      setSuites([]);
      selectedIdRef.current = '';
      setSelectedId('');
      window.dispatchEvent(new CustomEvent('cocce-office:workspace-cleared'));
    };
    const clear = () => {
      userIdRef.current = '';
      setUserId('');
      clearWorkspaceContext();
      setLoading(false);
    };
    const load = async () => {
      const version = authVersion;
      setLoading(true);
      setError('');
      try {
        const [nextWorkspaces, nextSuites] = await Promise.all([
          officeTeamApi.listWorkspaces(client),
          officeTeamApi.listWorkspaceSuites(client),
        ]);
        if (!alive || version !== authVersion) return;
        const currentSelectedId = selectedIdRef.current;
        const nextSelectedId = nextWorkspaces.some((item) => item.workspace_id === currentSelectedId)
          ? currentSelectedId
          : nextWorkspaces[0]?.workspace_id ?? '';
        if (nextSelectedId !== currentSelectedId) {
          selectedIdRef.current = nextSelectedId;
          if (currentSelectedId) window.dispatchEvent(new CustomEvent('cocce-office:workspace-cleared'));
        }
        if (!nextSelectedId) window.dispatchEvent(new CustomEvent('cocce-office:workspace-cleared'));
        setWorkspaces(nextWorkspaces);
        setSuites(nextSuites);
        setSelectedId(nextSelectedId);
      } catch (cause) {
        if (!alive || version !== authVersion) return;
        setError(cause instanceof Error ? cause.message : 'Office workspaces could not be loaded.');
        clearWorkspaceContext();
      } finally {
        if (alive && version === authVersion) setLoading(false);
      }
    };

    const { data: { subscription } } = client.auth.onAuthStateChange((_event, session) => {
      authVersion += 1;
      if (!session) { clear(); return; }
      if (userIdRef.current !== session.user.id) {
        userIdRef.current = session.user.id;
        clearWorkspaceContext();
      }
      setUserId(session.user.id);
      window.setTimeout(() => { if (alive) void load(); }, 0);
    });

    const restore = async () => {
      try {
        const { data, error: sessionError } = await client.auth.getSession();
        if (!alive) return;
        if (sessionError || !data.session) { clear(); return; }
        if (userIdRef.current !== data.session.user.id) {
          userIdRef.current = data.session.user.id;
          clearWorkspaceContext();
        }
        setUserId(data.session.user.id);
        await load();
      } catch {
        if (alive) clear();
      }
    };
    void restore();

    return () => {
      alive = false;
      subscription.unsubscribe();
    };
  }, [client, schemaReady]);

  const selected = workspaces.find((item) => item.workspace_id === selectedId) ?? null;
  const selectedSuite = suites.find((item) => item.workspace_id === selectedId)?.suite_id ?? null;
  const suiteLabel = (suiteId: string | null) => industryCatalog.find((item) => item.id === suiteId)?.shortLabel ?? 'Suite not assigned';

  useEffect(() => {
    if (!selected) return;
    window.dispatchEvent(new CustomEvent('cocce-office:workspace-changed', {
      detail: {
        workspaceId: selected.workspace_id,
        name: selected.name,
        suiteId: selectedSuite as IndustryId | null,
        role: selected.role,
      },
    }));
  }, [selected?.workspace_id, selected?.name, selected?.role, selectedSuite]);

  if (!client || !schemaReady || !userId) return null;

  if (loading) return <span className="office-workspace-switcher-state" role="status"><LoaderCircle size={14} className="office-workspace-switcher-spin" /> Loading workspaces</span>;

  if (error) return <span className="office-workspace-switcher-state" role="status" title={error}>Workspace unavailable</span>;

  if (workspaces.length === 0) return <button type="button" className="office-workspace-switcher-create" onClick={() => window.dispatchEvent(new CustomEvent('cocce-office:navigate', { detail: { page: 'team' } }))}><Plus size={14} /> Create workspace</button>;

  return <label className="office-workspace-switcher" title={error || 'Switch your active Office workspace'}>
    <Building2 size={15} aria-hidden="true" />
    <select aria-label="Active Office workspace" value={selectedId} onChange={(event) => { selectedIdRef.current = event.target.value; setSelectedId(event.target.value); }}>
      {workspaces.map((workspace) => {
        const suiteId = suites.find((item) => item.workspace_id === workspace.workspace_id)?.suite_id ?? null;
        return <option key={workspace.workspace_id} value={workspace.workspace_id}>{workspace.name} · {suiteLabel(suiteId)}</option>;
      })}
    </select>
    <ChevronDown size={14} aria-hidden="true" />
  </label>;
}
