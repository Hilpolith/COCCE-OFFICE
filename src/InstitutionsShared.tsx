import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode, SelectHTMLAttributes } from 'react';
import type { InstitutionsDataResource, InstitutionsFilter, InstitutionsRow } from './lib/officeInstitutionsTypes';
import type { InstitutionsWorkspaceContext } from './institutionsWorkspaceTypes';

export function Button(props: ButtonHTMLAttributes<HTMLButtonElement>) { return <button {...props} className={`institutions-button ${props.className ?? ''}`} />; }
export function Card({ title, description, children }: { title: string; description?: string; children: ReactNode }) { return <section className="institutions-card"><header><h2>{title}</h2>{description && <p>{description}</p>}</header>{children}</section>; }
export function Field({ label, children, ...props }: InputHTMLAttributes<HTMLInputElement> & { label: string; children?: ReactNode }) { return <label className="institutions-field">{label}{children ?? <input {...props} />}</label>; }
export function Select({ label, options, placeholder = 'Select…', ...props }: SelectHTMLAttributes<HTMLSelectElement> & { label: string; options: Array<{ value: string; label: string }>; placeholder?: string }) { return <label className="institutions-field">{label}<select {...props}>{placeholder && <option value="" disabled>{placeholder}</option>}{options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>; }
export function Notice({ children, alert = false }: { children: ReactNode; alert?: boolean }) { return <div className={`institutions-notice ${alert ? 'is-alert' : ''}`} role={alert ? 'alert' : 'note'}>{children}</div>; }
export function val(row: InstitutionsRow, key: string): string { const value = row[key]; return value === null || value === undefined ? '' : String(value); }
export function num(row: InstitutionsRow, key: string): number { const value = Number(row[key]); return Number.isFinite(value) ? value : 0; }
export function InstitutionsRows({ rows, columns, empty = 'No records are available.' }: { rows: InstitutionsRow[]; columns: Array<{ key: string; label: string }>; empty?: string }) { if (!rows.length) return <p className="institutions-empty">{empty}</p>; return <div className="institutions-table-wrap"><table className="institutions-table"><thead><tr>{columns.map(column => <th key={column.key}>{column.label}</th>)}</tr></thead><tbody>{rows.map((row, index) => <tr key={val(row, 'id') || String(index)}>{columns.map(column => <td key={column.key}>{val(row, column.key) || '—'}</td>)}</tr>)}</tbody></table></div>; }

export function useInstitutionsCollection(context: InstitutionsWorkspaceContext, resource: InstitutionsDataResource, filter: InstitutionsFilter = {}) {
  const fingerprint = useMemo(() => JSON.stringify(filter), [filter]);
  const load = context.load;
  const [state, setState] = useState({ rows: [] as InstitutionsRow[], total_count: 0, loading: true, error: '', offset: 0, has_more: false });
  const generation = useRef(0); const mounted = useRef(true);
  useEffect(() => () => { mounted.current = false; generation.current += 1; }, []);
  useEffect(() => { mounted.current = true; }, []);
  const loadPage = useCallback(async (offset: number) => {
    const token = ++generation.current;
    if (mounted.current) setState(current => ({ ...current, loading: true, error: '' }));
    try {
      const page = await load(resource, filter, offset);
      if (!mounted.current || token !== generation.current) return;
      setState({ ...page, loading: false, error: '', offset: page.offset });
    } catch (cause) {
      if (!mounted.current || token !== generation.current) return;
      setState(current => ({ ...current, loading: false, error: cause instanceof Error ? cause.message : 'Could not load records.' }));
    }
  }, [load, resource, fingerprint]);
  useEffect(() => { void loadPage(0); }, [loadPage, context.revision]);
  return { ...state, retry: () => loadPage(state.offset), next: () => state.has_more && loadPage(state.offset + 50), previous: () => state.offset > 0 && loadPage(Math.max(0, state.offset - 50)) };
}
