import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { ROLE_RANK } from "@/lib/auth/types";
import { traduzir } from "@/lib/i18n/dicionario";
import { motivosDoFunil, opcoesDeMotivoDePerda } from "@/lib/leads/motivos-de-perda-do-funil";
import { createClient } from "@/lib/supabase/server";

import { SupervisorClient } from "./_client";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Supervisor Comercial" };

/**
 * Supervisor Comercial por IA (issues #2092 e #4088).
 *
 * Mora em Análise, e não em Agentes de IA, porque o Supervisor não é um agente
 * que atende: ele OBSERVA a equipe e mantém o CRM em dia. Quem abre esta tela é
 * o gestor perguntando "o que mudou no funil sem ninguém clicar?" e "como a
 * equipe está atendendo?" — as mesmas perguntas de Desempenho e Atividades.
 *
 * As leituras usam o client do usuário (RLS: manager+); as escritas passam
 * pelas rotas `/api/v1/supervisor/*`.
 */
export default async function SupervisorPage() {
  const user = await requireAuth();
  const org = await resolveActiveOrg(user);
  if (!org) redirect("/app");
  if (ROLE_RANK[org.role] < ROLE_RANK.manager) redirect("/403");

  const supabase = await createClient();
  const [{ data: pipelines }, { data: stages }, { data: flows }] = await Promise.all([
    supabase
      .from("crm_pipelines")
      .select("id, name, settings")
      .eq("organization_id", org.orgId)
      .eq("is_archived", false)
      .order("position"),
    supabase
      .from("crm_stages")
      .select("id, pipeline_id, name, position, is_won, is_lost, requires_human")
      .eq("organization_id", org.orgId)
      .eq("is_archived", false)
      .order("position"),
    supabase
      .from("followup_flow_pointers")
      .select("id, name, status")
      .eq("organization_id", org.orgId)
      .eq("status", "active"),
  ]);

  const { data: orgRow } = await supabase.from("organizations").select("timezone").eq("id", org.orgId).maybeSingle();
  const fuso = (orgRow as { timezone: string | null } | null)?.timezone ?? null;

  const funis = ((pipelines ?? []) as Array<{ id: string; name: string; settings: unknown }>).map((p) => ({
    id: p.id,
    name: p.name,
    motivos: opcoesDeMotivoDePerda(motivosDoFunil(p.settings)).map((o) => o.valor),
  }));

  return (
    <div className="flex h-full flex-col gap-6 p-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">{traduzir("Supervisor Comercial", user.idioma)}</h1>
        <p className="max-w-3xl text-sm text-muted-foreground">
          {traduzir(
            "A IA acompanha as conversas da equipe e mantém o CRM em dia — etapa, campos, tags, tarefas e score — sem nunca falar com o cliente. Aqui você vê o que ela fez, decide o que pediu aprovação e lê o diagnóstico do período.",
            user.idioma,
          )}
        </p>
      </header>
      <SupervisorClient
        isAdmin={ROLE_RANK[org.role] >= ROLE_RANK.admin}
        fuso={fuso}
        funis={funis}
        etapas={(stages ?? []) as Array<{ id: string; pipeline_id: string; name: string; position: number; is_won: boolean; is_lost: boolean; requires_human: boolean }>}
        fluxos={((flows ?? []) as Array<{ id: string; name: string }>).map((f) => ({ id: f.id, name: f.name }))}
      />
    </div>
  );
}
