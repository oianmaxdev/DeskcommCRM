/**
 * GET/POST /api/v1/cron/supervisor-comercial
 *
 * A rodada do Supervisor Comercial por IA (issues #2092 e #4088): lê, para cada
 * organização com o Supervisor ligado, as conversas de vendedor humano que
 * ficaram em silêncio desde a última leitura, e aplica ao CRM o que a política
 * autoriza. Depois, gera o diagnóstico recorrente que estiver vencido.
 *
 * Agendado a cada 5 minutos no `scheduler` (docker/scheduler/entrypoint.sh). A
 * cadência não precisa ser menor: o próprio debounce de silêncio é de minutos.
 *
 * Auth: `Authorization: Bearer <INTERNAL_CRON_SECRET | INTERNAL_SECRET>`.
 * Audita por AÇÃO aplicada (lib/supervisor/executor.ts), nunca a rodada vazia.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { ok, fail } from "@/lib/api/wrappers";
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";
import { lerConfig } from "@/lib/supervisor/config";
import { geraDiagnostico, interpretarComModelo, recorrenteVencido, redigirComModelo } from "@/lib/supervisor/diagnostico";
import { analisarComModelo, rodadaDoSupervisor } from "@/lib/supervisor/observador";
import { getSupervisorPool } from "@/lib/supervisor/pool";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

async function handle(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const auth = req.headers.get("authorization") ?? "";
  const provided = auth.startsWith("Bearer ") ? auth.slice("Bearer ".length).trim() : "";
  const accepted = [env.INTERNAL_CRON_SECRET, env.INTERNAL_SECRET].filter(Boolean);
  if (accepted.length === 0 || !provided || !accepted.includes(provided)) {
    return fail("forbidden", "Cron secret missing or invalid.", 403, { requestId });
  }

  const admin = createAdminClient();
  try {
    const rodada = await rodadaDoSupervisor(
      { admin, pool: getSupervisorPool(), agora: () => new Date(), analisar: analisarComModelo },
      requestId,
    );

    // Relatórios recorrentes vencidos.
    let relatorios = 0;
    const { data: orgs } = await admin
      .from("supervisor_settings")
      .select("organization_id, config")
      .eq("enabled", true)
      .limit(100);
    for (const o of (orgs ?? []) as Array<{ organization_id: string; config: unknown }>) {
      const config = lerConfig(o.config);
      if (config.relatorio_recorrente === "desligado") continue;
      const { data: ultimo } = await admin
        .from("supervisor_reports")
        .select("created_at")
        .eq("organization_id", o.organization_id)
        .eq("recurring", true)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      const periodo = recorrenteVencido(config.relatorio_recorrente, (ultimo as { created_at: string } | null)?.created_at ?? null, new Date());
      if (!periodo) continue;
      try {
        await geraDiagnostico({ admin, interpretar: interpretarComModelo, redigir: redigirComModelo }, o.organization_id, config, periodo, {}, { requestedBy: null, recurring: true });
        relatorios += 1;
      } catch (err) {
        logger.error("[supervisor-comercial.cron] relatório recorrente falhou", {
          organization_id: o.organization_id,
          error: err instanceof Error ? err.message : String(err),
          requestId,
        });
      }
    }
    return ok({ ...rodada, relatorios_recorrentes: relatorios }, { requestId });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    logger.error("[supervisor-comercial.cron] falhou", { error: detail, requestId });
    return fail("internal_error", detail, 500, { requestId });
  }
}

export async function GET(req: NextRequest): Promise<Response> {
  return handle(req);
}

export async function POST(req: NextRequest): Promise<Response> {
  return handle(req);
}
