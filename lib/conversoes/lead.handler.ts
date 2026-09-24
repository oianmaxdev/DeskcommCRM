/** Reporta o nascimento atribuível sem confundir first-touch com prova causal. */
import type { EventHandler, EventRow, HandlerResult } from "@/lib/event-log/dispatcher";
import { lerProvaMetaCapiLead } from "@/lib/leads/prova-meta-capi-lead";
import { lerCredencial } from "@/lib/plataformas-de-anuncio/credenciais";
import { transporteDe } from "@/lib/plataformas-de-anuncio/registry";
import type { ConversaoOffline, NomeDoEvento } from "@/lib/plataformas-de-anuncio/types";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  claimEnvio,
  concluirClaim,
  jaFoiEnviada,
  liberarClaim,
  registraEnvio,
} from "./registro-de-envio";

const CONSUMER_KEY = "conversoes.lead";
const EVENTO = "Lead" as const satisfies NomeDoEvento;
const PLATAFORMA = "meta_ads" as const;
const ESPERA_PADRAO_MS = 5 * 60 * 1000;

const resultado = (status: HandlerResult["status"], detail?: string): HandlerResult => ({
  consumer_key: CONSUMER_KEY,
  status,
  detail,
});

const retry = (detail: string, emMs = ESPERA_PADRAO_MS): HandlerResult => ({
  consumer_key: CONSUMER_KEY,
  status: "retry",
  retry_at: new Date(Date.now() + emMs).toISOString(),
  detail,
});

async function handle(row: EventRow): Promise<HandlerResult> {
  if (!row.entity_id || row.entity_kind !== "crm_lead") {
    return resultado("skipped", "entidade_invalida");
  }

  const admin = createAdminClient();
  const { data, error } = await admin
    .from("crm_leads")
    .select("id, created_at, contact_id, source_metadata")
    .eq("id", row.entity_id)
    .eq("organization_id", row.organization_id)
    .maybeSingle();
  if (error) return retry(`leitura do lead falhou: ${error.message}`);
  if (!data) return resultado("skipped", "lead_inexistente");

  const lead = data as {
    id: string;
    created_at: string;
    contact_id: string | null;
    source_metadata: unknown;
  };
  const prova = lerProvaMetaCapiLead(lead.source_metadata);
  if (!prova) return resultado("skipped", "missing_birth_attribution");

  if (await jaFoiEnviada(admin, row.organization_id, lead.id, EVENTO)) {
    return resultado("skipped", "ja_enviada");
  }

  let telefone: string | null = null;
  if (lead.contact_id) {
    const { data: contato, error: erroContato } = await admin
      .from("contacts")
      .select("phone_number")
      .eq("id", lead.contact_id)
      .eq("organization_id", row.organization_id)
      .maybeSingle();
    if (erroContato) return retry(`leitura do contato falhou: ${erroContato.message}`);
    telefone = (contato as { phone_number?: string | null } | null)?.phone_number ?? null;
  }

  const eventoId = `${lead.id}:${EVENTO}`;
  const registrar = (status: "skipped" | "error", motivo: string, detalhe?: string) =>
    registraEnvio(admin, {
      organizationId: row.organization_id,
      leadId: lead.id,
      plataforma: PLATAFORMA,
      evento: EVENTO,
      status,
      motivo,
      eventoId,
      detalhe: detalhe ?? null,
    });

  const credencial = await lerCredencial(admin, row.organization_id, PLATAFORMA);
  if (!credencial.ok) {
    await registrar("skipped", credencial.motivo);
    return resultado("skipped", credencial.motivo);
  }

  const transporte = transporteDe(PLATAFORMA);
  if (!transporte) {
    await registrar("skipped", "plataforma_sem_transporte");
    return resultado("skipped", "plataforma_sem_transporte");
  }

  const claim = await claimEnvio(admin, {
    organizationId: row.organization_id,
    leadId: lead.id,
    plataforma: PLATAFORMA,
    evento: EVENTO,
    eventoId,
  });
  if (!claim.adquirido || !claim.token) {
    if (claim.statusAtual === "sent") return resultado("skipped", "ja_enviada");
    return retry(claim.statusAtual === "processing" ? "envio_em_andamento" : "claim_indisponivel");
  }

  const conversao: ConversaoOffline = {
    organizationId: row.organization_id,
    leadId: lead.id,
    evento: EVENTO,
    eventoId,
    ocorridoEm: new Date(lead.created_at),
    cliqueDeOrigem: prova.ctwa_clid,
    telefone,
  };
  const envio = await transporte.enviar(credencial.credencial, conversao);

  if (envio.tipo === "ok") {
    const concluido = await concluirClaim(
      admin,
      {
        organizationId: row.organization_id,
        leadId: lead.id,
        plataforma: PLATAFORMA,
        evento: EVENTO,
        status: "sent",
        motivo: null,
        eventoId,
        detalhe: envio.detalhe ?? null,
      },
      claim.token,
    );
    return concluido ? resultado("ok", "conversão Lead reportada") : retry("settlement_falhou");
  }

  if (envio.tipo === "transitorio") {
    await liberarClaim(
      admin,
      { organizationId: row.organization_id, leadId: lead.id, evento: EVENTO },
      claim.token,
      envio.detalhe,
    );
    return retry(envio.detalhe, envio.tentarEmMs);
  }

  const concluido = await concluirClaim(
    admin,
    {
      organizationId: row.organization_id,
      leadId: lead.id,
      plataforma: PLATAFORMA,
      evento: EVENTO,
      status: "error",
      motivo: "recusado_pela_plataforma",
      eventoId,
      detalhe: envio.detalhe,
    },
    claim.token,
  );
  return concluido ? resultado("error", envio.detalhe) : retry("settlement_falhou");
}

export const conversaoDeLeadHandler: EventHandler = {
  key: CONSUMER_KEY,
  events: ["lead.created"],
  handle,
};
