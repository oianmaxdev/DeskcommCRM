import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * GET /api/v1/supervisor/settings — a política em vigor (manager+).
 * PUT /api/v1/supervisor/settings — liga/desliga e grava a política (admin).
 *
 * A config passa pelo schema ESTRITO (lib/supervisor/config.ts) e cada
 * referência — funil, etapa, fluxo de follow-up — é conferida contra a
 * organização ativa: um id de outra organização no body é 422, nunca gravado.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";
import { z } from "zod";

import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { createAdminClient } from "@/lib/supabase/admin";
import { lerConfig, supervisorConfigSchema } from "@/lib/supervisor/config";
import { lerModeloDoSupervisor } from "@/lib/supervisor/escolha-de-modelo";

export const dynamic = "force-dynamic";

const corpoSchema = z.object({ enabled: z.boolean(), config: supervisorConfigSchema });

export async function GET(): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "supervisor_settings" });
  if (!authz.ok) return authz.response;
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("supervisor_settings")
    .select("enabled, config, updated_at")
    .eq("organization_id", authz.org.orgId)
    .maybeSingle();
  if (error) return fail("internal_error", "Erro ao ler a configuração do Supervisor.", 500, { requestId });
  const row = data as { enabled: boolean; config: unknown; updated_at: string } | null;
  // Qual modelo de IA o Supervisor usa: a escolha (vínculo por ponto) e as opções.
  const modelo = await lerModeloDoSupervisor(admin, authz.org.orgId);
  return ok(
    { enabled: row?.enabled ?? false, config: lerConfig(row?.config), updated_at: row?.updated_at ?? null, modelo },
    { requestId },
  );
}

export async function PUT(req: NextRequest): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;
  const requestId = randomUUID();
  const authz = await requireRole("admin", { requestId, resource: "supervisor_settings" });
  if (!authz.ok) return authz.response;

  const parsed = corpoSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return fail("validation_failed", "Configuração inválida.", 422, {
      requestId,
      details: z.flattenError(parsed.error).fieldErrors as Record<string, unknown>,
    });
  }
  const { enabled, config } = parsed.data;
  const org = authz.org.orgId;
  const admin = createAdminClient();

  // Toda referência pertence à organização ativa.
  if (config.pipelines.length > 0) {
    const { data: p } = await admin.from("crm_pipelines").select("id").eq("organization_id", org).in("id", config.pipelines);
    if ((p ?? []).length !== new Set(config.pipelines).size) {
      return fail("validation_failed", "Um dos funis escolhidos não existe nesta organização.", 422, { requestId });
    }
  }
  const etapaIds = Object.keys(config.etapas);
  if (etapaIds.length > 0) {
    const { data: s } = await admin.from("crm_stages").select("id").eq("organization_id", org).in("id", etapaIds);
    if ((s ?? []).length !== etapaIds.length) {
      return fail("validation_failed", "Uma das etapas configuradas não existe nesta organização.", 422, { requestId });
    }
  }
  if (config.followup_pointer_id) {
    const { data: f } = await admin
      .from("followup_flow_pointers")
      .select("id")
      .eq("organization_id", org)
      .eq("id", config.followup_pointer_id)
      .maybeSingle();
    if (!f) return fail("validation_failed", "O fluxo de follow-up escolhido não existe nesta organização.", 422, { requestId });
  }

  const { data: anterior } = await admin
    .from("supervisor_settings")
    .select("enabled, config")
    .eq("organization_id", org)
    .maybeSingle();
  const { error } = await admin.from("supervisor_settings").upsert(
    { organization_id: org, enabled, config, updated_by: authz.user.id, updated_at: new Date().toISOString() },
    { onConflict: "organization_id" },
  );
  if (error) return fail("internal_error", "Erro ao salvar a configuração do Supervisor.", 500, { requestId });

  await audit({
    action: "supervisor.settings_updated",
    organizationId: org,
    actorUserId: authz.user.id,
    resourceType: "supervisor_settings",
    resourceId: authz.org.orgId,
    requestId,
    bypassedRls: true,
    metadata: {
      enabled_de: (anterior as { enabled: boolean } | null)?.enabled ?? null,
      enabled_para: enabled,
      autonomia: config.autonomia,
      pipelines: config.pipelines,
    },
  });
  return ok({ enabled, config }, { requestId });
}
