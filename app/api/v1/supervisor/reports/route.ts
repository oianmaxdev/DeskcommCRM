import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * GET  /api/v1/supervisor/reports — diagnósticos já gerados (manager+).
 * POST /api/v1/supervisor/reports — gera o diagnóstico de um período (manager+).
 *
 * Body do POST: `{ periodo: "hoje"|"7d"|"15d"|"30d"|"custom", de?, ate?, owner_user_id?, pipeline_id? }`.
 * Um diagnóstico custa uma chamada de modelo: no máximo um por organização a
 * cada 60 s, para um duplo clique não pagar duas vezes.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { createAdminClient } from "@/lib/supabase/admin";
import { lerConfig } from "@/lib/supervisor/config";
import { geraDiagnostico, interpretarComModelo, redigirComModelo } from "@/lib/supervisor/diagnostico";
import { periodoSchema, resolvePeriodo } from "@/lib/supervisor/periodo";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const corpoSchema = periodoSchema;

export async function GET(): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "supervisor_reports" });
  if (!authz.ok) return authz.response;
  const { data, error } = await createAdminClient()
    .from("supervisor_reports")
    .select("id, period_from, period_to, scope, status, conversations_eligible, conversations_analyzed, metrics, diagnosis, error, recurring, created_at")
    .eq("organization_id", authz.org.orgId)
    .order("created_at", { ascending: false })
    .limit(30);
  if (error) return fail("internal_error", "Erro ao listar os diagnósticos.", 500, { requestId });
  return ok({ reports: data ?? [] }, { requestId });
}

export async function POST(req: NextRequest): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;
  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "supervisor_reports" });
  if (!authz.ok) return authz.response;
  const parsed = corpoSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return fail("validation_failed", "Período inválido.", 422, { requestId });
  const periodo = resolvePeriodo(parsed.data, new Date());
  if (!periodo) return fail("validation_failed", "Período inválido (até 366 dias, fim depois do início).", 422, { requestId });
  const org = authz.org.orgId;
  const admin = createAdminClient();

  const { data: ultimo } = await admin
    .from("supervisor_reports")
    .select("created_at")
    .eq("organization_id", org)
    .eq("recurring", false)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  const ultimoEm = (ultimo as { created_at: string } | null)?.created_at;
  if (ultimoEm && Date.now() - new Date(ultimoEm).getTime() < 60_000) {
    return fail("rate_limited", "Aguarde um minuto entre diagnósticos.", 429, { requestId });
  }

  const { data: s } = await admin.from("supervisor_settings").select("config").eq("organization_id", org).maybeSingle();
  try {
    const r = await geraDiagnostico(
      { admin, interpretar: interpretarComModelo, redigir: redigirComModelo },
      org,
      lerConfig((s as { config: unknown } | null)?.config),
      periodo,
      { owner_user_id: parsed.data.owner_user_id ?? null, pipeline_id: parsed.data.pipeline_id ?? null },
      { requestedBy: authz.user.id, recurring: false },
    );
    await audit({
      action: "supervisor.report_generated",
      organizationId: org,
      actorUserId: authz.user.id,
      resourceType: "supervisor_reports",
      resourceId: r.id,
      requestId,
      bypassedRls: true,
      metadata: { de: periodo.de.toISOString(), ate: periodo.ate.toISOString(), status: r.status },
    });
    return ok(r, { requestId });
  } catch (err) {
    return fail("internal_error", err instanceof Error ? err.message : "Erro ao gerar o diagnóstico.", 500, { requestId });
  }
}
