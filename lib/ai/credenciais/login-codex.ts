/**
 * A conta do ChatGPT da EMPRESA, conectada por login (Sign in with ChatGPT, PKCE)
 * em vez de chave de API — porte enxuto do recurso do repositório oficial
 * (#1639), feito na branch da Feature C para o Supervisor poder rodar sobre a
 * assinatura. Os caminhos de arquivo seguem os do upstream de propósito: na
 * integração, este arquivo é SUBSTITUÍDO pelo de lá, não mesclado.
 *
 * O par de tokens vive em `ai_provider_credentials` como uma credencial comum
 * (provider `openai-assinatura`), cifrado com a mesma AES-GCM das chaves: o
 * JSON dos tokens ocupa o lugar da chave. Nada de tabela nova.
 *
 * Renovação: o access_token é curto. Antes de usar, quem lê pede
 * `lerLoginCodexRenovandoSeProxima`, que troca o refresh_token quando faltam
 * menos de 5 minutos. A gravação do par novo é condicionada ao `updated_at`
 * lido: se outro processo renovou no meio, este relê em vez de sobrescrever
 * (refresh_token rotaciona — gravar o par velho por cima perderia a conta).
 */
import { createHash } from "node:crypto";

import type { SupabaseClient } from "@supabase/supabase-js";

import { bufToBytea, byteaToBuffer, decryptKey, encryptKey } from "@/lib/crypto/aes_gcm";
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";
import { CLIENTE_DINAMICO_SIWC, renovarPorRefreshToken, type TokensDoCodex } from "@/lib/ai/pontos/pkce-da-assinatura";

export const PROVEDOR_POR_ASSINATURA = "openai-assinatura";
/** Inferência e catálogo da assinatura usam a API pública da OpenAI com o token do login. */
export const ENDPOINT_DA_ASSINATURA = "https://api.openai.com/v1";
const ROTULO = "Conta ChatGPT";
const RENOVAR_FALTANDO_MS = 5 * 60 * 1000;

/**
 * Identidade estável DESTA instalação para o SIWC (`ext_agent_host_id`). O
 * upstream guarda um uuid numa tabela da plataforma; aqui ele é derivado do
 * segredo da instalação — mesmo valor em toda chamada, sem migration.
 */
