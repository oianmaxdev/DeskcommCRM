/**
 * Qual modelo de IA o Supervisor usa — a escolha e as opções, para a aba
 * Configuração.
 *
 * Não há armazenamento novo: a escolha É o vínculo por ponto que o produto já
 * tem (`ai_purpose_bindings`), gravado nos dois pontos do Supervisor
 * (`supervisor_observe` e `supervisor_diagnose`) pela mesma rota da tela de
 * Provedores, com a mesma validação e auditoria. Esta leitura só junta, para
 * a tela, o que está valendo e o que dá para escolher.
 *
 * Opções = provedores com credencial ATIVA e VALIDADA desta organização (o
 * mesmo critério da resolução: oferecer provedor sem chave seria oferecer uma
 * escolha que morre na primeira chamada) + a conta ChatGPT, se conectada.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { PROVEDORES, PROVEDOR_POR_ASSINATURA } from "@/lib/ai/pontos/provedores";

export const PONTOS_DO_SUPERVISOR = ["supervisor_observe", "supervisor_diagnose"] as const;

export interface EscolhaDoSupervisor {
  provider: string;
  model_id: string;
  credential_id: string | null;
}

export interface OpcaoDeProvedor {
  provider: string;
  rotulo: string;
  credential_id: string;
  modelos: Array<{ id: string; nome: string; padrao: boolean }>;
}

export interface ModeloDoSupervisor {
  /** null = automático (o padrão da organização / a conta conectada). */
  escolha: EscolhaDoSupervisor | null;
  /** Leitura e diagnóstico com vínculos diferentes (feito na tela de Provedores). */
  divergente: boolean;
  opcoes: OpcaoDeProvedor[];
}

const ROTULO = new Map<string, string>([
  ...PROVEDORES.map((p) => [p.id as string, p.rotulo] as [string, string]),
  [PROVEDOR_POR_ASSINATURA, "OpenAI pela assinatura (ChatGPT)"],
]);

export async function lerModeloDoSupervisor(admin: SupabaseClient, orgId: string): Promise<ModeloDoSupervisor> {
  const [{ data: vinculos }, { data: creds }] = await Promise.all([
    admin
      .from("ai_purpose_bindings")
      .select("purpose, provider, model_id, credential_id")
      .eq("organization_id", orgId)
      .eq("is_enabled", true)
      .in("purpose", [...PONTOS_DO_SUPERVISOR]),
    admin
      .from("ai_provider_credentials")
      .select("id, provider, models_available, created_at")
      .eq("organization_id", orgId)
      .eq("is_active", true)
      .not("validated_at", "is", null)
      .order("created_at", { ascending: false }),
  ]);
  const porPonto = new Map(((vinculos ?? []) as Array<EscolhaDoSupervisor & { purpose: string }>).map((v) => [v.purpose, v]));
  const ler = porPonto.get("supervisor_observe") ?? null;
  const diag = porPonto.get("supervisor_diagnose") ?? null;
  const chave = (v: EscolhaDoSupervisor | null) => (v ? `${v.provider}|${v.model_id}` : "");
  const escolha = ler ?? diag;

  // uma credencial por provedor: a mais recente
  const credPorProvedor = new Map<string, { id: string; models_available: string[] | null }>();
  for (const c of (creds ?? []) as Array<{ id: string; provider: string; models_available: string[] | null }>) {
    if (!credPorProvedor.has(c.provider) && ROTULO.has(c.provider)) credPorProvedor.set(c.provider, c);
  }
  const doCatalogo = [...credPorProvedor.keys()].filter((p) => p !== PROVEDOR_POR_ASSINATURA);
  const { data: catalogo } = doCatalogo.length
    ? await admin
        .from("ai_models")
        .select("provider, model_id, display_name, is_default_for_provider")
        .in("provider", doCatalogo)
        .is("deprecated_at", null)
        .order("is_default_for_provider", { ascending: false })
        .order("display_name", { ascending: true })
    : { data: [] };

  const opcoes: OpcaoDeProvedor[] = [...credPorProvedor.entries()].map(([provider, cred]) => ({
    provider,
    rotulo: ROTULO.get(provider)!,
    credential_id: cred.id,
    modelos:
      provider === PROVEDOR_POR_ASSINATURA
        ? (cred.models_available ?? []).map((id) => ({ id, nome: id, padrao: false }))
        : ((catalogo ?? []) as Array<{ provider: string; model_id: string; display_name: string; is_default_for_provider: boolean }>)
            .filter((m) => m.provider === provider)
            .map((m) => ({ id: m.model_id, nome: m.display_name || m.model_id, padrao: m.is_default_for_provider })),
  }));

  return {
    escolha: escolha ? { provider: escolha.provider, model_id: escolha.model_id, credential_id: escolha.credential_id } : null,
    divergente: Boolean(ler && diag) && chave(ler) !== chave(diag),
    opcoes,
  };
}
