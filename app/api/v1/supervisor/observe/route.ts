import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * POST /api/v1/supervisor/observe — "Analisar agora" (admin).
 *
 * A mesma rodada do cron, só para a organização ativa e SEM esperar o silêncio
 * — para quem acabou de configurar ver o Supervisor agir, e para homologação.
 * Body opcional: `{ conversation_id }` para ler uma conversa só.
 *
 * Mesmas garantias do cron (claim por janela, dedup de ação, política).
 * Uma rodada manual por organização a cada 30 s.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";
import { z } from "zod";

import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { createAdminClient } from "@/lib/supabase/admin";
import { lerConfig } from "@/lib/supervisor/config";
import { analisarComModelo, observaOrganizacao } from "@/lib/supervisor/observador";
import { getSupervisorPool } from "@/lib/supervisor/pool";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const corpoSchema = z.object({ conversation_id: z.string().uuid().optional() }).default({});
const ultimaRodada = new Map<string, number>();

export async function POST(req: NextRequest): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;
  const requestId = randomUUID();
  const authz = await requireRole("admin", { requestId, resource: "supervisor_runs" });
  if (!authz.ok) return authz.response;
  const parsed = corpoSchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return fail("validation_failed", "Pedido inválido.", 422, { requestId });
  const org = authz.org.orgId;

  const antes = ultimaRodada.get(org);
  if (antes && Date.now() - antes < 30_000) {
    return fail("rate_limited", "Aguarde alguns segundos entre rodadas manuais.", 429, { requestId });
  }
  ultimaRodada.set(org, Date.now());

  const admin = createAdminClient();
  const { data: s } = await admin.from("supervisor_settings").select("enabled, config").eq("organization_id", org).maybeSingle();
  const row = s as { enabled: boolean; config: unknown } | null;
  if (!row?.enabled) return fail("validation_failed", "Ligue o Supervisor antes de pedir uma análise.", 422, { requestId });

  const r = await observaOrganizacao(
    { admin, pool: getSupervisorPool(), agora: () => new Date(), analisar: analisarComModelo },
    org,
    lerConfig(row.config),
    { requestId, conversationId: parsed.data.conversation_id, ignorarSilencio: true },
  );
  if (r.conversas_lidas > 0 || r.acoes_aplicadas > 0 || r.acoes_pendentes > 0) {
    await audit({
      action: "supervisor.observe_requested",
      organizationId: org,
      actorUserId: authz.user.id,
      resourceType: "supervisor_runs",
      requestId,
      bypassedRls: true,
      metadata: { ...r },
    });
  }
  return ok(r, { requestId });
}
