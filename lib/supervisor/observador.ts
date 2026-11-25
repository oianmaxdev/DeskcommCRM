/**
 * O OBSERVADOR — lê as conversas conduzidas por vendedor humano e mantém o CRM
 * em dia, em rodadas incrementais disparadas pelo cron `supervisor-comercial`.
 *
 * ── Por que cron com debounce, e não um consumidor por mensagem ──────────────
 * Uma troca de vinte mensagens em dez minutos é UM acontecimento comercial. Ler
 * mensagem a mensagem pagaria vinte chamadas de modelo para chegar à conclusão
 * que a última já permite — e decidiria etapa no meio de uma frase. Por isso a
 * conversa só é lida depois de `silencio_minutos` sem mensagem nova, e só a
 * parte NOVA dela (o cursor é a última mensagem já lida, em `supervisor_runs`),
 * levando o resumo acumulado da leitura anterior no lugar do histórico inteiro.
 *
 * ── Garantias ──────────────────────────────────────────────────────────────
 *  - Idempotência: `unique (organization_id, conversation_id, last_message_id)`
 *    em `supervisor_runs` é o CLAIM da janela — dois workers não leem a mesma;
 *    `unique (organization_id, dedup_key)` em `supervisor_actions` impede a
 *    mesma ação duas vezes, mesmo entre janelas diferentes.
 *  - Recuperação: leitura que falhou (ou ficou presa) é reclamada de novo depois
 *    de 15 minutos.
 *  - Tenancy: o admin client ignora RLS; TODA consulta filtra `organization_id`
 *    vindo de `supervisor_settings`, nunca de input externo.
 *  - Sem envio: nada aqui chama emissor de mensagem (ver executor.ts).
 */
import { generateObject, type LanguageModel } from "ai";
import type { SupabaseClient } from "@supabase/supabase-js";
import type pg from "pg";

import { getBudgetStatus } from "@/lib/ai/budget/check";
import { computeCost } from "@/lib/ai/cost";
import { DEFAULT_CLASSIFIER_MODEL } from "@/lib/ai/gateway";
import { createAdminClient } from "@/lib/supabase/admin";
import { resolverModeloDoSupervisor } from "./modelo";
import { providerDoModelo } from "@/lib/ai/log-invocation";
import { camposDoFunil } from "@/lib/leads/campos-do-funil";
import { motivosDoFunil } from "@/lib/leads/motivos-de-perda-do-funil";
import { logger } from "@/lib/logger";

import { analiseSchema, verificaEvidencia, type Analise, type MensagemDaJanela } from "./analise";
import { criteriosEmVigor, lerConfig, type SupervisorConfig } from "./config";
import { concluiAcao, executaAcao, type AcaoGravada } from "./executor";
import { ehOmissao, provaPorOmissao } from "./omissao";
import { decideAcoes, type AcaoPlanejada, type ContextoDoNegocio, type EtapaDoFunil } from "./politica";
import { montaPrompt, SYSTEM_PROMPT_SUPERVISOR, type EtapaNoPrompt } from "./prompt";

export const PONTO_OBSERVAR = "supervisor_observe";
const JANELA_MAX = 80;
const PRIMEIRA_LEITURA_MAX = 60;
const RECLAMAR_APOS_MS = 15 * 60 * 1000;
const HORIZONTE_DIAS = 14;

export interface ChamadaDeModelo {
  object: Analise;
  inputTokens: number;
  outputTokens: number;
  modelId: string;
}

export interface DepsDoObservador {
  admin: SupabaseClient;
  pool: pg.Pool | null;
  agora: () => Date;
  /** Injetável para teste. Devolve null quando não há modelo configurado. */
  analisar: (orgId: string, system: string, prompt: string) => Promise<ChamadaDeModelo | null>;
}

/** O caminho de produção: o ponto de IA da organização, saída tipada pelo Zod. */
export async function analisarComModelo(orgId: string, system: string, prompt: string): Promise<ChamadaDeModelo | null> {
  const resolvido = await resolverModeloDoSupervisor(createAdminClient(), "supervisor_observe", orgId, DEFAULT_CLASSIFIER_MODEL);
  if (!resolvido) return null;
  try {
    const r = await generateObject({
      model: resolvido.model as LanguageModel,
      schema: analiseSchema,
      system,
      prompt,
      temperature: 0,
      // Folga de propósito: modelos com raciocínio embutido gastam parte do teto
      // antes de escrever o objeto. Com 3.000, uma conversa rica voltava cortada
      // e o objeto não fechava (medido com gemini-3.5-flash na homologação).
      maxOutputTokens: 8000,
      abortSignal: AbortSignal.timeout(90_000),
    });
    const u = r.usage as { inputTokens?: number; outputTokens?: number } | undefined;
    return { object: r.object, inputTokens: u?.inputTokens ?? 0, outputTokens: u?.outputTokens ?? 0, modelId: resolvido.modelId };
  } catch (err) {
    // O registro da falha precisa dizer QUAL modelo falhou, não o padrão do ponto.
    throw Object.assign(err instanceof Error ? err : new Error(String(err)), { modelId: resolvido.modelId });
  }
}

