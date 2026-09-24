/**
 * O livro-razão dos envios de conversão — idempotência e superfície, na mesma
 * tabela e de propósito.
 *
 * ─── Por que uma linha por (lead, evento), e não um histórico ───────────────
 *
 * A tela precisa responder "quais vendas de anúncio não foram reportadas, e por
 * quê". Um histórico append-only responderia isso com um GROUP BY e cresceria
 * para sempre; o índice único `(organization_id, lead_id, event_name)` da 0204
 * faz a mesma pergunta virar um SELECT com WHERE. O que se perde é a sequência
 * de tentativas — e ela já vive no `event_log`, que é onde histórico mora.
 *
 * ─── Por que `sent` nunca é rebaixado ───────────────────────────────────────
 *
 * Uma venda reportada não "desreporta". Se o lead mudar de etapa de novo meses
 * depois, o handler passa por aqui outra vez; sem a guarda, o upsert trocaria
 * `sent` por `skipped` e a próxima passagem acharia que nunca foi enviado — e
 * mandaria a MESMA venda de novo. Contar a venda duas vezes é o pior desfecho
 * possível, porque a plataforma aceita, o otimizador age sobre o número errado
 * e nada na tela denuncia.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { logger } from "@/lib/logger";
import type { NomeDoEvento, PlataformaDeAnuncio } from "@/lib/plataformas-de-anuncio/types";

export type StatusDeEnvio = "sent" | "skipped" | "error";

export interface ClaimDeEnvio {
  adquirido: boolean;
  token: string | null;
  statusAtual: string;
}

export interface RegistroDeEnvio {
  organizationId: string;
  leadId: string;
  plataforma: PlataformaDeAnuncio;
  evento: NomeDoEvento;
  status: StatusDeEnvio;
  /** Slug estável. A tela traduz; o banco guarda o slug. */
  motivo: string | null;
  eventoId: string | null;
  valorCentavos?: number | null;
  moeda?: string | null;
  detalhe?: string | null;
}

/** Já foi reportada com sucesso? Guarda de idempotência, lida antes de tudo. */
export async function jaFoiEnviada(
  admin: SupabaseClient,
  organizationId: string,
  leadId: string,
  evento: NomeDoEvento,
): Promise<boolean> {
  const { data } = await admin
    .from("ad_conversion_dispatches")
    .select("status")
    .eq("organization_id", organizationId)
    .eq("lead_id", leadId)
    .eq("event_name", evento)
    .maybeSingle();

  return (data as { status?: string } | null)?.status === "sent";
}

/** Claim atômico imediatamente antes da chamada HTTP. */
export async function claimEnvio(
  admin: SupabaseClient,
  registro: Pick<
    RegistroDeEnvio,
    "organizationId" | "leadId" | "plataforma" | "evento" | "eventoId"
  >,
  leaseSeconds = 60,
): Promise<ClaimDeEnvio> {
  const { data, error } = await admin.rpc(
    "fn_claim_ad_conversion_dispatch" as never,
    {
      p_org: registro.organizationId,
      p_lead: registro.leadId,
      p_platform: registro.plataforma,
      p_event_name: registro.evento,
      p_event_id: registro.eventoId,
      p_lease_seconds: leaseSeconds,
    } as never,
  );
  if (error) {
    logger.error("[conversoes.registro] falha ao adquirir claim", {
      organizationId: registro.organizationId,
      leadId: registro.leadId,
      evento: registro.evento,
      error: error.message,
    });
    return { adquirido: false, token: null, statusAtual: "claim_error" };
  }

  const bruto = Array.isArray(data) ? data[0] : data;
  const linha = (bruto ?? {}) as {
    acquired?: boolean;
    token?: string | null;
    current_status?: string;
  };
  return {
    adquirido: linha.acquired === true && typeof linha.token === "string",
    token: typeof linha.token === "string" ? linha.token : null,
    statusAtual: linha.current_status ?? "indisponivel",
  };
}

/** Settlement só vence com o token que adquiriu o claim. */
export async function concluirClaim(
  admin: SupabaseClient,
  registro: RegistroDeEnvio,
  claimToken: string,
): Promise<boolean> {
  const { data, error } = await admin.rpc(
    "fn_settle_ad_conversion_dispatch" as never,
    {
      p_org: registro.organizationId,
      p_lead: registro.leadId,
      p_event_name: registro.evento,
      p_claim_token: claimToken,
      p_status: registro.status,
      p_reason: registro.motivo,
      p_detail: registro.detalhe ?? null,
      p_value_cents: registro.valorCentavos ?? null,
      p_currency: registro.moeda ?? null,
    } as never,
  );
  if (error || data !== true) {
    logger.error("[conversoes.registro] settlement recusado", {
      organizationId: registro.organizationId,
      leadId: registro.leadId,
      evento: registro.evento,
      error: error?.message ?? "claim_token_incorreto",
    });
    return false;
  }
  return true;
}

/** Libera o lease de uma falha transitória para o drain retomar. */
export async function liberarClaim(
  admin: SupabaseClient,
  registro: Pick<RegistroDeEnvio, "organizationId" | "leadId" | "evento">,
  claimToken: string,
  detalhe: string,
): Promise<boolean> {
  const { data, error } = await admin.rpc(
    "fn_release_ad_conversion_dispatch" as never,
    {
      p_org: registro.organizationId,
      p_lead: registro.leadId,
      p_event_name: registro.evento,
      p_claim_token: claimToken,
      p_detail: detalhe,
    } as never,
  );
  return !error && data === true;
}

/**
 * Grava o desfecho. Falha aqui NÃO derruba o envio que já aconteceu — mas é
 * contada, porque um livro-razão que perde linha em silêncio deixa de servir
 * para as três coisas que ele existe para fazer.
 */
export async function registraEnvio(
  admin: SupabaseClient,
  registro: RegistroDeEnvio,
): Promise<void> {
  if (registro.status === "sent") {
    logger.error("[conversoes.registro] sent exige claim", {
      organizationId: registro.organizationId,
      leadId: registro.leadId,
      evento: registro.evento,
    });
    return;
  }

  const { error } = await admin.rpc(
    "fn_record_ad_conversion_outcome" as never,
    {
      p_org: registro.organizationId,
      p_lead: registro.leadId,
      p_platform: registro.plataforma,
      p_event_name: registro.evento,
      p_event_id: registro.eventoId,
      p_status: registro.status,
      p_reason: registro.motivo,
      p_detail: registro.detalhe ?? null,
      p_value_cents: registro.valorCentavos ?? null,
      p_currency: registro.moeda ?? null,
    } as never,
  );

  if (error) {
    logger.error("[conversoes.registro] falha ao gravar livro-razão", {
      organizationId: registro.organizationId,
      leadId: registro.leadId,
      status: registro.status,
      error: error.message,
    });
  }
}
