export const OFFICE_CLOUD_SCOPE_NOTE =
  'This allowance is shared by members of this Office workspace. Private account storage is separate and is not available yet.';

export function officeCloudTierLabel(tierCode: string): string {
  if (tierCode === 'small_office') return 'Team storage';
  return tierCode.replaceAll('_', ' ');
}