export async function registraChamada(
  admin: SupabaseClient,
  orgId: string,
  contactId: string | null,
  ponto: { purpose: "supervisor_observe" | "supervisor_diagnose" },
  c: { modelId: string; inputTokens: number; outputTokens: number },
  latencyMs: number,
  erro: string | null,
): Promise<string | null> {
  const cost = erro ? 0 : await computeCost({ model: c.modelId, promptTokens: c.inputTokens, completionTokens: c.outputTokens }).catch(() => null);
  const { data, error } = await admin
    .from("llm_calls")
    .insert({
      organization_id: orgId,
      contact_id: contactId,
      purpose: ponto.purpose,
      provider: providerDoModelo(c.modelId),
      model: c.modelId,
      input_tokens: c.inputTokens,
      output_tokens: c.outputTokens,
      cost_cents: cost,
      latency_ms: latencyMs,
      status: erro ? "erro" : "ok",
      error_message: erro ? erro.slice(0, 500) : null,
    })
    .select("id")
    .single();
  if (error) {
    logger.warn("[supervisor] llm_calls insert falhou", { error: error.message });
    return null;
  }
  return (data as { id: string }).id;
}

export async function orcamentoEsgotado(orgId: string): Promise<boolean> {
  try {
    const b = await getBudgetStatus(orgId);
    return b.enforcement_mode === "bloquear" && b.monthly_limit_cents > 0 && b.current_month_consumed_cents >= b.monthly_limit_cents;
  } catch {
    return false;
  }
}

interface MensagemCrua {
  id: string;
  direction: "inbound" | "outbound";
  sent_via: string;
  sent_by_user_id: string | null;
  body: string | null;
  media_derived_text: string | null;
  type: string;
  sent_at: string;
}

export function quemFalou(m: Pick<MensagemCrua, "direction" | "sent_via">): MensagemDaJanela["quem"] {
  if (m.direction === "inbound") return "cliente";
  if (m.sent_via === "ai") return "ia";
  if (m.sent_via === "automation" || m.sent_via === "system") return "automacao";
  return "vendedor";
}

/** Converte linhas cruas na janela citável. Transcrição de áudio entra quando existe. */
export function montaJanela(linhas: readonly MensagemCrua[]): MensagemDaJanela[] {
  return linhas
    .filter((m) => m.type !== "reaction" && m.type !== "system")
    .map((m, i) => ({
      ref: `m${i + 1}`,
      id: m.id,
      quem: quemFalou(m),
      texto: (m.body?.trim() || m.media_derived_text?.trim() || `[${m.type}]`).slice(0, 2000),
      enviadaEm: m.sent_at,
    }));
}

/** O ramo que a empresa declarou no onboarding ("O que vocês fazem?"). Nunca lança. */
export function negocioDaOrganizacao(onboardingState: unknown): string | null {
  const w = (onboardingState as { welcome?: { o_que_faz?: unknown } } | null)?.welcome?.o_que_faz;
  return typeof w === "string" && w.trim() !== "" ? w.trim().slice(0, 280) : null;
}

export interface ResumoDaRodada {
  organizacoes: number;
  conversas_lidas: number;
  puladas: number;
  ambiguas: number;
  acoes_aplicadas: number;
  acoes_pendentes: number;
  falhas: number;
  /** Conversas que NÃO foram lidas por falta de modelo de IA utilizável. */
  sem_modelo: number;
  /** A rodada parou de começar conversas por prazo; o restante vai na próxima. */
  interrompida_por_prazo: boolean;
}

const CONTADORES = [
  "conversas_lidas",
  "puladas",
  "ambiguas",
  "acoes_aplicadas",
  "acoes_pendentes",
  "falhas",
  "sem_modelo",
] as const satisfies ReadonlyArray<keyof ResumoDaRodada>;

