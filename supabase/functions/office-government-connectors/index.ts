import { createOfficeGovernmentHandler } from './core.ts';

const runtime = (globalThis as { Deno?: { serve: (handler: (request: Request) => Promise<Response>) => unknown } }).Deno;
if (!runtime?.serve) throw new Error('Supabase Edge Runtime is required.');
runtime.serve(createOfficeGovernmentHandler());
