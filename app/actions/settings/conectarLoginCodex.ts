"use server";

/**
 * Conectar a conta do ChatGPT da empresa por login (Sign in with ChatGPT, PKCE
 * com o código colado) — porte enxuto do recurso do repositório oficial (#1639).
 *
 * Fluxo: `iniciarLoginCodex` devolve a URL de autorização e o verificador PKCE
 * (o navegador guarda o verificador; o estado assinado amarra organização,
 * pessoa e nonce). A pessoa entra na conta da OpenAI, é levada a um endereço
 * local que não abre (127.0.0.1:1455) e cola esse endereço de volta.
 * `conectarLoginCodex` confere o estado, gasta o nonce (uso único), troca o
 * código pelos tokens, confere a identidade no `id_token` e guarda cifrado.
 *
 * Só admin da empresa, com a mesma exigência de MFA e de suporte somente-
 * leitura das outras escritas de credencial.
 */
import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { z } from "zod";

import { emitirEstado, verificarEstado } from "@/lib/agenda/google/estado";
import {
  declaracoesDoIdToken,
  desconectarLoginCodex,
  guardarLoginCodex,
  hostIdDaInstalacao,
  lerLoginCodex,
  listarModelosDaConta,
  PROVEDOR_POR_ASSINATURA,
} from "@/lib/ai/credenciais/login-codex";
import {
  CLIENTE_DINAMICO_SIWC,
  criarSessaoPkce,
  gerarNonceSiwc,
  lerRetornoColado,
  trocarCodigoPorTokens,
} from "@/lib/ai/pontos/pkce-da-assinatura";
import { audit } from "@/lib/audit";
import { loadAuthUser, mfaEmDivida, resolveActiveOrg } from "@/lib/auth/server";
import { ROLE_RANK } from "@/lib/auth/types";
import { env } from "@/lib/env";
import { ipDoCliente } from "@/lib/http/ip-do-cliente";
import { supportWriteError } from "@/lib/impersonate/support";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";

type Recusa = { ok: false; error: string };

async function autorizar(): Promise<{ ok: true; userId: string; orgId: string } | Recusa> {
  const authUser = await loadAuthUser();
  if (!authUser) return { ok: false, error: "unauthenticated" };
  const activeOrg = await resolveActiveOrg(authUser);
  if (!activeOrg) return { ok: false, error: "forbidden_tenant" };
  if (ROLE_RANK[activeOrg.role] < ROLE_RANK.admin) return { ok: false, error: "forbidden_role" };
  if (supportWriteError(authUser.support, activeOrg.orgId)) return { ok: false, error: "somente_leitura" };
  if (await mfaEmDivida()) return { ok: false, error: "mfa_required" };
  return { ok: true, userId: authUser.id, orgId: activeOrg.orgId };
}

export async function iniciarLoginCodex(): Promise<{ ok: true; url: string; codeVerifier: string } | Recusa> {
  const a = await autorizar();
  if (!a.ok) return a;
  const nonce = gerarNonceSiwc();
  const estado = emitirEstado(
    { organizationId: a.orgId, userId: a.userId, authSessionId: CLIENTE_DINAMICO_SIWC },
    { segredo: env.INTERNAL_SECRET, agora: new Date(), nonce },
  );
  const sessao = criarSessaoPkce(estado, { nonce, extAgentHostId: hostIdDaInstalacao() });
  return { ok: true, url: sessao.url, codeVerifier: sessao.codeVerifier };
}

const entradaSchema = z.object({
  codigo: z.string().min(1).max(4096),
  codeVerifier: z.string().min(43).max(128),
});

