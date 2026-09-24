/**
 * Prova causal reservada do nascimento de um lead por Click-to-WhatsApp.
 *
 * Ela mora no snapshot do LEAD, não no contato: first-touch explica de onde o
 * relacionamento veio, mas não prova que um negócio criado hoje nasceu da
 * mensagem que trouxe aquele clique. Só a RPC de nascimento automático cria
 * esta chave; bordas genéricas removem-na de entrada e saída.
 */
export const CHAVE_DA_PROVA_META_CAPI_LEAD = "meta_capi_lead_birth_v1" as const;

export interface ProvaMetaCapiLead {
  platform: "meta_ads";
  source_type: "ad";
  ctwa_clid: string;
  message_id: string;
  conversation_id: string;
  captured_at: string;
}

function objeto(valor: unknown): Record<string, unknown> | null {
  return valor !== null && typeof valor === "object" && !Array.isArray(valor)
    ? (valor as Record<string, unknown>)
    : null;
}

function texto(valor: unknown): string | null {
  return typeof valor === "string" && valor.trim() !== "" ? valor : null;
}

export function lerProvaMetaCapiLead(sourceMetadata: unknown): ProvaMetaCapiLead | null {
  const metadata = objeto(sourceMetadata);
  const prova = objeto(metadata?.[CHAVE_DA_PROVA_META_CAPI_LEAD]);
  if (!prova || prova.platform !== "meta_ads" || prova.source_type !== "ad") return null;

  const ctwaClid = texto(prova.ctwa_clid);
  const messageId = texto(prova.message_id);
  const conversationId = texto(prova.conversation_id);
  const capturedAt = texto(prova.captured_at);
  if (!ctwaClid || !messageId || !conversationId || !capturedAt) return null;
  if (!Number.isFinite(Date.parse(capturedAt))) return null;

  return {
    platform: "meta_ads",
    source_type: "ad",
    ctwa_clid: ctwaClid,
    message_id: messageId,
    conversation_id: conversationId,
    captured_at: capturedAt,
  };
}

/** Remove a chave reservada sem mutar o objeto recebido. */
export function removerProvaMetaCapiLead(sourceMetadata: unknown): Record<string, unknown> {
  const metadata = objeto(sourceMetadata);
  if (!metadata) return {};
  const { [CHAVE_DA_PROVA_META_CAPI_LEAD]: _reservada, ...publico } = metadata;
  return publico;
}

/** Sanitiza uma linha antes de atravessar uma borda de API/MCP/browser. */
export function ocultarProvaMetaCapiLead<T extends Record<string, unknown>>(lead: T): T {
  if (!("source_metadata" in lead)) return lead;
  return { ...lead, source_metadata: removerProvaMetaCapiLead(lead.source_metadata) };
}
