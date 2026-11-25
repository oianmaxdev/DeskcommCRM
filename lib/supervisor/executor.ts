/**
 * O EXECUTOR — aplica UMA ação já decidida pela política, pelo mesmo caminho que
 * o CRM já usa para aquela mutação.
 *
 * Nada aqui decide se deve agir: isso é `politica.ts`. Aqui só se decide se
 * AINDA é possível agir — o mundo pode ter mudado entre a leitura e a escrita
 * (o vendedor arrastou o card, preencheu o campo, fechou o negócio). Toda
 * escrita leva uma trava pelo valor ANTERIOR que a política viu; se a trava
 * atua, o resultado é `skipped/conflito_humano` e nada é escrito. A decisão
 * humana mais recente vence sempre.
 *
 * ⚠️ NENHUM IMPORT DE ENVIO. Este arquivo (e todo `lib/supervisor/`) não
 * importa nada de `lib/messaging`, `lib/waha`, `lib/channels`, `lib/inbox` nem
 * do motor de turno do agente — vigiado por
 * `lib/supervisor/sem-caminho-de-envio.test.ts`. O único efeito que pode
 * terminar numa mensagem é `start_followup`, e ele passa pela inscrição do
 * motor de follow-up (`enrollFollowupFlow`), com os gates de opt-out, janela e
 * canal DELE — o Supervisor não monta nem envia texto nenhum.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type pg from "pg";

import type { Actor } from "@/lib/api/handlers/types";
import { ApiError } from "@/lib/api/types";
import { audit } from "@/lib/audit";
import { enrollFollowupFlow } from "@/lib/followup/enroll";
import { emitLeadActivity, stageChangeReason } from "@/lib/leads/activity-emitter";
import { encerraDemanda } from "@/lib/leads/encerramento";
import { recalculaScoreDoLead } from "@/lib/leads/score-writer";
import { SEM_DISPARO_AUTOMATICO } from "@/lib/event-log/sem-disparo";
import { logger } from "@/lib/logger";

import type { EvidenciaGravada, TipoDeAcao } from "./politica";

export const ATOR_SUPERVISOR_ID = "supervisor-comercial";

export interface AcaoGravada {
  id: string;
  organization_id: string;
  run_id: string;
  conversation_id: string | null;
  contact_id: string | null;
  lead_id: string | null;
  kind: TipoDeAcao;
  before: Record<string, unknown> | null;
  after: Record<string, unknown>;
  reason: string;
  evidence: EvidenciaGravada[];
}

export type ResultadoDaExecucao =
  | { status: "applied"; detalhe?: string; recalcularScore?: boolean }
  | { status: "skipped"; detalhe: string }
  | { status: "failed"; detalhe: string };

export interface QuemExecuta {
  /** `null` = o próprio Supervisor (automático). Um id = o gestor que aprovou. */
  aprovadorUserId: string | null;
  llmCallId: string | null;
  requestId: string;
  /**
   * A organização autorizou que o movimento AUTOMÁTICO dispare automações?
   * Aprovação humana sempre dispara: é decisão de gente, como o arrasto.
   */
  dispararAutomacoes?: boolean;
}

/** Metadata do evento emitido por uma ação do Supervisor. */
export function metadataDoEvento(quem: QuemExecuta): Record<string, unknown> {
  const humano = Boolean(quem.aprovadorUserId);
  return {
    actor_kind: humano ? "user" : "ai",
    actor_user_id: quem.aprovadorUserId,
    source: "supervisor-comercial",
    ...(humano || quem.dispararAutomacoes ? {} : { [SEM_DISPARO_AUTOMATICO]: true }),
  };
}

function atorDa(quem: QuemExecuta): Actor {
  return quem.aprovadorUserId
    ? { type: "user", id: quem.aprovadorUserId }
    : { type: "ai_agent", id: ATOR_SUPERVISOR_ID, role: "agent" };
}

function citacoes(acao: AcaoGravada): string {
  const t = acao.evidence.map((e) => `“${e.trecho}”`).join(" · ");
  return t ? ` — ${t}`.slice(0, 400) : "";
}

