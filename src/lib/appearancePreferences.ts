export type SurfaceStyle = 'glass' | 'solid';

export const APPEARANCE_STORAGE_KEY = 'cocce-office-appearance-v1';

const DEFAULT_SURFACE_STYLE: SurfaceStyle = 'glass';
const MAX_STORED_VALUE_BYTES = 1024;

type StoredAppearance = {
  version: 1;
  surface: SurfaceStyle;
};

function isSurfaceStyle(value: unknown): value is SurfaceStyle {
  return value === 'glass' || value === 'solid';
}

function isStoredAppearance(value: unknown): value is StoredAppearance {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return candidate.version === 1 && isSurfaceStyle(candidate.surface);
}

function isWithinSizeLimit(value: string): boolean {
  return new TextEncoder().encode(value).byteLength <= MAX_STORED_VALUE_BYTES;
}

export function readSurfaceStyle(storage: Pick<Storage, 'getItem'>): SurfaceStyle {
  try {
    const raw = storage.getItem(APPEARANCE_STORAGE_KEY);
    if (raw === null || !isWithinSizeLimit(raw)) return DEFAULT_SURFACE_STYLE;

    const parsed: unknown = JSON.parse(raw);
    return isStoredAppearance(parsed) ? parsed.surface : DEFAULT_SURFACE_STYLE;
  } catch {
    return DEFAULT_SURFACE_STYLE;
  }
}

export function writeSurfaceStyle(
  storage: Pick<Storage, 'setItem'>,
  surface: SurfaceStyle,
): void {
  if (!isSurfaceStyle(surface)) {
    throw new TypeError('Invalid appearance surface style.');
  }

  const serialized = JSON.stringify({ version: 1, surface } satisfies StoredAppearance);
  try {
    storage.setItem(APPEARANCE_STORAGE_KEY, serialized);
  } catch {
    throw new Error('Unable to save appearance preference.');
  }
}
