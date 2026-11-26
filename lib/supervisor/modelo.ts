/**
 * Qual modelo o Supervisor usa quando ninguém escolheu um para o ponto.
 *
 * `resolverModeloDoPonto` honra o binding do painel de provedores e, sem ele,
 * tenta o id padrão do ponto — que é de UM provedor. A organização que conectou
 * só outro provedor (medido na homologação: credencial do Google, padrão da
 * Anthropic) recebia `null`, e o Supervisor ficava parado sem dizer por quê.
 *
 * O degrau a mais é o mesmo critério do resto do produto: o modelo padrão do
 * provedor que a organização conectou, lido do catálogo (`ai_models`). Nenhum
 * id de modelo é escrito aqui.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import type { ModelId } from "@/lib/ai/gateway";
import { resolverModeloDoPonto, type ModeloResolvido } from "@/lib/ai/gateway-binding";
import { lerLoginCodexRenovandoSeProxima } from "@/lib/ai/credenciais/login-codex";
import { PROVEDOR_POR_ASSINATURA } from "@/lib/ai/pontos/provedores";
import { modeloDaAssinatura as instanciarModeloDaAssinatura } from "@/lib/ai/credenciais/modelo-da-assinatura";

/**
 * A conta do ChatGPT conectada por login (provider `openai-assinatura`): o
 * token do login faz as vezes da chave, e a chamada vai à API pública da
 * OpenAI — cobrada da assinatura de quem conectou. Conta conectada vence as
 * chaves (é a escolha mais recente e explícita do admin) só no Supervisor: o
 * resto do produto, neste porte, não fala a assinatura, por isso
 * `settings.llm.provider` não é tocado. Sem token utilizável devolve null e a
 * escada segue para as chaves.
 */
async function modeloDaAssinatura(admin: SupabaseClient, orgId: string, escolhido?: string): Promise<ModeloResolvido | null> {
  const { data: org } = await admin.from("organizations").select("settings").eq("id", orgId).maybeSingle();
  const llm = ((org as { settings?: { llm?: { modelo_da_assinatura?: string } } } | null)?.settings?.llm) ?? {};
  const tokens = await lerLoginCodexRenovandoSeProxima({ admin: admin as never, orgId }).catch(() => null);
  if (!tokens) return null;
  const modelId = escolherModeloDaAssinatura(await modelosDaAssinatura({ admin, orgId }), escolhido ?? llm.modelo_da_assinatura);
  if (!modelId) return null;
  const model = instanciarModeloDaAssinatura(tokens.access_token, modelId);
  return { model, modelId: `openai/${modelId}`, origem: "credencial_da_organizacao", provider: PROVEDOR_POR_ASSINATURA };
}

/**
 * Qual modelo da conta o Supervisor usa. Puro.
 *
 * Escolha explícita é obedecida ou nada: se a conta não tem o modelo escolhido,
 * devolve null em vez de trocar em silêncio por outro — trocar de modelo muda
 * custo e qualidade sem ninguém ter pedido. Sem escolha, a preferência abaixo;
 * sem nada dela, o primeiro.
 */
const PREFERENCIA = [/^gpt-5(\.\d+)?-mini$/, /^gpt-5(\.\d+)?$/, /^gpt-5/, /^gpt-4\.1/, /^o\d/];
export function escolherModeloDaAssinatura(disponiveis: readonly string[], escolhido?: string | null): string | null {
  if (escolhido) return disponiveis.includes(escolhido) ? escolhido : null;
  for (const re of PREFERENCIA) {
    const achado = disponiveis.filter((m) => re.test(m)).sort().reverse()[0];
    if (achado) return achado;
  }
  return disponiveis[0] ?? null;
}

/** Os modelos que a conta conectada enxerga — gravados pela listagem oficial (`listarModelosDaAssinatura`). */
async function modelosDaAssinatura({ admin, orgId }: { admin: SupabaseClient; orgId: string }): Promise<string[]> {
  const { data } = await admin
    .from("ai_provider_credentials")
    .select("models_available")
    .eq("organization_id", orgId)
    .eq("provider", PROVEDOR_POR_ASSINATURA)
    .eq("is_active", true)
    .maybeSingle();
  return ((data as { models_available: string[] | null } | null)?.models_available ?? []).filter((m) => typeof m === "string");
}

export async function resolverModeloDoSupervisor(
  admin: SupabaseClient,
  ponto: "supervisor_observe" | "supervisor_diagnose",
  orgId: string,
  padrao: ModelId,
): Promise<ModeloResolvido | null> {
  // 1. A escolha da aba Configuração do Supervisor (vínculo do ponto) vence tudo.
  //    Escolha que não dá para cumprir devolve null — o Supervisor para e diz
  //    "sem modelo"; trocar em silêncio por outro mudaria custo e qualidade
  //    sem ninguém ter pedido.
  const { data: vinculo } = await admin
    .from("ai_purpose_bindings")
    .select("provider, model_id")
    .eq("organization_id", orgId)
    .eq("purpose", ponto)
    .eq("is_enabled", true)
    .maybeSingle();
  const escolha = vinculo as { provider: string; model_id: string } | null;
  if (escolha?.provider === PROVEDOR_POR_ASSINATURA) return modeloDaAssinatura(admin, orgId, escolha.model_id);
  if (escolha) return resolverModeloDoPonto(ponto, orgId, padrao);

  // 2. Sem escolha: a conta ChatGPT conectada, depois as chaves.
  const daAssinatura = await modeloDaAssinatura(admin, orgId);
  if (daAssinatura) return daAssinatura;

  const direto = await resolverModeloDoPonto(ponto, orgId, padrao);
  if (direto) return direto;

  const { data: cred } = await admin
    .from("ai_provider_credentials")
    .select("provider")
    .eq("organization_id", orgId)
    .eq("is_active", true)
    .neq("provider", PROVEDOR_POR_ASSINATURA)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  const provider = (cred as { provider: string } | null)?.provider;
  if (!provider) return null;

  const { data: modelo } = await admin
    .from("ai_models")
    .select("model_id")
    .eq("provider", provider)
    .eq("is_default_for_provider", true)
    .is("deprecated_at", null)
    .limit(1)
    .maybeSingle();
  const modelId = (modelo as { model_id: string } | null)?.model_id;
  if (!modelId) return null;
  return resolverModeloDoPonto(ponto, orgId, `${provider}/${modelId}` as ModelId);
}
