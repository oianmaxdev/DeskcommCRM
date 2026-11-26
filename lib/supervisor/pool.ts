/**
 * Pool de Postgres do Supervisor — só para `recalculaScoreDoLead`, que fala SQL
 * cru (`pg.Pool`) como o worker do agente. Mesmo `createPool` do harness;
 * singleton preguiçoso, criado no primeiro uso, nunca no import.
 */
import type pg from "pg";

import { createPool } from "@/lib/agent-engine/db/pool";
import { env } from "@/lib/env";

let pool: pg.Pool | undefined;

export function getSupervisorPool(): pg.Pool {
  if (!pool) pool = createPool(env.SUPABASE_DB_URL);
  return pool;
}
