import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { NgoDataResource, NgoFilter, NgoPage, NgoRow } from './lib/officeNgoTypes';
import type { NgoWorkspaceContext } from './ngoWorkspaceTypes';

export function text(row: NgoRow | null | undefined, key: string, fallback = '—'): string {
  const value = row?.[key];
  return value === null || value === undefined || value === '' ? fallback : String(value);
}

export function useNgoRows(context: NgoWorkspaceContext, resource: NgoDataResource, filter: NgoFilter = {}) {
  const [rows, setRows] = useState<NgoRow[]>([]);
  const [page, setPage] = useState<NgoPage | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const contextLoad = context.load;
  const filterKey = useMemo(() => JSON.stringify(Object.keys(filter).sort().reduce<Record<string, unknown>>((out, key) => { out[key] = filter[key as keyof NgoFilter]; return out; }, {})), [filter.id, filter.project_id, filter.grant_id, filter.status, filter.purpose]);
  const epoch = useRef(0);
  const load = useCallback(async (offset = 0, append = false) => {
    const request = ++epoch.current;
    setLoading(true); setError('');
    try {
      const result = await contextLoad(resource, JSON.parse(filterKey) as NgoFilter, offset);
      if (request !== epoch.current) return result;
      if (!result || !Array.isArray(result.rows) || typeof result.total_count !== 'number' || typeof result.limit !== 'number' || typeof result.offset !== 'number' || typeof result.has_more !== 'boolean') throw new Error('The server returned an unreadable collection.');
      setRows(current => append ? [...current, ...result.rows] : result.rows);
      setPage(result);
      return result;
    } catch (cause) {
      if (request !== epoch.current) return Promise.reject(cause);
      const message = cause instanceof Error ? cause.message : 'Could not load this collection.';
      setError(message); throw cause;
    } finally { if (request === epoch.current) setLoading(false); }
  }, [contextLoad, resource, filterKey]);
  useEffect(() => { epoch.current += 1; void load(0, false).catch(() => undefined); return () => { epoch.current += 1; }; }, [load, context.revision]);
  const loadMore = useCallback(() => page?.has_more && !loading ? load(page.offset + page.limit, true) : Promise.resolve(page), [load, page, loading]);
  const reload = useCallback(() => load(0, false), [load]);
  return { rows, page, loading, error, loadMore, reload };
}

export function NgoSection({ title, description, children }: { title: string; description?: string; children: ReactNode }) {
  return <section className="ngo-section glass-card"><div className="ngo-section-heading"><div><span className="eyebrow">NGO WORKSPACE</span><h2>{title}</h2>{description && <p>{description}</p>}</div></div>{children}</section>;
}
export function NgoField({ label, children }: { label: string; children: ReactNode }) { return <label className="ngo-field"><span>{label}</span>{children}</label>; }
export function NgoEmpty({ children }: { children: ReactNode }) { return <div className="ngo-empty" role="status">{children}</div>; }
export function NgoPager({ collection }: { collection: ReturnType<typeof useNgoRows> }) {
  if (!collection.page?.has_more) return null;
  return <button type="button" className="button-secondary ngo-load-more" onClick={() => void collection.loadMore().catch(() => undefined)} disabled={collection.loading}>Load more ({collection.rows.length} of {collection.page.total_count})</button>;
}
export function NgoRows({ rows, labelKey, detailKeys = [], selectedId, onSelect }: { rows: NgoRow[]; labelKey: string; detailKeys?: string[]; selectedId?: string; onSelect?: (row: NgoRow) => void }) {
  if (!rows.length) return <NgoEmpty>No records have been added yet.</NgoEmpty>;
  return <div className="ngo-row-list">{rows.map(row => {
    const content = <><strong>{text(row, labelKey)}</strong><span>{detailKeys.map(key => `${key.replaceAll('_', ' ')}: ${text(row, key)}`).join(' · ')}</span></>;
    return onSelect ? <button type="button" className={`ngo-row ${selectedId === row.id ? 'is-selected' : ''}`} key={String(row.id)} onClick={() => onSelect(row)}>{content}</button> : <div className="ngo-row ngo-row-static" key={String(row.id)}>{content}</div>;
  })}</div>;
}
export function NgoSelect({ label, rows, value, onChange, labelKey = 'name', required }: { label: string; rows: NgoRow[]; value: string; onChange: (value: string) => void; labelKey?: string; required?: boolean }) {
  return <NgoField label={label}><select aria-label={label} value={value} required={required} onChange={event => onChange(event.target.value)}><option value="">Select…</option>{rows.map(row => <option key={String(row.id)} value={String(row.id)}>{text(row, labelKey)}</option>)}</select></NgoField>;
}