async function timeline(
  admin: SupabaseClient,
  acao: AcaoGravada,
  quem: QuemExecuta,
  type: "stage_changed" | "lead_edited" | "task_created" | "note",
  reason: string,
  payload: Record<string, unknown>,
): Promise<void> {
  if (!acao.lead_id) return;
  const r = await emitLeadActivity(admin, {
    organizationId: acao.organization_id,
    leadId: acao.lead_id,
    contactId: acao.contact_id,
    type,
    sourceModule: "supervisor",
    sourceId: acao.id,
    actor: atorDa(quem),
    reason: reason.slice(0, 500),
    // O lastro da IA é a chamada de modelo que leu a conversa. Sem ele a linha
    // entraria como 'system' (regra da 0071) — o que também é verdade, mas
    // perde a autoria.
    evidence: quem.llmCallId ? { llm_call_ids: [quem.llmCallId] } : null,
    payload: { ...payload, supervisor_action_id: acao.id, aprovado_por: quem.aprovadorUserId },
  });
  if (!r.ok) {
    logger.warn("[supervisor] atividade não registrada (segue)", { action_id: acao.id, error: r.error });
  }
}

export async function executaAcao(
  admin: SupabaseClient,
  pool: pg.Pool | null,
  acao: AcaoGravada,
  quem: QuemExecuta,
): Promise<ResultadoDaExecucao> {
  const org = acao.organization_id;
  const leadId = acao.lead_id;
  if (!leadId) return { status: "skipped", detalhe: "sem_negocio" };

  const { data: lead, error: leadErr } = await admin
    .from("crm_leads")
    .select("id, organization_id, pipeline_id, stage_id, status, contact_id, custom_fields, tags, value_cents, owner_user_id")
    .eq("organization_id", org)
    .eq("id", leadId)
    .maybeSingle();
  if (leadErr) return { status: "failed", detalhe: leadErr.message };
  if (!lead) return { status: "skipped", detalhe: "negocio_inexistente" };
  const L = lead as {
    pipeline_id: string;
    stage_id: string;
    status: string;
    contact_id: string | null;
    custom_fields: Record<string, unknown> | null;
    tags: string[] | null;
    value_cents: number | null;
    owner_user_id: string | null;
  };
  // Negócio que fechou depois da leitura: nenhuma ação comercial faz mais sentido.
  if (L.status !== "open") return { status: "skipped", detalhe: "negocio_fechado" };

  try {
    switch (acao.kind) {
      case "move_stage": {
        const de = String(acao.before?.stage_id ?? "");
        const para = String(acao.after.stage_id ?? "");
        if (L.stage_id !== de) return { status: "skipped", detalhe: "conflito_humano" };
        const { data: rows, error } = await admin
          .from("crm_leads")
          .update({ stage_id: para })
          .eq("organization_id", org)
          .eq("id", leadId)
          .eq("stage_id", de)
          .eq("status", "open")
          .select("id");
        if (error) return { status: "failed", detalhe: error.message };
        if ((rows ?? []).length === 0) return { status: "skipped", detalhe: "conflito_humano" };
        await timeline(
          admin,
          acao,
          quem,
          "stage_changed",
          `${stageChangeReason(
            (acao.before?.stage_name as string | null) ?? null,
            (acao.after.stage_name as string | null) ?? null,
          )} pelo Supervisor Comercial${citacoes(acao)}`,
          { de, para },
        );
        // O EVENTO, como em agent-stage-sync: regra de automação e gatilho de
        // follow-up por etapa precisam ver o movimento do Supervisor igual ao
        // movimento pela mão.
        const { error: evErr } = await admin.rpc("emit_event" as never, {
          p_event_type: "lead.stage_changed",
          p_entity_kind: "crm_lead",
          p_entity_id: leadId,
          p_payload: { pipeline_id: L.pipeline_id, from_stage_id: de, to_stage_id: para, status: L.status },
          p_metadata: metadataDoEvento(quem),
          p_organization_id: org,
        } as never);
        if (evErr) logger.error("[supervisor] emit_event lead.stage_changed falhou", { lead_id: leadId, error: evErr.message });
        return { status: "applied" };
      }

      case "set_field": {
        const key = String(acao.after.key);
        const atual = (L.custom_fields ?? {})[key];
        const visto = acao.before?.valor ?? null;
        if (JSON.stringify(atual ?? null) !== JSON.stringify(visto)) {
          return { status: "skipped", detalhe: "conflito_humano" };
        }
        const novo = { ...(L.custom_fields ?? {}), [key]: acao.after.valor };
        const { error } = await admin.from("crm_leads").update({ custom_fields: novo }).eq("organization_id", org).eq("id", leadId);
        if (error) return { status: "failed", detalhe: error.message };
        await timeline(admin, acao, quem, "lead_edited", `${acao.reason}${citacoes(acao)}`, {
          campo: key,
          de: visto,
          para: acao.after.valor,
        });
        return { status: "applied" };
      }

      case "set_value": {
        const visto = (acao.before?.value_cents as number | null) ?? null;
        if ((L.value_cents ?? null) !== visto) return { status: "skipped", detalhe: "conflito_humano" };
        const q = admin.from("crm_leads").update({ value_cents: acao.after.value_cents }).eq("organization_id", org).eq("id", leadId);
        const { error } = await (visto === null ? q.is("value_cents", null) : q.eq("value_cents", visto));
        if (error) return { status: "failed", detalhe: error.message };
        await timeline(admin, acao, quem, "lead_edited", `${acao.reason}${citacoes(acao)}`, {
          campo: "value_cents",
          de: visto,
          para: acao.after.value_cents,
        });
        return { status: "applied" };
      }

      case "add_tag":
      case "remove_tag": {
        const tag = String(acao.after.tag);
        const tags = L.tags ?? [];
        const tem = tags.some((t) => t.toLowerCase() === tag.toLowerCase());
        if (acao.kind === "add_tag" && tem) return { status: "skipped", detalhe: "ja_aplicada" };
        if (acao.kind === "remove_tag" && !tem) return { status: "skipped", detalhe: "ja_removida" };
        const novas = acao.kind === "add_tag" ? [...tags, tag] : tags.filter((t) => t.toLowerCase() !== tag.toLowerCase());
        const { error } = await admin.from("crm_leads").update({ tags: novas }).eq("organization_id", org).eq("id", leadId);
        if (error) return { status: "failed", detalhe: error.message };
        await timeline(admin, acao, quem, "lead_edited", `${acao.reason}${citacoes(acao)}`, { tags_de: tags, tags_para: novas });
        if (acao.kind === "add_tag") {
          // Mesmo contrato das rotas (só quando adicionou): quem ouve tag vê a
          // tag do Supervisor — com a marca de "sem disparo" quando for o caso.
          const { error: evErr } = await admin.rpc("emit_event" as never, {
            p_event_type: "lead.tag_added",
            p_entity_kind: "crm_lead",
            p_entity_id: leadId,
            p_payload: { added_tags: [tag], tags: novas },
            p_metadata: metadataDoEvento(quem),
            p_organization_id: org,
          } as never);
          if (evErr) logger.error("[supervisor] emit_event lead.tag_added falhou", { lead_id: leadId, error: evErr.message });
        }
        return { status: "applied" };
      }

      case "create_task": {
        const titulo = String(acao.after.title);
        // Dedup no momento da escrita também: a tarefa pode ter sido criada à
        // mão entre a leitura e agora.
        const { data: abertas } = await admin
          .from("crm_tasks")
          .select("id, title")
          .eq("organization_id", org)
          .eq("lead_id", leadId)
          .in("status", ["pending", "in_progress"]);
        if ((abertas ?? []).some((t: { title: string }) => t.title.trim().toLowerCase() === titulo.trim().toLowerCase())) {
          return { status: "skipped", detalhe: "tarefa_ja_existe" };
        }
        // Responsável = o dono do negócio; sem dono, quem atende a conversa.
        let responsavel = L.owner_user_id;
        if (!responsavel && acao.conversation_id) {
          const { data: conv } = await admin
            .from("conversations")
            .select("assigned_to_user_id")
            .eq("organization_id", org)
            .eq("id", acao.conversation_id)
            .maybeSingle();
          responsavel = (conv as { assigned_to_user_id: string | null } | null)?.assigned_to_user_id ?? null;
        }
        const detalhe = typeof acao.after.detalhe === "string" ? `\n${acao.after.detalhe}` : "";
        const descricao =
          `Criada pelo Supervisor Comercial a partir da conversa.${detalhe}` +
          (acao.evidence.length ? `\nEvidência: ${acao.evidence.map((e) => `“${e.trecho}”`).join(" · ")}` : "");
        const { data: t, error } = await admin
          .from("crm_tasks")
          .insert({
            organization_id: org,
            title: titulo.slice(0, 255),
            description: descricao.slice(0, 5000),
            due_date: (acao.after.due_date as string | null) ?? null,
            priority: "medium",
            status: "pending",
            lead_id: leadId,
            contact_id: L.contact_id,
            assigned_to: responsavel,
            created_by: quem.aprovadorUserId,
          })
          .select("id")
          .single();
        if (error) return { status: "failed", detalhe: error.message };
        await timeline(admin, acao, quem, "task_created", titulo.slice(0, 200), {
          task_id: (t as { id: string }).id,
          due_date: acao.after.due_date ?? null,
        });
        return { status: "applied", detalhe: (t as { id: string }).id };
      }

      case "start_followup": {
        if (!L.contact_id) return { status: "skipped", detalhe: "sem_contato" };
        const { data: contato } = await admin
          .from("contacts")
          .select("is_blocked, is_anonymized")
          .eq("organization_id", org)
          .eq("id", L.contact_id)
          .maybeSingle();
        const c = contato as { is_blocked: boolean; is_anonymized: boolean } | null;
        // Opt-out e anonimização vencem qualquer política de autonomia.
        if (!c || c.is_blocked || c.is_anonymized) return { status: "skipped", detalhe: "contato_bloqueado" };
        const r = await enrollFollowupFlow(admin, {
          organizationId: org,
          pointerId: String(acao.after.pointer_id),
          contactId: L.contact_id,
          actorUserId: quem.aprovadorUserId,
          requestId: quem.requestId,
        });
        if (!r.ok) return { status: r.status >= 500 ? "failed" : "skipped", detalhe: r.code };
        await timeline(admin, acao, quem, "note", `Follow-up iniciado pelo Supervisor Comercial: ${acao.reason}`, {
          pointer_id: acao.after.pointer_id,
        });
        return { status: "applied" };
      }

      case "update_qualification": {
        if (!L.contact_id) return { status: "skipped", detalhe: "sem_contato" };
        const nova = (acao.after.qualification ?? {}) as Record<string, string>;
        const { data: st, error: stErr } = await admin
          .from("lead_state")
          .select("id, qualification")
          .eq("organization_id", org)
          .eq("contact_id", L.contact_id)
          .maybeSingle();
        if (stErr) return { status: "failed", detalhe: stErr.message };
        const atual = ((st as { qualification: Record<string, string> } | null)?.qualification ?? {}) as Record<string, string>;
        const merged = { ...atual, ...nova };
        const { error } = st
          ? await admin.from("lead_state").update({ qualification: merged, updated_at: new Date().toISOString() })
              .eq("organization_id", org).eq("contact_id", L.contact_id)
          : await admin.from("lead_state").insert({ organization_id: org, contact_id: L.contact_id, qualification: merged });
        if (error) return { status: "failed", detalhe: error.message };
        await timeline(admin, acao, quem, "lead_edited", `${acao.reason}${citacoes(acao)}`, { qualificacao: nova });
        return { status: "applied", recalcularScore: true };
      }

      case "record_signals": {
        if (!L.contact_id) return { status: "skipped", detalhe: "sem_contato" };
        const { error } = await admin.from("lead_checkpoints").insert({
          organization_id: org,
          contact_id: L.contact_id,
          conversation_id: acao.conversation_id,
          commitments: acao.after.commitments ?? [],
          objections: acao.after.objections ?? [],
          next_action: (acao.after.next_action as string | null) ?? null,
          rolling_summary: String(acao.after.rolling_summary ?? "").slice(0, 2000),
        });
        if (error) return { status: "failed", detalhe: error.message };
        return { status: "applied", recalcularScore: true };
      }

      case "mark_won":
      case "mark_lost": {
        const motivo = (acao.after.lost_reason as string | null) ?? null;
        if (acao.kind === "mark_lost" && !motivo) return { status: "skipped", detalhe: "motivo_da_perda_ausente" };
        const r = await encerraDemanda(
          admin,
          { organization_id: org, actor: atorDa(quem), requestId: quem.requestId },
          {
            leadId,
            desfecho: acao.kind === "mark_won" ? "won" : "lost",
            motivo,
            razaoNaTimeline:
              (acao.kind === "mark_won" ? "Ganho registrado pelo Supervisor Comercial" : `Perdido — ${motivo}`) +
              (quem.aprovadorUserId ? " (aprovado por um gestor)" : "") +
              citacoes(acao),
            payloadNaTimeline: { supervisor_action_id: acao.id },
          },
        );
        return r.jaEstava ? { status: "skipped", detalhe: "ja_estava" } : { status: "applied" };
      }

      case "resolve_lead":
        // Não é efeito: é a pendência "qual negócio é este?". Resolver = escolher
        // o negócio na tela; a próxima leitura da conversa já sabe.
        return { status: "skipped", detalhe: "pendencia_de_identificacao" };
    }
  } catch (err) {
    if (err instanceof ApiError) return { status: "skipped", detalhe: err.code };
    return { status: "failed", detalhe: err instanceof Error ? err.message : String(err) };
  }
}

