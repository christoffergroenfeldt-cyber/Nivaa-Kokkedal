// Indgang for Supabase Edge Function "api" (serveren ligger i index.ts)
import { handle } from "./index.ts";
Deno.serve(handle);
