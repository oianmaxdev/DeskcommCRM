/**
 * GET /api/v1/supervisor/reports/:id/pdf — baixa o diagnóstico em PDF (manager+).
 *
 * `?modo=detalhado` (padrão, com até 5 estudos de caso) ou `?modo=resumo`
 * (só o diagnóstico geral). `?anonimo=1` troca o título dos negócios por
 * "Atendimento N", para o relatório circular fora da empresa.
 *
 * Renderiza o que JÁ ESTÁ GRAVADO em `supervisor_reports`: nenhuma chamada de
 * modelo, nenhum recálculo, nenhum arquivo armazenado. Baixar duas vezes dá o
 * mesmo documento. É leitura (GET), por isso não audita como mutação.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";
import { z } from "zod";

import { fail } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { createAdminClient } from "@/lib/supabase/admin";
import { lerConfig, rotuloDoCriterio } from "@/lib/supervisor/config";
import { renderizaDiagnosticoEmPdf } from "@/lib/supervisor/relatorio-pdf";
import type { RelatorioGravado } from "@/lib/supervisor/relatorio-tipos";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const consulta = z.object({ modo: z.enum(["detalhado", "resumo"]).default("detalhado"), anonimo: z.enum(["0", "1"]).default("0") });

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "supervisor_reports" });
  if (!authz.ok) return authz.response;
  const { id } = await ctx.params;
  if (!z.string().uuid().safeParse(id).success) return fail("not_found", "Diagnóstico não encontrado.", 404, { requestId });
  const q = consulta.safeParse(Object.fromEntries(new URL(req.url).searchParams));
  if (!q.success) return fail("validation_failed", "Parâmetros inválidos.", 422, { requestId });

  const org = authz.org.orgId;
  const admin = createAdminClient();
  const [{ data: rel, error }, { data: orgRow }, { data: cfg }] = await Promise.all([
    admin
      .from("supervisor_reports")
      .select("id, period_from, period_to, status, conversations_eligible, conversations_analyzed, recurring, created_at, error, metrics, diagnosis")
      .eq("organization_id", org)
      .eq("id", id)
      .maybeSingle(),
    admin.from("organizations").select("display_name, timezone").eq("id", org).maybeSingle(),
    admin.from("supervisor_settings").select("config").eq("organization_id", org).maybeSingle(),
  ]);
  if (error) return fail("internal_error", "Erro ao ler o diagnóstico.", 500, { requestId });
  if (!rel) return fail("not_found", "Diagnóstico não encontrado.", 404, { requestId });

  const r = rel as unknown as RelatorioGravado;
  const o = orgRow as { display_name: string | null; timezone: string | null } | null;
  const config = lerConfig((cfg as { config: unknown } | null)?.config);
  const gravados = r.metrics?.rotulos_dos_criterios ?? {};
  try {
    const pdf = await renderizaDiagnosticoEmPdf(r, {
      modo: q.data.modo,
      anonimo: q.data.anonimo === "1",
      organizacao: r.diagnosis?.contexto?.organizacao ?? o?.display_name ?? authz.org.name,
      fuso: r.diagnosis?.contexto?.fuso ?? o?.timezone ?? null,
      // o rótulo gravado com o relatório vence: é o que valia quando ele foi gerado
      rotuloDoCriterio: (cid) => gravados[cid] ?? rotuloDoCriterio(cid, config),
      geradoEm: new Date(r.created_at),
    });
    const dia = r.period_to.slice(0, 10);
    return new Response(new Uint8Array(pdf), {
      status: 200,
      headers: {
        "content-type": "application/pdf",
        "content-disposition": `attachment; filename="diagnostico-comercial-${dia}${q.data.modo === "resumo" ? "-resumo" : ""}.pdf"`,
        "cache-control": "private, no-store",
        "x-request-id": requestId,
      },
    });
  } catch (err) {
    return fail("internal_error", err instanceof Error ? err.message : "Erro ao gerar o PDF.", 500, { requestId });
  }
}
