import { createOfficeCloudHandler } from './core.ts';

// Supabase's dashboard/deploy configuration must keep JWT verification enabled.
// The handler also verifies each bearer token against this project's Auth API.
const supabaseRuntime = (globalThis as {
  Deno?: { serve: (handler: (request: Request) => Promise<Response>) => unknown };
}).Deno;

if (!supabaseRuntime?.serve) throw new Error('Supabase Edge Runtime is required.');
supabaseRuntime.serve(createOfficeCloudHandler());