const zero = (): ResumoDaRodada => ({
  organizacoes: 0,
  conversas_lidas: 0,
  puladas: 0,
  ambiguas: 0,
  acoes_aplicadas: 0,
  acoes_pendentes: 0,
  falhas: 0,
  sem_modelo: 0,
  interrompida_por_prazo: false,
});

/** Uma rodada leva no máximo isto; o agendador corta em 240 s (docker/scheduler/entrypoint.sh). */
export const PRAZO_DA_RODADA_MS = 200_000;

/**
 * Uma rodada sobre as organizações com o Supervisor ligado — a menos
 * recentemente servida primeiro (`ultima_rodada_em`, achado A), com prazo
 * global. Organização que ficou de fora por prazo encabeça a próxima rodada.
 */
export async function rodadaDoSupervisor(
  deps: DepsDoObservador,
  requestId: string,
  prazoMs: number = PRAZO_DA_RODADA_MS,
): Promise<ResumoDaRodada> {
  const total = zero();
  const prazo = deps.agora().getTime() + prazoMs;
  const { data, error } = await deps.admin
    .from("supervisor_settings")
    .select("organization_id, config, ultima_rodada_em")
    .eq("enabled", true)
    .order("ultima_rodada_em", { ascending: true, nullsFirst: true })
    .limit(500);
  if (error) throw new Error(`supervisor_settings: ${error.message}`);
  for (const row of (data ?? []) as Array<{ organization_id: string; config: unknown }>) {
    if (deps.agora().getTime() >= prazo) {
      total.interrompida_por_prazo = true;
      break;
    }
    try {
      const r = await observaOrganizacao(deps, row.organization_id, lerConfig(row.config), { requestId, prazo });
      total.organizacoes += 1;
      for (const k of CONTADORES) total[k] += r[k];
      if (r.interrompida_por_prazo) total.interrompida_por_prazo = true;
    } catch (err) {
      total.falhas += 1;
      logger.error("[supervisor] organização falhou (segue)", {
        organization_id: row.organization_id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    // Servida (inclusive quando falhou): vai para o fim da fila. Organização
    // que dá erro sempre não pode ficar na frente de todas para sempre.
    await deps.admin
      .from("supervisor_settings")
      .update({ ultima_rodada_em: deps.agora().toISOString() })
      .eq("organization_id", row.organization_id);
  }
  return total;
}

export async function observaOrganizacao(
  deps: DepsDoObservador,
  orgId: string,
  config: SupervisorConfig,
  opts: { requestId: string; conversationId?: string; ignorarSilencio?: boolean; prazo?: number },
): Promise<ResumoDaRodada> {
  const r = zero();
  if (config.pipelines.length === 0) return r;
  if (await orcamentoEsgotado(orgId)) {
    logger.info("[supervisor] orçamento de IA esgotado: rodada pulada", { organization_id: orgId });
    return r;
  }
  const agora = deps.agora();
  const limiteSilencio = new Date(agora.getTime() - (opts.ignorarSilencio ? 0 : config.silencio_minutos * 60_000));
  const horizonte = new Date(agora.getTime() - HORIZONTE_DIAS * 24 * 3600 * 1000);

  // Só conversas PENDENTES, selecionadas no banco (achado A): leitura concluída
  // mais nova que a última mensagem fica de fora, e reivindicação recente
  // (em andamento ou falha há menos de RECLAMAR_APOS_MS) também — senão elas
  // ocupariam as vagas da rodada sem serem lidas.
  const pedido = Math.max(1, config.max_conversas_por_rodada);
  const { data: convs, error } = await deps.admin.rpc("fn_supervisor_conversas_pendentes", {
    p_org: orgId,
    p_desde: horizonte.toISOString(),
    p_ate: limiteSilencio.toISOString(),
    p_reclamar_antes: new Date(agora.getTime() - RECLAMAR_APOS_MS).toISOString(),
    p_limite: opts.conversationId ? 1000 : pedido,
  });
  if (error) throw new Error(`fn_supervisor_conversas_pendentes: ${error.message}`);
  const todas = (convs ?? []) as Array<{
    id: string;
    contact_id: string;
    assigned_to_user_id: string | null;
    status: string;
    last_message_at: string;
    cursor: string | null;
  }>;
  const pendentes = opts.conversationId ? todas.filter((c) => c.id === opts.conversationId) : todas;
  if (pendentes.length === 0) return r;
  const cursores = new Map(pendentes.filter((c) => c.cursor).map((c) => [c.id, c.cursor as string]));

  const { data: orgRow } = await deps.admin.from("organizations").select("timezone, onboarding_state").eq("id", orgId).maybeSingle();
  const fuso = (orgRow as { timezone: string | null } | null)?.timezone ?? null;
  const negocio = negocioDaOrganizacao((orgRow as { onboarding_state: unknown } | null)?.onboarding_state);

  for (const conv of pendentes.slice(0, pedido)) {
    // Prazo da rodada: perto do limite do agendador, não começa conversa nova.
    // O que sobrar entra na próxima rodada, que começa por esta organização.
    if (opts.prazo !== undefined && deps.agora().getTime() >= opts.prazo) {
      r.interrompida_por_prazo = true;
      break;
    }
    try {
      const x = await observaConversa(deps, orgId, config, conv, cursores.get(conv.id) ?? null, opts.requestId, fuso, negocio);
      r.conversas_lidas += x.lida ? 1 : 0;
      r.puladas += x.lida ? 0 : 1;
      r.sem_modelo += x.semModelo ? 1 : 0;
      r.ambiguas += x.ambigua ? 1 : 0;
      r.acoes_aplicadas += x.aplicadas;
      r.acoes_pendentes += x.pendentes;
      r.falhas += x.falhas;
    } catch (err) {
      r.falhas += 1;
      logger.error("[supervisor] conversa falhou (segue)", {
        organization_id: orgId,
        conversation_id: conv.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return r;
}

interface Claim {
  runId: string;
}

/** Reivindica a janela. `null` = outra rodada já tem (ou já leu) esta janela. */
async function reivindica(
  admin: SupabaseClient,
  linha: Record<string, unknown>,
  agora: Date,
): Promise<Claim | null> {
  for (let tentativa = 0; tentativa < 2; tentativa++) {
    const { data, error } = await admin.from("supervisor_runs").insert(linha).select("id").single();
    if (!error) return { runId: (data as { id: string }).id };
    if (error.code !== "23505") throw new Error(`supervisor_runs insert: ${error.message}`);
    const { data: existente } = await admin
      .from("supervisor_runs")
      .select("id, status, skip_reason, created_at")
      .eq("organization_id", linha.organization_id as string)
      .eq("conversation_id", linha.conversation_id as string)
      .eq("last_message_id", linha.last_message_id as string)
      .maybeSingle();
    const e = existente as { id: string; status: string; skip_reason: string | null; created_at: string } | null;
    if (!e) continue;
    const presa = e.status === "failed" || (e.status === "skipped" && e.skip_reason === "em_processamento");
    if (presa && agora.getTime() - new Date(e.created_at).getTime() > RECLAMAR_APOS_MS) {
      await admin.from("supervisor_runs").delete().eq("organization_id", linha.organization_id as string).eq("id", e.id);
      continue;
    }
    return null;
  }
  return null;
}

const ORDEM: Record<AcaoPlanejada["kind"], number> = {
  move_stage: 1,
  set_field: 2,
  set_value: 3,
  add_tag: 4,
  remove_tag: 5,
  update_qualification: 6,
  record_signals: 7,
  create_task: 8,
  start_followup: 9,
  mark_won: 10,
  mark_lost: 11,
  resolve_lead: 12,
};

async function observaConversa(
  deps: DepsDoObservador,
  orgId: string,
  config: SupervisorConfig,
  conv: { id: string; contact_id: string; assigned_to_user_id: string | null; status: string },
  cursor: string | null,
  requestId: string,
  fuso: string | null,
  negocio: string | null,
): Promise<{ lida: boolean; ambigua: boolean; aplicadas: number; pendentes: number; falhas: number; semModelo: boolean }> {
  const out = { lida: false, ambigua: false, aplicadas: 0, pendentes: 0, falhas: 0, semModelo: false };
  const { admin } = deps;
  const agora = deps.agora();

  // ── 1. A janela: só o que é NOVO desde a última leitura ─────────────────────
  let mq = admin
    .from("messages")
    .select("id, direction, sent_via, sent_by_user_id, body, media_derived_text, type, sent_at")
    .eq("organization_id", orgId)
    .eq("conversation_id", conv.id);
  mq = cursor
    ? mq.gt("sent_at", cursor).order("sent_at", { ascending: true }).limit(JANELA_MAX)
    : mq.order("sent_at", { ascending: false }).limit(PRIMEIRA_LEITURA_MAX);
  const { data: msgs, error: mErr } = await mq;
  if (mErr) throw new Error(`messages: ${mErr.message}`);
  const cruas = ((msgs ?? []) as MensagemCrua[]).slice();
  if (!cursor) cruas.reverse();
  if (cruas.length === 0) return out;
  const ultima = cruas[cruas.length - 1]!;
  const janela = montaJanela(cruas);
  const humanas = janela.filter((m) => m.quem === "vendedor").length;

  const baseRun = {
    organization_id: orgId,
    conversation_id: conv.id,
    contact_id: conv.contact_id,
    first_message_at: cruas[0]!.sent_at,
    last_message_at: ultima.sent_at,
    last_message_id: ultima.id,
    messages_count: janela.length,
    human_messages_count: humanas,
    status: "skipped",
    skip_reason: "em_processamento",
  };
  const claim = await reivindica(admin, baseRun, agora);
  if (!claim) return out;
  const fecha = async (patch: Record<string, unknown>) => {
    await admin.from("supervisor_runs").update(patch).eq("organization_id", orgId).eq("id", claim.runId);
  };

  // ── 2. Conversa de vendedor humano? ─────────────────────────────────────────
  // O agente de IA já opera o CRM nas conversas dele (inbound-turn). O
  // Supervisor cobre o buraco: a conversa conduzida por gente.
  const atendidaPorHumano = Boolean(conv.assigned_to_user_id) && conv.status !== "ai_handling";
  if (humanas === 0 && !atendidaPorHumano) {
    await fecha({ status: "skipped", skip_reason: "conduzida_pela_ia" });
    return out;
  }
  if (janela.every((m) => m.texto.startsWith("["))) {
    await fecha({ status: "skipped", skip_reason: "sem_texto" });
    return out;
  }

  // ── 3. Os negócios candidatos ──────────────────────────────────────────────
  const { data: leadRows, error: lErr } = await admin
    .from("crm_leads")
    .select("id, title, pipeline_id, stage_id, status, value_cents, custom_fields, tags, owner_user_id, last_activity_at, created_at")
    .eq("organization_id", orgId)
    .eq("contact_id", conv.contact_id)
    .eq("status", "open");
  if (lErr) throw new Error(`crm_leads: ${lErr.message}`);
  const leads = (leadRows ?? []) as Array<{
    id: string;
    title: string;
    pipeline_id: string;
    stage_id: string;
    status: "open";
    value_cents: number | null;
    custom_fields: Record<string, unknown> | null;
    tags: string[] | null;
    owner_user_id: string | null;
  }>;
  if (leads.length === 0) {
    await fecha({ status: "skipped", skip_reason: "sem_negocio_aberto" });
    return out;
  }
  const monitorados = new Set(config.pipelines);
  if (!leads.some((l) => monitorados.has(l.pipeline_id))) {
    await fecha({ status: "skipped", skip_reason: "funil_fora_do_escopo" });
    return out;
  }

  const pipelineIds = [...new Set(leads.map((l) => l.pipeline_id))];
  const [{ data: pipes }, { data: stages }] = await Promise.all([
    admin.from("crm_pipelines").select("id, name, settings").eq("organization_id", orgId).in("id", pipelineIds),
    admin
      .from("crm_stages")
      .select("id, pipeline_id, name, position, is_won, is_lost, is_archived, requires_human, description")
      .eq("organization_id", orgId)
      .in("pipeline_id", pipelineIds)
      .order("position", { ascending: true }),
  ]);
  const pipelines = (pipes ?? []) as Array<{ id: string; name: string; settings: Record<string, unknown> | null }>;
  const etapas = (stages ?? []) as Array<EtapaDoFunil & { pipeline_id: string; description: string | null }>;
  const nomeDoFunil = (id: string) => pipelines.find((p) => p.id === id)?.name ?? "?";

  // Refs curtas: o modelo nunca vê uuid (e não tem como forjar um).
  const refsDeEtapa: Record<string, string> = {};
  const etapasNoPrompt: EtapaNoPrompt[] = [];
  let n = 0;
  for (const e of etapas) {
    if (e.is_archived || !monitorados.has(e.pipeline_id)) continue;
    const ref = `e${++n}`;
    refsDeEtapa[ref] = e.id;
    etapasNoPrompt.push({
      ref,
      nome: e.name,
      funil: nomeDoFunil(e.pipeline_id),
      criterio: config.etapas[e.id]?.criterio || e.description || "",
      fechamento: e.is_won || e.is_lost,
    });
  }
  const refsDeLead: Record<string, string> = {};
  const candidatos = leads.map((l, i) => {
    refsDeLead[`n${i + 1}`] = l.id;
    return {
      ref: `n${i + 1}`,
      titulo: l.title,
      funil: nomeDoFunil(l.pipeline_id),
      etapaAtual: etapas.find((e) => e.id === l.stage_id)?.name ?? "?",
    };
  });

  // Campos e motivos: do(s) funil(is) monitorado(s) dos candidatos.
  const campos = pipelines
    .filter((p) => monitorados.has(p.id))
    .flatMap((p) => camposDoFunil(p.settings ?? null))
    .filter((f, i, arr) => arr.findIndex((g) => g.key === f.key) === i)
    .filter((f) => config.campos_permitidos.length === 0 || config.campos_permitidos.includes(f.key));
  const motivos = [...new Set(pipelines.filter((p) => monitorados.has(p.id)).flatMap((p) => motivosDoFunil(p.settings)))];

  // ── 4. O que o CRM já sabe ─────────────────────────────────────────────────
  const [{ data: runAnterior }, { data: ck }, { data: st }] = await Promise.all([
    admin
      .from("supervisor_runs")
      .select("summary")
      .eq("organization_id", orgId)
      .eq("conversation_id", conv.id)
      .eq("status", "analyzed")
      .order("last_message_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
    admin
      .from("lead_checkpoints")
      .select("commitments, objections")
      .eq("organization_id", orgId)
      .eq("contact_id", conv.contact_id)
      .order("seq", { ascending: false })
      .limit(1)
      .maybeSingle(),
    admin.from("lead_state").select("qualification").eq("organization_id", orgId).eq("contact_id", conv.contact_id).maybeSingle(),
  ]);
  const sinaisAnteriores = ck
    ? {
        commitments: ((ck as { commitments: unknown }).commitments as string[] | null) ?? [],
        objections: ((ck as { objections: unknown }).objections as string[] | null) ?? [],
      }
    : null;
  const qualificacaoAtual = Object.fromEntries(
    Object.entries(((st as { qualification: Record<string, unknown> } | null)?.qualification ?? {}) as Record<string, unknown>).filter(
      ([, v]) => typeof v === "string" && v.trim() !== "",
    ),
  ) as Record<string, string>;

  const { formal, criterios } = criteriosEmVigor(config);
  // MINIMIZAÇÃO: o título do negócio costuma levar o nome do cliente. O modelo
  // só precisa dele para escolher ENTRE negócios; com um só, não sai da instalação.
  const candidatosNoPrompt =
    candidatos.length === 1 ? [{ ...candidatos[0]!, titulo: "negócio único deste cliente" }] : candidatos;
  const prompt = montaPrompt({
    agoraIso: agora.toISOString(),
    fuso,
    negocio,
    resumoAnterior: (runAnterior as { summary: string } | null)?.summary ?? "",
    sinaisAnteriores,
    janela,
    candidatos: candidatosNoPrompt,
    etapas: etapasNoPrompt,
    campos,
    motivosDePerda: motivos,
    config,
    criterios,
    qualificacaoAtual,
    valorAtualCentavos: leads.length === 1 ? leads[0]!.value_cents : null,
  });

  // ── 5. A leitura (uma chamada de modelo por janela) ────────────────────────
  const t0 = Date.now();
  let chamada: ChamadaDeModelo | null;
  try {
    chamada = await deps.analisar(orgId, SYSTEM_PROMPT_SUPERVISOR, prompt);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await registraChamada(admin, orgId, conv.contact_id, { purpose: "supervisor_observe" }, { modelId: (err as { modelId?: string }).modelId ?? "desconhecido", inputTokens: 0, outputTokens: 0 }, Date.now() - t0, msg);
    await fecha({ status: "failed", skip_reason: "modelo_falhou" });
    out.falhas += 1;
    return out;
  }
  if (!chamada) {
    // Sem modelo configurado: não é falha da conversa — solta o claim para a
    // próxima rodada tentar quando a chave existir.
    await admin.from("supervisor_runs").delete().eq("organization_id", orgId).eq("id", claim.runId);
    out.semModelo = true;
    return out;
  }
  const llmCallId = await registraChamada(admin, orgId, conv.contact_id, { purpose: "supervisor_observe" }, chamada, Date.now() - t0, null);
  const analise = chamada.object;
  out.lida = true;

  // ── 6. Qual negócio ────────────────────────────────────────────────────────
  let leadId: string | null = null;
  if (leads.length === 1) leadId = leads[0]!.id;
  else {
    // Uma pessoa já disse qual é o negócio desta conversa? Essa decisão vence o
    // modelo enquanto o negócio escolhido seguir aberto.
    const { data: resolvida } = await admin
      .from("supervisor_actions")
      .select("after")
      .eq("organization_id", orgId)
      .eq("conversation_id", conv.id)
      .eq("kind", "resolve_lead")
      .eq("status", "approved")
      .order("decided_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    const escolhido = ((resolvida as { after: { lead_escolhido?: string } } | null)?.after?.lead_escolhido) ?? null;
    if (escolhido && leads.some((l) => l.id === escolhido)) leadId = escolhido;
    else if (analise.negocio.lead_ref && analise.negocio.confianca === "alta") {
      // Só confiança ALTA desambigua sozinha: com dois negócios abertos, errar o
      // alvo é mexer no negócio errado do cliente — o dano que esta regra evita.
      leadId = refsDeLead[analise.negocio.lead_ref.trim()] ?? null;
    }
  }
  // O que o diagnóstico vai CONTAR depois precisa ter a citação conferida agora,
  // enquanto a janela está à mão: falha ou ponto positivo sem trecho real fica
  // marcado e não entra em recorrência nem vira estudo de caso.
  // Falha por OMISSÃO (falta de retorno, compromisso não cumprido) não tem frase
  // que prove a ausência: ela se prova pela origem citada + prazo vencido +
  // ausência verificável de acompanhamento + nada programado (lib/supervisor/omissao.ts).
  const temOmissao = analise.problemas.some((p) => ehOmissao(p.codigo));
  let acaoProgramada = false;
  if (temOmissao) {
    const [{ data: futuras }, { data: inscricoes }] = await Promise.all([
      leadId
        ? admin.from("crm_tasks").select("id").eq("organization_id", orgId).eq("lead_id", leadId).in("status", ["pending", "in_progress"]).gt("due_date", agora.toISOString()).limit(1)
        : Promise.resolve({ data: [] as unknown[] }),
      admin.from("followup_enrollments").select("id").eq("organization_id", orgId).eq("contact_id", conv.contact_id).in("status", ["active", "waiting_reply"]).limit(1),
    ]);
    acaoProgramada = (futuras ?? []).length > 0 || (inscricoes ?? []).length > 0;
  }
  const analiseGravada = {
    ...analise,
    problemas: analise.problemas.map((p) => {
      if (!ehOmissao(p.codigo)) return { ...p, evidencia_verificada: verificaEvidencia(janela, p.evidencia).ok };
      const r = provaPorOmissao({ codigo: p.codigo, janela, citacao: p.evidencia, prazoIso: p.prazo_iso ?? null, agora, fuso, acaoProgramada });
      return r.ok
        ? { ...p, evidencia_verificada: true, prova_por_omissao: r.prova }
        : { ...p, evidencia_verificada: false, omissao_nao_comprovada: r.motivo };
    }),
    pontos_positivos: analise.pontos_positivos.map((p) => ({ ...p, evidencia_verificada: verificaEvidencia(janela, p.evidencia).ok })),
    criterios_formais: formal,
  };
  if (!leadId) {
    // AMBÍGUO: nada é alterado em negócio nenhum. A pendência diz quais são os
    // candidatos; quem resolve é uma pessoa.
    out.ambigua = true;
    await fecha({
      status: "ambiguous",
      skip_reason: null,
      summary: analise.resumo,
      analysis: analiseGravada,
      llm_call_id: llmCallId,
      owner_user_id: conv.assigned_to_user_id,
    });
    await admin.from("supervisor_actions").upsert(
      {
        organization_id: orgId,
        run_id: claim.runId,
        conversation_id: conv.id,
        contact_id: conv.contact_id,
        lead_id: null,
        kind: "resolve_lead",
        risk: "condicional",
        status: "pending_approval",
        before: null,
        after: { candidatos: candidatos.map((c) => ({ ...c, lead_id: refsDeLead[c.ref] })) },
        reason: `Contato com ${leads.length} negócios abertos e a conversa não deixa claro qual: ${analise.negocio.motivo}`.slice(0, 500),
        evidence: [],
        dedup_key: `resolve:${conv.id}:${ultima.id}`,
      },
      { onConflict: "organization_id,dedup_key", ignoreDuplicates: true },
    );
    out.pendentes += 1;
    return out;
  }
  const lead = leads.find((l) => l.id === leadId)!;
  const baseFechada = {
    status: "analyzed",
    skip_reason: null as string | null,
    summary: analise.resumo,
    analysis: analiseGravada,
    llm_call_id: llmCallId,
    lead_id: lead.id,
    pipeline_id: lead.pipeline_id,
    owner_user_id: lead.owner_user_id ?? conv.assigned_to_user_id,
  };
  if (!monitorados.has(lead.pipeline_id)) {
    await fecha({ ...baseFechada, skip_reason: "funil_fora_do_escopo" });
    return out;
  }

  // ── 7. A política ──────────────────────────────────────────────────────────
  const [{ data: humanoEtapa }, { data: humanoCampos }, { data: tarefas }, { data: contato }] = await Promise.all([
    admin
      .from("crm_lead_activities")
      .select("performed_at")
      .eq("organization_id", orgId)
      .eq("lead_id", lead.id)
      .eq("actor_kind", "user")
      .in("type", ["stage_changed", "agent_move_corrected"])
      .order("performed_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
    admin
      .from("crm_lead_activities")
      .select("performed_at")
      .eq("organization_id", orgId)
      .eq("lead_id", lead.id)
      .eq("actor_kind", "user")
      .eq("type", "lead_edited")
      .order("performed_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
    admin.from("crm_tasks").select("title").eq("organization_id", orgId).eq("lead_id", lead.id).in("status", ["pending", "in_progress"]),
    admin.from("contacts").select("is_blocked").eq("organization_id", orgId).eq("id", conv.contact_id).maybeSingle(),
  ]);
  const ctx: ContextoDoNegocio = {
    leadId: lead.id,
    stageId: lead.stage_id,
    status: lead.status,
    valueCents: lead.value_cents,
    customFields: lead.custom_fields ?? {},
    tags: lead.tags ?? [],
    etapas: etapas.filter((e) => e.pipeline_id === lead.pipeline_id),
    refsDeEtapa,
    campos,
    motivosDePerda: motivos,
    qualificacaoAtual,
    sinaisAnteriores,
    tarefasAbertas: ((tarefas ?? []) as Array<{ title: string }>).map((t) => t.title),
    contatoBloqueado: Boolean((contato as { is_blocked: boolean } | null)?.is_blocked),
    ultimaMudancaHumana: {
      etapa: (humanoEtapa as { performed_at: string } | null)?.performed_at ?? null,
      campos: (humanoCampos as { performed_at: string } | null)?.performed_at ?? null,
    },
    ultimaMensagemId: ultima.id,
  };
  const { acoes, descartes } = decideAcoes(analise, janela, ctx, config, agora);
  await fecha({ ...baseFechada, analysis: { ...analiseGravada, descartes } });

  // ── 8. Grava (idempotente) e executa o que é automático ────────────────────
  for (const a of [...acoes].sort((x, y) => ORDEM[x.kind] - ORDEM[y.kind])) {
    const { data: ins, error: insErr } = await admin
      .from("supervisor_actions")
      .upsert(
        {
          organization_id: orgId,
          run_id: claim.runId,
          conversation_id: conv.id,
          contact_id: conv.contact_id,
          lead_id: lead.id,
          kind: a.kind,
          risk: a.risk,
          // Automática nasce RESERVADA para execução, não "aplicada" (achado D):
          // `applied` só depois do efeito confirmado, em concluiAcao.
          status: a.status === "applied" ? "executing" : a.status,
          ...(a.status === "applied" ? { execution_started_at: agora.toISOString(), execution_attempts: 1 } : {}),
          before: a.before,
          after: a.after,
          reason: a.reason.slice(0, 500),
          evidence: a.evidence,
          dedup_key: a.dedupKey,
        },
        { onConflict: "organization_id,dedup_key", ignoreDuplicates: true },
      )
      .select("id");
    if (insErr) {
      out.falhas += 1;
      logger.warn("[supervisor] ação não gravada", { kind: a.kind, error: insErr.message });
      continue;
    }
    const id = ((ins ?? []) as Array<{ id: string }>)[0]?.id;
    if (!id) continue; // já decidida antes (dedup) — nada a fazer
    if (a.status === "pending_approval") {
      out.pendentes += 1;
      continue;
    }
    if (a.status !== "applied") continue;
    const gravada: AcaoGravada = {
      id,
      organization_id: orgId,
      run_id: claim.runId,
      conversation_id: conv.id,
      contact_id: conv.contact_id,
      lead_id: lead.id,
      kind: a.kind,
      before: a.before,
      after: a.after,
      reason: a.reason,
      evidence: a.evidence,
    };
    const quem = { aprovadorUserId: null, llmCallId, requestId, dispararAutomacoes: config.movimento_dispara_automacoes };
    const res = await executaAcao(admin, deps.pool, gravada, quem);
    await concluiAcao(admin, deps.pool, gravada, quem, res);
    if (res.status === "applied") out.aplicadas += 1;
    if (res.status === "failed") out.falhas += 1;
  }
  return out;
}