/** Grava o desfecho da execução, audita e recalcula o score quando os sinais mudaram. */
export async function concluiAcao(
  admin: SupabaseClient,
  pool: pg.Pool | null,
  acao: AcaoGravada,
  quem: QuemExecuta,
  r: ResultadoDaExecucao,
): Promise<void> {
  const status = r.status === "applied" ? (quem.aprovadorUserId ? "approved" : "applied") : r.status;
  await admin
    .from("supervisor_actions")
    .update({
      status,
      result_detail: r.detalhe ?? null,
      decided_by: quem.aprovadorUserId,
      decided_at: quem.aprovadorUserId ? new Date().toISOString() : null,
      updated_at: new Date().toISOString(),
    })
    .eq("organization_id", acao.organization_id)
    .eq("id", acao.id);

  if (r.status !== "applied") return;

  void audit({
    action: quem.aprovadorUserId ? "supervisor.action_approved" : "supervisor.action_applied",
    organizationId: acao.organization_id,
    actorUserId: quem.aprovadorUserId,
    resourceType: "crm_leads",
    resourceId: acao.lead_id,
    requestId: quem.requestId,
    bypassedRls: true,
    metadata: {
      supervisor_action_id: acao.id,
      run_id: acao.run_id,
      kind: acao.kind,
      before: acao.before,
      after: acao.after,
      conversation_id: acao.conversation_id,
      evidence_message_ids: acao.evidence.map((e) => e.message_id),
      llm_call_id: quem.llmCallId,
    },
  });

  if (r.recalcularScore && pool && acao.lead_id) {
    try {
      const lerScore = async () => {
        const { data } = await admin
          .from("crm_lead_scores")
          .select("ai_probability, ai_probability_band")
          .eq("organization_id", acao.organization_id)
          .eq("lead_id", acao.lead_id!)
          .maybeSingle();
        const x = data as { ai_probability: number | string | null; ai_probability_band: string | null } | null;
        return x?.ai_probability == null ? null : { valor: Math.round(Number(x.ai_probability)), faixa: x.ai_probability_band };
      };
      const antes = await lerScore();
      const s = await recalculaScoreDoLead(pool, acao.organization_id, acao.lead_id);
      const depois = await lerScore();
      // O diário de Atividade mostra "42% → 67% (Morno)". O número fica na
      // ação que o causou — não há segunda tabela de histórico de score.
      if (depois && depois.valor !== antes?.valor) {
        await admin
          .from("supervisor_actions")
          .update({ after: { ...acao.after, score: { de: antes?.valor ?? null, para: depois.valor, faixa: depois.faixa } } })
          .eq("organization_id", acao.organization_id)
          .eq("id", acao.id);
      }
      if (!s.gravou) logger.info("[supervisor] score não gravado", { lead_id: acao.lead_id, motivo: s.motivo });
    } catch (err) {
      // Score é derivado: a próxima leitura recalcula.
      logger.warn("[supervisor] recálculo de score falhou (segue)", {
        lead_id: acao.lead_id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
