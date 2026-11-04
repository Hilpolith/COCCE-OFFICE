/** Slides requires a separate explicit opt-in after its live release check passes. */
export function slidesCloudFilesEnabled(env: Record<string, unknown>): boolean {
  return env.VITE_OFFICE_CLOUD_FILES_READY === 'true'
    && env.VITE_OFFICE_SLIDES_CLOUD_FILES_READY === 'true';
}
