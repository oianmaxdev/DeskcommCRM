/**
 * Retomada de ações interrompidas (achado D da auditoria de 2026-11-25).
 *
 * Uma ação passa por `executing` entre a reserva e o efeito confirmado. Se o
 * processo cai nesse intervalo, ela fica em `executing`. Esta rotina — chamada
 * pelo cron antes de cada rodada — reivindica as que estão paradas há mais de
 * `PARADA_APOS_MS` e as executa de novo em modo RETOMADA: cada efeito confere se
 * já aconteceu antes de repetir (ver `QuemExecuta.retomada` em executor.ts).
 *
 * Duas execuções nunca retomam a mesma ação: a reivindicação é um UPDATE
 * condicional na hora de início que foi lida. Depois de `MAX_TENTATIVAS`, a
 * ação fecha em `failed` com motivo, em vez de girar para sempre.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type pg from "pg";

import { logger } from "@/lib/logger";

import { concluiAcao, executaAcao, type AcaoGravada, type QuemExecuta } from "./executor";

export const PARADA_APOS_MS = 10 * 60 * 1000;
export const MAX_TENTATIVAS = 3;

export interface ResumoDaRetomada {
  retomadas: number;
  aplicadas: number;
  desistidas: number;
}

export async function retomaAcoesInterrompidas(
  admin: SupabaseClient,
  pool: pg.Pool | null,
  agora: Date,
  requestId: string,
  limite = 50,
  /** Organizações paradas (suspensas): a ação fica em execução até a organização voltar. */
  orgsParadas: ReadonlySet<string> = new Set(),
): Promise<ResumoDaRetomada> {
  const out: ResumoDaRetomada = { retomadas: 0, aplicadas: 0, desistidas: 0 };
  const corte = new Date(agora.getTime() - PARADA_APOS_MS).toISOString();
  const { data, error } = await admin
    .from("supervisor_actions")
    .select(
      "id, organization_id, run_id, conversation_id, contact_id, lead_id, kind, before, after, reason, evidence, decided_by, execution_started_at, execution_attempts",
    )
    .eq("status", "executing")
    .lt("execution_started_at", corte)
    .order("execution_started_at", { ascending: true })
    .limit(limite);
  if (error) throw new Error(`supervisor_actions (retomada): ${error.message}`);

  for (const row of (data ?? []) as Array<
    AcaoGravada & { decided_by: string | null; execution_started_at: string; execution_attempts: number }
  >) {
    if (orgsParadas.has(row.organization_id)) continue;
    // Reivindica: só quem ainda vê a MESMA hora de início leva.
    const esgotou = row.execution_attempts >= MAX_TENTATIVAS;
    const { data: minhas } = await admin
      .from("supervisor_actions")
      .update(
        esgotou
          ? { status: "failed", result_detail: "interrompida_repetidamente", updated_at: agora.toISOString() }
          : {
              execution_started_at: agora.toISOString(),
              execution_attempts: row.execution_attempts + 1,
              updated_at: agora.toISOString(),
            },
      )
      .eq("organization_id", row.organization_id)
      .eq("id", row.id)
      .eq("status", "executing")
      .eq("execution_started_at", row.execution_started_at)
      .select("id");
    if ((minhas ?? []).length === 0) continue; // outra execução pegou
    if (esgotou) {
      out.desistidas += 1;
      logger.error("[supervisor] ação interrompida demais: fechada como falha", { action_id: row.id, kind: row.kind });
      continue;
    }
    out.retomadas += 1;
    const quem: QuemExecuta = {
      aprovadorUserId: row.decided_by,
      llmCallId: null,
      requestId,
      retomada: true,
    };
    try {
      const r = await executaAcao(admin, pool, row, quem);
      const fechou = await concluiAcao(admin, pool, row, quem, r);
      if (fechou && r.status === "applied") out.aplicadas += 1;
    } catch (err) {
      // Fica em `executing`: a próxima rodada tenta de novo (até MAX_TENTATIVAS).
      logger.error("[supervisor] retomada falhou (segue em execução)", {
        action_id: row.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return out;
}