export function hostIdDaInstalacao(): string {
  const h = createHash("sha256").update(`siwc-host:${env.INTERNAL_SECRET}`).digest("hex");
  return `urn:uuid:${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

interface Linha {
  id: string;
  api_key_encrypted: unknown;
  api_key_iv: unknown;
  api_key_tag: unknown;
  updated_at: string;
  models_available: string[] | null;
}

async function linhaDaEmpresa(admin: SupabaseClient, orgId: string): Promise<Linha | null> {
  const { data } = await admin
    .from("ai_provider_credentials")
    .select("id, api_key_encrypted, api_key_iv, api_key_tag, updated_at, models_available")
    .eq("organization_id", orgId)
    .eq("provider", PROVEDOR_POR_ASSINATURA)
    .eq("is_active", true)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  return (data as Linha | null) ?? null;
}

function abrir(l: Linha): TokensDoCodex | null {
  try {
    const t = JSON.parse(
      decryptKey({ ciphertext: byteaToBuffer(l.api_key_encrypted), iv: byteaToBuffer(l.api_key_iv), tag: byteaToBuffer(l.api_key_tag) }),
    ) as TokensDoCodex;
    return typeof t.access_token === "string" && typeof t.refresh_token === "string" ? t : null;
  } catch {
    return null;
  }
}

function cifrar(t: TokensDoCodex) {
  const e = encryptKey(JSON.stringify(t));
  return { api_key_encrypted: bufToBytea(e.ciphertext), api_key_iv: bufToBytea(e.iv), api_key_tag: bufToBytea(e.tag) };
}

export async function lerLoginCodex(entrada: { admin: SupabaseClient; orgId: string }): Promise<TokensDoCodex | null> {
  const l = await linhaDaEmpresa(entrada.admin, entrada.orgId);
  return l ? abrir(l) : null;
}

export async function modelosDaAssinatura(entrada: { admin: SupabaseClient; orgId: string }): Promise<string[]> {
  return (await linhaDaEmpresa(entrada.admin, entrada.orgId))?.models_available ?? [];
}

/** Grava (ou substitui) a conta da empresa. Uma conta por empresa. */
export async function guardarLoginCodex(entrada: {
  admin: SupabaseClient;
  orgId: string;
  userId: string;
  tokens: TokensDoCodex;
  modelos: string[];
}): Promise<{ ok: true; id: string } | { ok: false; motivo: string }> {
  const sufixo = (entrada.tokens.email ?? entrada.tokens.subject ?? "chatgpt").slice(-4);
  const linha = {
    organization_id: entrada.orgId,
    provider: PROVEDOR_POR_ASSINATURA,
    label: ROTULO,
    ...cifrar(entrada.tokens),
    api_key_last4: sufixo,
    validated_at: new Date().toISOString(),
    validation_error: null,
    models_available: entrada.modelos,
    is_active: true,
    created_by: entrada.userId,
    updated_at: new Date().toISOString(),
  };
  const { data, error } = await entrada.admin
    .from("ai_provider_credentials")
    .upsert(linha, { onConflict: "organization_id,provider,label" })
    .select("id")
    .single();
  if (error) return { ok: false, motivo: "banco" };
  return { ok: true, id: (data as { id: string }).id };
}

export async function desconectarLoginCodex(entrada: { admin: SupabaseClient; orgId: string }): Promise<boolean> {
  const { error } = await entrada.admin
    .from("ai_provider_credentials")
    .delete()
    .eq("organization_id", entrada.orgId)
    .eq("provider", PROVEDOR_POR_ASSINATURA);
  return !error;
}

/** Os tokens prontos para uso — renovados antes, se o access_token está para vencer. Nunca lança. */
export async function lerLoginCodexRenovandoSeProxima(entrada: {
  admin: SupabaseClient;
  orgId: string;
  agora?: Date;
}): Promise<TokensDoCodex | null> {
  const agora = (entrada.agora ?? new Date()).getTime();
  for (let tentativa = 0; tentativa < 2; tentativa++) {
    const l = await linhaDaEmpresa(entrada.admin, entrada.orgId);
    const t = l ? abrir(l) : null;
    if (!l || !t) return null;
    if (t.expires_at === null || t.expires_at - agora > RENOVAR_FALTANDO_MS) return t;
    try {
      const novo = await renovarPorRefreshToken({ refreshToken: t.refresh_token, clientId: t.client_id ?? CLIENTE_DINAMICO_SIWC });
      const juntos: TokensDoCodex = { ...t, ...novo, client_id: t.client_id, subject: t.subject, email: t.email, ext_agent_host_id: t.ext_agent_host_id };
      const { data } = await entrada.admin
        .from("ai_provider_credentials")
        .update({ ...cifrar(juntos), updated_at: new Date().toISOString(), validation_error: null })
        .eq("organization_id", entrada.orgId)
        .eq("id", l.id)
        .eq("updated_at", l.updated_at)
        .select("id");
      if ((data ?? []).length > 0) return juntos;
      // outro processo renovou no meio: relê o par que ELE gravou
    } catch (erro) {
      logger.warn("[ai.assinatura] renovação do token falhou", {
        organizationId: entrada.orgId,
        motivo: (erro as { motivo?: string }).motivo ?? "desconhecido",
      });
      await entrada.admin
        .from("ai_provider_credentials")
        .update({ validation_error: "renovação do login falhou — conecte a conta de novo" })
        .eq("organization_id", entrada.orgId)
        .eq("id", l.id);
      return null;
    }
  }
  return null;
}

/**
 * Modelos que a conta enxerga (GET /v1/models com o token do login). A resposta
 * SIWC vem como `{ models: [{ slug, visibility }] }` (forma que o upstream lê);
 * a forma clássica `{ data: [{ id }] }` também é aceita.
 */
export async function listarModelosDaConta(accessToken: string): Promise<string[]> {
  const r = await fetch(`${ENDPOINT_DA_ASSINATURA}/models`, {
    headers: { authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(15_000),
    redirect: "error",
    cache: "no-store",
  });
  if (!r.ok) throw new Error(`listagem de modelos recusada (${r.status})`);
  const j = (await r.json()) as {
    models?: Array<{ slug?: unknown; id?: unknown; visibility?: unknown }>;
    data?: Array<{ id?: unknown }>;
  };
  const ids = Array.isArray(j.models)
    ? j.models
        .filter((m) => m.visibility === undefined || m.visibility === "list")
        .map((m) => (typeof m.slug === "string" ? m.slug : m.id))
    : (j.data ?? []).map((m) => m.id);
  return [...new Set(ids.filter((id): id is string => typeof id === "string"))].sort();
}

/**
 * Qual modelo da conta o Supervisor usa. Puro.
 *
 * Escolha explícita (`settings.llm.modelo_da_assinatura`) é obedecida ou nada:
 * se a conta não tem o modelo escolhido, devolve null em vez de trocar em
 * silêncio por outro — trocar de modelo muda custo e qualidade sem ninguém ter
 * pedido. Sem escolha, a preferência abaixo; sem nada dela, o primeiro.
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

/**
 * Lê as declarações do `id_token` SEM verificar a assinatura. É seguro só porque
 * o token chega DIRETO do endpoint de token da OpenAI, por TLS, em troca do
 * nosso código + verificador (OIDC Core §3.1.3.7). Nunca use para token vindo
 * do navegador.
 */
export function declaracoesDoIdToken(idToken: string): Record<string, unknown> | null {
  const partes = idToken.split(".");
  if (partes.length !== 3) return null;
  try {
    return JSON.parse(Buffer.from(partes[1]!, "base64url").toString("utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}
