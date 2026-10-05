/** Conversão do nascimento causado pela mensagem CTWA atual. */
import type { EventHandler, EventRow, HandlerResult } from "@/lib/event-log/dispatcher";
import { lerProvaMetaLeadSubmitted } from "@/lib/leads/prova-meta-lead-submitted";
import { lerCredencial } from "@/lib/plataformas-de-anuncio/credenciais";
import { transporteDe } from "@/lib/plataformas-de-anuncio/registry";
import { createAdminClient } from "@/lib/supabase/admin";

const KEY = "conversoes.nascimento_meta";
const ESPERA_MS = 5 * 60 * 1000;

function resultado(status: HandlerResult["status"], detail?: string): HandlerResult {
  return { consumer_key: KEY, status, detail };
}
function retry(detail: string): HandlerResult {
  return {
    consumer_key: KEY,
    status: "retry",
    retry_at: new Date(Date.now() + ESPERA_MS).toISOString(),
    detail,
  };
}

async function handle(row: EventRow): Promise<HandlerResult> {
  if (row.entity_kind !== "crm_lead" || !row.entity_id)
    return resultado("skipped", "entidade_invalida");
  if (
    row.event_type === "ad_conversion.retry_requested" &&
    row.payload.event_name !== "LeadSubmitted"
  )
    return resultado("skipped", "outro_evento");
  if (row.event_type !== "lead.created" && row.event_type !== "ad_conversion.retry_requested")
    return resultado("skipped", "outro_evento");

  const admin = createAdminClient();
  try {
    const { data: lead, error: leadError } = await admin
      .from("crm_leads")
      .select("id,contact_id,created_at,source_metadata")
      .eq("organization_id", row.organization_id)
      .eq("id", row.entity_id)
      .maybeSingle();
    if (leadError) return retry("leitura_do_lead");
    if (!lead) return resultado("skipped", "lead_inexistente");
    const prova = lerProvaMetaLeadSubmitted(lead.source_metadata);
    if (!prova) return resultado("skipped", "sem_prova_causal");
    if (!lead.contact_id) return resultado("skipped", "sem_contato");

    const { data: mensagem, error: messageError } = await admin
      .from("messages")
      .select("direction,contact_id,conversation_id,metadata")
      .eq("organization_id", row.organization_id)
      .eq("id", prova.message_id)
      .maybeSingle();
    if (messageError) return retry("leitura_da_mensagem");
    const ancora = (mensagem?.metadata as Record<string, unknown> | null)?.meta_ctwa_message_v1;
    if (
      !mensagem ||
      mensagem.direction !== "inbound" ||
      mensagem.contact_id !== lead.contact_id ||
      mensagem.conversation_id !== prova.conversation_id ||
      !ancora ||
      typeof ancora !== "object" ||
      (ancora as Record<string, unknown>).platform !== "meta_ads" ||
      (ancora as Record<string, unknown>).source_type !== "ad" ||
      (ancora as Record<string, unknown>).ctwa_clid !== prova.ctwa_clid
    )
      return resultado("skipped", "prova_nao_confere_com_mensagem");

    const { data: contato, error: contactError } = await admin
      .from("contacts")
      .select("phone_number")
      .eq("organization_id", row.organization_id)
      .eq("id", lead.contact_id)
      .maybeSingle();
    if (contactError) return retry("leitura_do_contato");

    const { data: claim, error: claimError } = await admin.rpc("fn_claim_meta_lead_submitted", {
      p_org: row.organization_id,
      p_lead: lead.id,
    });
    if (claimError) return retry("claim_indisponivel");
    const posse = claim as { acquired?: boolean; token?: string; status?: string } | null;
    if (!posse?.acquired || !posse.token) {
      if (posse?.status === "busy") return retry("lease_vigente");
      return resultado("skipped", posse?.status === "sent" ? "ja_enviada" : "sem_prova_causal");
    }

    const concluir = async (
      status: "sent" | "skipped" | "error",
      reason: string | null,
      detail: string | null,
    ): Promise<HandlerResult> => {
      const { data, error } = await admin.rpc("fn_settle_meta_lead_submitted", {
        p_org: row.organization_id,
        p_lead: lead.id,
        p_token: posse.token,
        p_status: status,
        p_reason: reason,
        p_detail: detail,
      });
      if (error || data !== true) return retry("settlement_indisponivel");
      return resultado(
        status === "sent" ? "ok" : status === "error" ? "error" : "skipped",
        reason ?? undefined,
      );
    };

    const credencial = await lerCredencial(admin, row.organization_id, "meta_ads", {
      exigirAcaoDeVenda: false,
    });
    if (!credencial.ok) {
      if (credencial.motivo === "leitura_indisponivel") {
        const settled = await concluir("skipped", "nova_tentativa_agendada", credencial.motivo);
        return settled.status === "skipped" ? retry(credencial.motivo) : settled;
      }
      return await concluir("skipped", credencial.motivo, null);
    }
    const transporte = transporteDe("meta_ads");
    if (!transporte) return await concluir("skipped", "plataforma_sem_transporte", null);

    const envio = await transporte.enviar(credencial.credencial, {
      organizationId: row.organization_id,
      leadId: lead.id,
      evento: "LeadSubmitted",
      eventoNaPlataforma: "LeadSubmitted",
      eventoId: `${lead.id}:LeadSubmitted`,
      ocorridoEm: new Date(lead.created_at),
      cliqueDeOrigem: prova.ctwa_clid,
      telefone: contato?.phone_number ?? null,
      valorCentavos: null,
      moeda: "",
    });
    if (envio.tipo === "transitorio" || envio.tipo === "processando") {
      const motivo = envio.tipo === "processando" ? "aguardando_processamento" : "nova_tentativa_agendada";
      const settled = await concluir("skipped", motivo, envio.detalhe);
      return settled.status === "skipped" ? retry(motivo) : settled;
    }
    if (envio.tipo === "permanente")
      return await concluir("error", "recusado_pela_plataforma", envio.detalhe);
    return await concluir(
      credencial.credencial.testEventCode ? "skipped" : "sent",
      credencial.credencial.testEventCode ? "evento_de_teste" : null,
      null,
    );
  } catch {
    // Lease expira se houve crash/erro; o mesmo event_id cobre o replay remoto.
    return retry("falha_no_processamento");
  }
}

export const conversaoDeNascimentoMetaHandler: EventHandler = {
  key: KEY,
  naOrgParada: "pula",
  events: ["lead.created", "ad_conversion.retry_requested"],
  handle,
};
