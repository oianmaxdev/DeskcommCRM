import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * POST /api/v1/supervisor/actions/:id — um gestor decide uma pendência (manager+).
 *
 * Body: `{ decisao: "aprovar" | "recusar", lost_reason?, lead_id? }`.
 *  - aprovar: a ação roda pelo MESMO executor do automático, com o gestor como
 *    ator (timeline e auditoria dizem quem aprovou). A trava pelo valor anterior
 *    continua valendo: se o card mudou desde a proposta, a aprovação termina em
 *    `skipped/conflito_humano` e nada é sobrescrito.
 *  - recusar: a ação fica `rejected` e o `dedup_key` impede que a MESMA
 *    proposta volte. Só evidência nova gera proposta nova.
 *  - pendência de identificação (`resolve_lead`): aprovar exige `lead_id` entre
 *    os candidatos; a próxima leitura daquela conversa usa o negócio escolhido.
 *
 * O "claim" é um UPDATE condicionado a `status = 'pending_approval'`: dois
 * gestores clicando ao mesmo tempo não executam a ação duas vezes.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";
import { z } from "zod";

import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { motivoDePerdaAceito, motivosDoFunil } from "@/lib/leads/motivos-de-perda-do-funil";
import { createAdminClient } from "@/lib/supabase/admin";
import { concluiAcao, executaAcao, type AcaoGravada } from "@/lib/supervisor/executor";
import { getSupervisorPool } from "@/lib/supervisor/pool";

export const dynamic = "force-dynamic";

const corpoSchema = z.object({
  decisao: z.enum(["aprovar", "recusar"]),
  lost_reason: z.string().trim().min(1).max(120).optional(),
  lead_id: z.string().uuid().optional(),
});

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;
  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "supervisor_actions" });
  if (!authz.ok) return authz.response;
  const { id } = await ctx.params;
  if (!z.string().uuid().safeParse(id).success) return fail("not_found", "Ação não encontrada.", 404, { requestId });
  const parsed = corpoSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return fail("validation_failed", "Decisão inválida.", 422, { requestId });
  const body = parsed.data;
  const org = authz.org.orgId;
  const admin = createAdminClient();

  const { data, error } = await admin
    .from("supervisor_actions")
    .select("id, organization_id, run_id, conversation_id, contact_id, lead_id, kind, status, before, after, reason, evidence")
    .eq("organization_id", org)
    .eq("id", id)
    .maybeSingle();
  if (error) return fail("internal_error", "Erro ao ler a ação.", 500, { requestId });
  if (!data) return fail("not_found", "Ação não encontrada.", 404, { requestId });
  const acao = data as AcaoGravada & { status: string };
  if (acao.status !== "pending_approval") {
    return fail("conflict", "Esta ação já foi decidida.", 409, { requestId });
  }

  const claim = async (patch: Record<string, unknown>) => {
    const { data: rows } = await admin
      .from("supervisor_actions")
      .update({ ...patch, decided_by: authz.user.id, decided_at: new Date().toISOString(), updated_at: new Date().toISOString() })
      .eq("organization_id", org)
      .eq("id", id)
      .eq("status", "pending_approval")
      .select("id");
    return (rows ?? []).length > 0;
  };

  if (body.decisao === "recusar") {
    if (!(await claim({ status: "rejected" }))) return fail("conflict", "Esta ação já foi decidida.", 409, { requestId });
    await audit({
      action: "supervisor.action_rejected",
      organizationId: org,
      actorUserId: authz.user.id,
      resourceType: "crm_leads",
      resourceId: acao.lead_id,
      requestId,
      bypassedRls: true,
      metadata: { supervisor_action_id: id, kind: acao.kind },
    });
    return ok({ id, status: "rejected" }, { requestId });
  }

  if (acao.kind === "resolve_lead") {
    const candidatos = ((acao.after?.candidatos as Array<{ lead_id: string }> | undefined) ?? []).map((c) => c.lead_id);
    if (!body.lead_id || !candidatos.includes(body.lead_id)) {
      return fail("validation_failed", "Escolha um dos negócios candidatos.", 422, { requestId });
    }
    if (!(await claim({ status: "approved", after: { ...acao.after, lead_escolhido: body.lead_id } }))) {
      return fail("conflict", "Esta ação já foi decidida.", 409, { requestId });
    }
    await audit({
      action: "supervisor.action_approved",
      organizationId: org,
      actorUserId: authz.user.id,
      resourceType: "crm_leads",
      resourceId: body.lead_id,
      requestId,
      bypassedRls: true,
      metadata: { supervisor_action_id: id, kind: acao.kind, conversation_id: acao.conversation_id },
    });
    return ok({ id, status: "approved" }, { requestId });
  }

  if (acao.kind === "mark_lost") {
    const motivo = body.lost_reason ?? (acao.after?.lost_reason as string | null) ?? null;
    if (!motivo) return fail("validation_failed", "Informe o motivo da perda.", 422, { requestId });
    const { data: lead } = await admin
      .from("crm_leads")
      .select("crm_pipelines(settings)")
      .eq("organization_id", org)
      .eq("id", acao.lead_id ?? "")
      .maybeSingle();
    const settings = (lead as { crm_pipelines: { settings: unknown } | null } | null)?.crm_pipelines?.settings;
    if (!motivoDePerdaAceito(motivo, motivosDoFunil(settings))) {
      return fail("validation_failed", "Motivo de perda fora da lista do funil.", 422, { requestId });
    }
    acao.after = { ...acao.after, lost_reason: motivo };
  }

  // Claim antes de executar: a execução é o efeito, e não pode rodar duas vezes.
  if (!(await claim({ status: "approved", after: acao.after }))) {
    return fail("conflict", "Esta ação já foi decidida.", 409, { requestId });
  }
  const quem = { aprovadorUserId: authz.user.id, llmCallId: null, requestId };
  const r = await executaAcao(admin, getSupervisorPool(), acao, quem);
  await concluiAcao(admin, getSupervisorPool(), acao, quem, r);
  const status = r.status === "applied" ? "approved" : r.status;
  return ok({ id, status, detalhe: r.status === "applied" ? null : r.detalhe }, { requestId });
}
