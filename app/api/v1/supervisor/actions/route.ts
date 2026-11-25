/**
 * GET /api/v1/supervisor/actions — o que o Supervisor fez, propôs ou pulou (manager+).
 *
 * `?status=pending_approval` é a fila de aprovação; sem filtro, o histórico.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";
import { z } from "zod";

import { ok, fail } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

const filtroSchema = z.object({
  status: z.enum(["applied", "pending_approval", "approved", "rejected", "skipped", "failed", "superseded"]).optional(),
  lead_id: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "supervisor_actions" });
  if (!authz.ok) return authz.response;
  const parsed = filtroSchema.safeParse(Object.fromEntries(new URL(req.url).searchParams));
  if (!parsed.success) return fail("validation_failed", "Parâmetros inválidos.", 422, { requestId });
  const f = parsed.data;

  let q = createAdminClient()
    .from("supervisor_actions")
    .select(
      "id, run_id, conversation_id, contact_id, lead_id, kind, risk, status, before, after, reason, evidence, decided_by, decided_at, result_detail, created_at, crm_leads(title, pipeline_id)",
    )
    .eq("organization_id", authz.org.orgId)
    .order("created_at", { ascending: false })
    .limit(f.limit);
  if (f.status) q = q.eq("status", f.status);
  if (f.lead_id) q = q.eq("lead_id", f.lead_id);
  const { data, error } = await q;
  if (error) return fail("internal_error", "Erro ao listar as ações do Supervisor.", 500, { requestId });
  return ok({ actions: data ?? [] }, { requestId });
}
