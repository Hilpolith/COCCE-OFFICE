import { describe, expect, it } from 'vitest';
import { OFFICE_CLOUD_SCOPE_NOTE, officeCloudTierLabel } from './officeCloudLabels';

describe('Office cloud storage labels', () => {
  it('shows the shared workspace allowance as Team storage rather than an internal tier code', () => {
    expect(officeCloudTierLabel('small_office')).toBe('Team storage');
    expect(officeCloudTierLabel('school_college')).toBe('school college');
  });

  it('does not imply private account storage is already available', () => {
    expect(OFFICE_CLOUD_SCOPE_NOTE).toContain('shared by members of this Office workspace');
    expect(OFFICE_CLOUD_SCOPE_NOTE).toContain('Private account storage is separate');
    expect(OFFICE_CLOUD_SCOPE_NOTE).toContain('not available yet');
  });
});