export async function conectarLoginCodex(input: z.infer<typeof entradaSchema>): Promise<{ ok: true } | Recusa> {
  const a = await autorizar();
  if (!a.ok) return a;
  const parsed = entradaSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "invalid_input" };

  const retorno = lerRetornoColado(parsed.data.codigo);
  if (!retorno) return { ok: false, error: "retorno_sem_estado" };
  if (retorno.error === "access_denied") return { ok: false, error: "consentimento_recusado" };
  if (!retorno.code) return { ok: false, error: "retorno_sem_estado" };
  let estado: ReturnType<typeof verificarEstado> = null;
  try {
    estado = verificarEstado(retorno.state, { segredo: env.INTERNAL_SECRET, agora: new Date() });
  } catch {
    estado = null;
  }
  if (!estado || estado.organizationId !== a.orgId || estado.userId !== a.userId) return { ok: false, error: "estado_invalido" };
  // cliente dinâmico: o client_id vem no retorno (é o registro que a OpenAI criou para esta instalação)
  const clientId = estado.authSessionId === CLIENTE_DINAMICO_SIWC ? retorno.clientId : estado.authSessionId;
  if (!clientId || (retorno.clientId && retorno.clientId !== clientId)) return { ok: false, error: "registro_incompleto" };

  const admin = createAdminClient();
  // nonce de uso único: o mesmo retorno colado duas vezes não conecta duas vezes
  const { error: erroDoNonce } = await admin.from("calendar_oauth_nonces").insert({
    nonce: estado.nonce,
    organization_id: a.orgId,
    user_id: a.userId,
    expira_em: new Date(estado.expiraEmMs).toISOString(),
  });
  if (erroDoNonce) return { ok: false, error: erroDoNonce.code === "23505" ? "estado_invalido" : "banco" };

  let tokens: Awaited<ReturnType<typeof trocarCodigoPorTokens>>;
  try {
    tokens = await trocarCodigoPorTokens({ code: retorno.code, codeVerifier: parsed.data.codeVerifier, clientId });
  } catch (erro) {
    logger.warn("[ai.assinatura] troca do código recusada", { organizationId: a.orgId, motivo: (erro as { motivo?: string }).motivo });
    return { ok: false, error: "troca_recusada" };
  }
  if (!tokens.id_token || !tokens.scopes?.includes("chatgpt.tokens.use.direct") || !tokens.scopes.includes("resource.invoke")) {
    return { ok: false, error: "plano_nao_autorizado" };
  }
  const id = declaracoesDoIdToken(tokens.id_token);
  const aud = id?.aud;
  const audOk = typeof aud === "string" ? aud === clientId : Array.isArray(aud) && aud.includes(clientId);
  const subject = typeof id?.sub === "string" ? id.sub : "";
  if (!id || id.iss !== "https://auth.openai.com" || !audOk || id.nonce !== estado.nonce || subject === "") {
    return { ok: false, error: "identidade_invalida" };
  }
  const anterior = await lerLoginCodex({ admin, orgId: a.orgId });
  if (anterior?.subject && anterior.subject !== subject) return { ok: false, error: "conta_diferente" };

  const modelos = await listarModelosDaConta(tokens.access_token).catch((erro) => {
    logger.warn("[ai.assinatura] conta conectada, mas a listagem de modelos falhou", { organizationId: a.orgId, erro: String(erro).slice(0, 120) });
    return [] as string[];
  });
  const gravado = await guardarLoginCodex({
    admin,
    orgId: a.orgId,
    userId: a.userId,
    modelos,
    tokens: {
      ...tokens,
      client_id: clientId,
      subject,
      ...(typeof id.email === "string" ? { email: id.email } : {}),
      ext_agent_host_id: hostIdDaInstalacao(),
      token_type: tokens.token_type ?? "Bearer",
    },
  });
  if (!gravado.ok) return { ok: false, error: gravado.motivo };

  const hdrs = await headers();
  await audit({
    action: "ai.login_codex_conectado",
    actorUserId: a.userId,
    organizationId: a.orgId,
    resourceType: "ai_provider_credential",
    resourceId: gravado.id,
    metadata: { provedor: PROVEDOR_POR_ASSINATURA, modelos: modelos.length },
    requestId: hdrs.get("x-request-id"),
    ip: ipDoCliente(hdrs),
    userAgent: hdrs.get("user-agent"),
  });
  revalidatePath("/app/ai/credentials");
  return { ok: true };
}

export async function desconectarLoginCodexAgora(): Promise<{ ok: true } | Recusa> {
  const a = await autorizar();
  if (!a.ok) return a;
  const admin = createAdminClient();
  const { data: linha } = await admin
    .from("ai_provider_credentials")
    .select("id")
    .eq("organization_id", a.orgId)
    .eq("provider", PROVEDOR_POR_ASSINATURA)
    .maybeSingle();
  if (!(await desconectarLoginCodex({ admin, orgId: a.orgId }))) return { ok: false, error: "banco" };
  if ((linha as { id: string } | null)?.id) {
    const hdrs = await headers();
    await audit({
      action: "ai.login_codex_desconectado",
      actorUserId: a.userId,
      organizationId: a.orgId,
      resourceType: "ai_provider_credential",
      resourceId: (linha as { id: string }).id,
      metadata: { provedor: PROVEDOR_POR_ASSINATURA },
      requestId: hdrs.get("x-request-id"),
      ip: ipDoCliente(hdrs),
      userAgent: hdrs.get("user-agent"),
    });
  }
  revalidatePath("/app/ai/credentials");
  return { ok: true };
}
