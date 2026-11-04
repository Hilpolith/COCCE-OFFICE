import { describe, expect, it } from 'vitest';
import { slidesCloudFilesEnabled } from './slidesCloudFeature';

describe('separate Slides cloud release gate', () => {
  it.each([
    [{}, false],
    [{ VITE_OFFICE_CLOUD_FILES_READY: 'true' }, false],
    [{ VITE_OFFICE_SLIDES_CLOUD_FILES_READY: 'true' }, false],
    [{ VITE_OFFICE_CLOUD_FILES_READY: 'true', VITE_OFFICE_SLIDES_CLOUD_FILES_READY: 'true' }, true],
  ] as const)('requires both explicit gates for %j', (env, enabled) => {
    expect(slidesCloudFilesEnabled(env)).toBe(enabled);
  });
});
