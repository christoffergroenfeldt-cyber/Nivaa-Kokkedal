// @ts-nocheck
// Indgang for Supabase Edge Function "hoebk" — HØBK (Hørsholm Badminton Klub) på samme server-kode som NKB (../api/).
// club.ts SKAL importeres først: den fortæller serveren, hvilken klub (schema + indstillinger) den kører for.
import "./club.ts";
import { handle } from "../api/index.ts";
Deno.serve(handle);
