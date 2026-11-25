/**
 * PILAR B — o diagnóstico comercial de um período, em dois níveis.
 *
 * NÍVEL A (geral): universo elegível × analisado, números do CRM pelas réguas
 * existentes (`fn_attendant_metrics`), aderência e falhas por CATEGORIA contadas
 * por atendimento distinto, e a interpretação consultiva.
 *
 * NÍVEL B (até 5 estudos de caso): atendimentos escolhidos para representar os
 * achados do período, cada um com as mensagens REAIS que o sustentam, o que foi
 * positivo, o que faltou, como poderia ter sido melhor (exemplos HIPOTÉTICOS,
 * sempre marcados como tal) e a recorrência da mesma situação.
 *
 * Custo: DUAS chamadas de modelo por diagnóstico, qualquer que seja o volume.
 *  1. geral + agrupamento contextual + escolha dos casos (entrada: só agregados
 *     e a ficha curta de cada atendimento, que as leituras do Pilar A já têm);
 *  2. redação dos casos escolhidos (entrada: a transcrição só desses).
 * O modelo opina; quem aceita, conta e limita é `casos.ts`. Se qualquer chamada
 * falhar, o relatório sai com a parte determinística e diz o que faltou.
 *
 * O contexto segue a prioridade: script da empresa → o que ela disse fazer no
 * onboarding → boas práticas do ramo → critérios gerais.
 */
import { generateObject, type LanguageModel } from "ai";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

import { DEFAULT_CLASSIFIER_MODEL } from "@/lib/ai/gateway";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";

import {
  contaPorCategoria,
  fraseDeRecorrencia,
  MAX_CASOS,
  montaDossies,
  ROTULO_DO_ESTAGIO,
  validaGrupos,
  validaSelecao,
  type CasoSelecionado,
  type Grupo,
  type LeituraDoPeriodo,
} from "./casos";
import { criteriosEmVigor, rotuloDoCriterio, type SupervisorConfig } from "./config";
import { agregaLeituras, agregaPorVendedor, ROTULO_DO_PROBLEMA, type LeituraParaAgregar } from "./metricas";
import { resolverModeloDoSupervisor } from "./modelo";
import { limparDiagnostico } from "./relatorio-tipos";
import { negocioDaOrganizacao, orcamentoEsgotado, quemFalou, registraChamada } from "./observador";
import { horaLocal } from "./prompt";

export const PONTO_DIAGNOSTICAR = "supervisor_diagnose";
/** Fichas de atendimento que cabem na chamada de seleção. Acima disso, as demais só entram nos números. */
const MAX_FICHAS_NO_PROMPT = 150;
const MAX_MENSAGENS_POR_CASO = 40;

const itemSchema = z.object({
  titulo: z.string().max(160),
  descricao: z.string().max(800),
  frequencia_observada: z.string().max(160).describe("ex.: 7 de 20 atendimentos analisados (35%)"),
  evidencias: z.array(z.string().max(200)).max(3),
  impacto: z.string().max(300),
  confianca: z.enum(["alta", "media", "baixa"]),
  acao_recomendada: z.string().max(300),
  indicador: z.string().max(200).describe("como medir a melhora"),
});

export const diagnosticoSchema = z.object({
  resumo_executivo: z.string().max(2000),
  gargalos: z.array(itemSchema).max(6),
  pontos_positivos: z.array(z.string().max(300)).max(5),
  riscos: z.array(z.string().max(300)).max(5),
  recomendacoes_priorizadas: z
    .array(z.object({ prioridade: z.number().int().min(1).max(10), acao: z.string().max(300), indicador: z.string().max(200) }))
    .max(6),
  limitacoes: z.array(z.string().max(300)).max(6),
  grupos: z
    .array(
      z.object({
        categoria: z.string(),
        estagio: z.string(),
        titulo: z.string().max(160).describe("a situação comercial concreta que estes atendimentos têm em comum"),
        membros: z.array(z.string()).max(200).describe("refs dos atendimentos (c1, c2…) com ESSA MESMA situação"),
      }),
    )
    .max(60),
  selecao: z
    .array(
      z.object({
        conversa: z.string().describe("ref do atendimento (c1, c2…)"),
        tipo: z.enum(["problema", "boa_pratica"]),
        motivo: z.string().max(400).describe("por que este atendimento representa bem o achado"),
      }),
    )
    .max(MAX_CASOS),
});
export type Diagnostico = z.infer<typeof diagnosticoSchema>;

export const casosSchema = z.object({
  casos: z
    .array(
      z.object({
        conversa: z.string(),
        contexto: z.string().max(600).describe("o que o cliente buscava e em que pé a negociação estava"),
        evidencias: z.array(z.string()).max(8).describe("refs das mensagens mais relevantes, na ordem (ex.: c1-m2)"),
        positivos: z.array(z.string().max(400)).max(4),
        faltou: z.array(z.object({ titulo: z.string().max(120), explicacao: z.string().max(500) })).max(5),
        como_melhorar: z
          .array(
            z.object({
              quando: z.string().max(200).describe("em que momento da conversa"),
              exemplo_de_mensagem: z.string().max(500).describe("mensagem HIPOTÉTICA que o vendedor poderia ter enviado"),
            }),
          )
          .max(3),
        follow_up_sugerido: z.string().max(500).nullable().describe("mensagem HIPOTÉTICA de acompanhamento, ou null se não couber"),
        resumo: z.string().max(700),
        limitacao: z.string().max(300).nullable().describe("o que não dá para concluir com os dados disponíveis, ou null"),
      }),
    )
    .max(MAX_CASOS),
});
export type CasosRedigidos = z.infer<typeof casosSchema>;

const REGRAS_DE_CONTEXTO = `Contexto, nesta ordem de prioridade: (1) script e critérios cadastrados pela empresa; (2) o que a empresa
disse fazer; (3) boas práticas do ramo dela; (4) critérios gerais de venda consultiva. O ramo ajuda a interpretar e a
dar exemplos adequados (ex.: moda — numeração, disponibilidade, fotos, alternativas, visita à loja; clínica —
acolhimento, dúvidas, agendamento; serviços — diagnóstico, escopo, prazo, proposta). Ele NUNCA substitui evidência,
e não se cobra da equipe prática que não cabe no modelo de venda da empresa. Se o ramo não foi informado, use critérios
gerais e diga isso nas limitações.`;

const REGRAS_DE_JULGAMENTO = `Regras de julgamento comercial:
- Responder o preço quando o cliente pergunta NÃO é falha. A falha é informar o preço sem agregar nenhum valor ao
  produto/serviço (benefício, diferencial, disponibilidade, foto, pergunta que conduza) — de preferência antes,
  ou pelo menos logo depois.
- Não conclua que faltou investigação sem considerar o histórico disponível: a necessidade pode já estar clara.
- "Sem próximo passo" (nada combinado) é diferente de "próximo passo prometido e não cumprido" (algo foi combinado
  e o prazo passou). E um próximo passo combinado cujo prazo ainda não chegou não é falha.
- Falta de follow-up só é falha depois de 24 horas da última mensagem sem retorno programado.
- Agilidade: use os horários locais. Mensagens fora do horário comercial (noite, madrugada, fim de semana) não
  contam como demora até o próximo período comercial. Não elogie nem critique agilidade sem os horários sustentarem.`;

const SYSTEM_GERAL = `Você é um consultor comercial sênior analisando a operação de vendas de uma empresa para o gestor dela.
Você recebe números agregados e a ficha resumida de cada atendimento analisado (c1, c2…).

SUA ENTREGA
1. Diagnóstico geral, em tom consultivo: explique o que está acontecendo, por que importa e o que fazer.
2. "grupos": junte atendimentos que viveram A MESMA SITUAÇÃO COMERCIAL. Equivalência é de contexto, não de palavra:
   mesmo momento da negociação, mesmo tipo de oportunidade, mesma ação que o vendedor deveria ter feito.
   "Não retomou depois de informar um preço" e "não confirmou uma visita que o cliente combinou" são situações
   DIFERENTES, mesmo que as duas sejam falta de acompanhamento. Na dúvida, NÃO junte. Use a categoria e o estágio
   exatamente como aparecem na ficha.
3. "selecao": de ZERO a ${MAX_CASOS} atendimentos para virar estudo de caso. Critérios: relevância comercial, impacto
   plausível (pelo estágio da negociação), recorrência, clareza da evidência, DIVERSIDADE (um caso por situação —
   nunca dois casos da mesma falha) e potencial de ensinar algo prático. Inclua uma boa condução ("boa_pratica")
   quando houver uma que valha ser copiada. Não preencha o limite: menos casos é melhor que caso fraco.

REGRAS
- Use apenas os dados fornecidos. Frequências exatamente como nos números ("7 de 20 atendimentos").
- Não escreva quantas vezes uma situação se repetiu nos estudos de caso: essa conta é feita pelo sistema.
- Correlação não é causalidade. Não atribua prejuízo financeiro sem evidência.
- Diferencie a amostra analisada do universo elegível; se a amostra for pequena, diga.
- Chame os critérios pelos NOMES legíveis fornecidos, nunca por identificadores técnicos.
- Aderência: cada critério tem o SEU denominador (só os atendimentos em que ele se aplicava). Ao citar, diga a base
  ("cumprido em 3 dos 6 atendimentos em que se aplicava"), não o total analisado.
- O resumo executivo é uma interpretação consolidada: o que está acontecendo, o principal gargalo, o que está
  funcionando e por onde começar. Não liste números soltos.
- ${REGRAS_DE_JULGAMENTO}
- ${REGRAS_DE_CONTEXTO}
- Responda em português.
REFERÊNCIAS: os rótulos c1, c2… e c1-m3… existem só para você se orientar. NUNCA os escreva em texto que o gestor
vai ler (resumo, pontos positivos, gargalos, riscos, recomendações, contexto, explicações): para citar um atendimento,
descreva-o pelo que aconteceu ("na conversa sobre o site da clínica"). O único lugar onde rótulos entram é nos campos
de identificação pedidos no formato da resposta.`;

const SYSTEM_CASOS = `Você é um consultor comercial sênior escrevendo estudos de caso de atendimentos para o gestor e os vendedores
de uma empresa. Para cada atendimento você recebe a transcrição REAL (mensagens [cN-mK], com horário local e autor).

PARA CADA CASO
- "contexto": o que o cliente buscava e em que ponto a negociação estava.
- "evidencias": as refs das mensagens que sustentam a análise, em ordem.
- "positivos": o que o vendedor fez bem, se fez. Não invente elogio.
- "faltou": falhas e oportunidades perdidas, explicadas com os FATOS da conversa (horários, o que foi perguntado,
  o que foi respondido). Específico deste atendimento — nada de texto que serviria para qualquer conversa.
- "como_melhorar": o momento e um exemplo de mensagem que o vendedor PODERIA ter enviado. É hipotético: escreva
  como sugestão, nunca como algo que aconteceu.
- "follow_up_sugerido": um exemplo de acompanhamento, só se fizer sentido para o caso; senão null.
- "resumo": avaliação geral e a principal oportunidade de melhoria.
- "limitacao": se a conversa não permite concluir algo (ex.: não dá para saber se houve contato por outro canal), diga.

REGRAS
- Tudo que você afirmar que aconteceu tem de estar na transcrição. Não invente mensagens, horários nem intenções.
- Não diga quantas vezes a situação se repetiu em outros atendimentos: essa conta é feita pelo sistema.
- Não use o nome do cliente (ele não é fornecido): diga "o cliente" ou "a cliente".
- Para cada falha em "faltou", traga em "como_melhorar" a abordagem que a corrigiria naquele momento. Só deixe
  "como_melhorar" vazio num caso de boa condução sem nada a melhorar.
- ${REGRAS_DE_JULGAMENTO}
- ${REGRAS_DE_CONTEXTO}
- Responda em português.
REFERÊNCIAS: os rótulos c1, c2… e c1-m3… existem só para você se orientar. NUNCA os escreva em texto que o gestor
vai ler (resumo, pontos positivos, gargalos, riscos, recomendações, contexto, explicações): para citar um atendimento,
descreva-o pelo que aconteceu ("na conversa sobre o site da clínica"). O único lugar onde rótulos entram é nos campos
de identificação pedidos no formato da resposta.`;

export interface Escopo {
  owner_user_id?: string | null;
  pipeline_id?: string | null;
}

type Chamada<T> = { object: T; inputTokens: number; outputTokens: number; modelId: string } | null;

export interface DepsDoDiagnostico {
  admin: SupabaseClient;
  /** Chamada 1 — geral + grupos + seleção. Injetável para teste. */
  interpretar: (orgId: string, system: string, prompt: string) => Promise<Chamada<Diagnostico>>;
  /** Chamada 2 — redação dos casos. Injetável para teste. */
  redigir: (orgId: string, system: string, prompt: string) => Promise<Chamada<CasosRedigidos>>;
  agora?: () => Date;
}

async function gera<T>(orgId: string, schema: z.ZodType<T>, system: string, prompt: string, temperature: number): Promise<Chamada<T>> {
  const resolvido = await resolverModeloDoSupervisor(createAdminClient(), "supervisor_diagnose", orgId, DEFAULT_CLASSIFIER_MODEL);
  if (!resolvido) return null;
  try {
    const r = await generateObject({
      model: resolvido.model as LanguageModel,
      schema,
      system,
      prompt,
      temperature,
      maxOutputTokens: 12000,
      abortSignal: AbortSignal.timeout(240_000),
    });
    const u = r.usage as { inputTokens?: number; outputTokens?: number } | undefined;
    return { object: r.object as T, inputTokens: u?.inputTokens ?? 0, outputTokens: u?.outputTokens ?? 0, modelId: resolvido.modelId };
  } catch (err) {
    throw Object.assign(err instanceof Error ? err : new Error(String(err)), { modelId: resolvido.modelId });
  }
}
export const interpretarComModelo = (orgId: string, system: string, prompt: string) => gera(orgId, diagnosticoSchema, system, prompt, 0.2);
export const redigirComModelo = (orgId: string, system: string, prompt: string) => gera(orgId, casosSchema, system, prompt, 0.3);

/**
 * O identificador do vendedor não sai da instalação: no texto que vai ao modelo
 * ele vira "Vendedor 1", "Vendedor 2"… (o gestor vê quem é quem nos números da tela).
 */
export function rotulosDeVendedor(ids: readonly string[]): Map<string, string> {
  const m = new Map<string, string>();
  for (const id of ids) if (id && !m.has(id)) m.set(id, `Vendedor ${m.size + 1}`);
  return m;
}
export function rotulaVendedores(texto: string, rotulos: Map<string, string>): string {
  let out = texto;
  for (const [id, rotulo] of rotulos) out = out.split(id).join(rotulo);
  return out;
}

/** Conversas com pelo menos uma mensagem de vendedor humano no período. */
async function universoElegivel(admin: SupabaseClient, orgId: string, de: string, ate: string): Promise<Set<string>> {
  const ids = new Set<string>();
  const { data, error } = await admin
    .from("messages")
    .select("conversation_id")
    .eq("organization_id", orgId)
    .eq("direction", "outbound")
    .in("sent_via", ["user", "external_device", "crm"])
    .gte("sent_at", de)
    .lt("sent_at", ate)
    .limit(20000);
  if (error) throw new Error(`messages: ${error.message}`);
  for (const r of (data ?? []) as Array<{ conversation_id: string }>) ids.add(r.conversation_id);
  return ids;
}

/**
 * Em quais conversas um retorno JÁ ERA DEVIDO. Não é devido quando: a última
 * mensagem é recente (menos que `horas`), o negócio tem tarefa aberta com prazo
 * no futuro (o retorno está programado), ou o contato está num follow-up ativo.
 */
async function conversasComFollowUpDevido(
  admin: SupabaseClient,
  orgId: string,
  leituras: readonly LeituraDoPeriodo[],
  horas: number,
  agora: Date,
): Promise<Set<string>> {
  const convIds = [...new Set(leituras.map((l) => l.conversation_id))];
  const devidas = new Set<string>();
  if (convIds.length === 0) return devidas;
  const leadDe = new Map(leituras.map((l) => [l.conversation_id, l.lead_id]));
  const contatoDe = new Map(leituras.map((l) => [l.conversation_id, l.contact_id]));
  const leadIds = [...new Set([...leadDe.values()].filter((x): x is string => Boolean(x)))];
  const contatoIds = [...new Set([...contatoDe.values()].filter((x): x is string => Boolean(x)))];
  const [{ data: convs }, { data: tarefas }, { data: reguas }] = await Promise.all([
    admin.from("conversations").select("id, last_message_at").eq("organization_id", orgId).in("id", convIds),
    leadIds.length
      ? admin.from("crm_tasks").select("lead_id, due_date").eq("organization_id", orgId).in("lead_id", leadIds).in("status", ["pending", "in_progress"]).gt("due_date", agora.toISOString())
      : Promise.resolve({ data: [] }),
    contatoIds.length
      ? admin.from("followup_enrollments").select("contact_id").eq("organization_id", orgId).in("contact_id", contatoIds).in("status", ["active", "waiting_reply"])
      : Promise.resolve({ data: [] }),
  ]);
  const comTarefa = new Set(((tarefas ?? []) as Array<{ lead_id: string }>).map((t) => t.lead_id));
  const comRegua = new Set(((reguas ?? []) as Array<{ contact_id: string }>).map((r) => r.contact_id));
  const limite = agora.getTime() - horas * 3600 * 1000;
  for (const c of (convs ?? []) as Array<{ id: string; last_message_at: string | null }>) {
    if (!c.last_message_at || new Date(c.last_message_at).getTime() > limite) continue;
    const lead = leadDe.get(c.id);
    const contato = contatoDe.get(c.id);
    if ((lead && comTarefa.has(lead)) || (contato && comRegua.has(contato))) continue;
    devidas.add(c.id);
  }
  return devidas;
}

interface MensagemDoCaso {
  ref: string;
  quem: "cliente" | "vendedor" | "ia" | "automacao";
  texto: string;
  em: string;
  /** true = transcrição de áudio (não o texto digitado). */
  transcricao: boolean;
}

async function mensagensDoCaso(admin: SupabaseClient, orgId: string, ref: string, conversationId: string, de: string, ate: string): Promise<MensagemDoCaso[]> {
  const { data } = await admin
    .from("messages")
    .select("direction, sent_via, body, media_derived_text, type, sent_at")
    .eq("organization_id", orgId)
    .eq("conversation_id", conversationId)
    .gte("sent_at", de)
    .lt("sent_at", ate)
    .order("sent_at", { ascending: false })
    .limit(MAX_MENSAGENS_POR_CASO);
  const linhas = ((data ?? []) as Array<{ direction: "inbound" | "outbound"; sent_via: string; body: string | null; media_derived_text: string | null; type: string; sent_at: string }>)
    .filter((m) => m.type !== "reaction" && m.type !== "system")
    .reverse();
  return linhas.map((m, i) => ({
    ref: `${ref}-m${i + 1}`,
    quem: quemFalou(m),
    texto: (m.body?.trim() || m.media_derived_text?.trim() || `[${m.type}]`).slice(0, 600),
    em: m.sent_at,
    transcricao: !m.body?.trim() && Boolean(m.media_derived_text?.trim()),
  }));
}

const AUTOR: Record<MensagemDoCaso["quem"], string> = { cliente: "CLIENTE", vendedor: "VENDEDOR", ia: "ASSISTENTE_IA", automacao: "AUTOMACAO" };

export async function geraDiagnostico(
  deps: DepsDoDiagnostico,
  orgId: string,
  config: SupervisorConfig,
  periodo: { de: Date; ate: Date },
  escopo: Escopo,
  meta: { requestedBy: string | null; recurring: boolean },
): Promise<{ id: string; status: string }> {
  const { admin } = deps;
  const agora = deps.agora?.() ?? new Date();
  const de = periodo.de.toISOString();
  const ate = periodo.ate.toISOString();

  // ── 1. Leituras do Pilar A no período ────────────────────────────────────────
  let rq = admin
    .from("supervisor_runs")
    .select("conversation_id, lead_id, contact_id, owner_user_id, pipeline_id, last_message_at, summary, analysis")
    .eq("organization_id", orgId)
    .in("status", ["analyzed", "ambiguous"])
    .gte("last_message_at", de)
    .lt("last_message_at", ate)
    .limit(5000);
  if (escopo.owner_user_id) rq = rq.eq("owner_user_id", escopo.owner_user_id);
  if (escopo.pipeline_id) rq = rq.eq("pipeline_id", escopo.pipeline_id);
  const { data: runs, error: runsErr } = await rq;
  if (runsErr) throw new Error(`supervisor_runs: ${runsErr.message}`);
  const leituras = (runs ?? []) as Array<LeituraDoPeriodo & LeituraParaAgregar>;
  const agregado = agregaLeituras(leituras);
  const porVendedor = escopo.owner_user_id ? [] : agregaPorVendedor(leituras);

  const devidas = await conversasComFollowUpDevido(admin, orgId, leituras, config.followup_devido_horas, agora);
  const dossies = montaDossies(leituras, (id) => devidas.has(id));
  const categorias = contaPorCategoria(dossies);

  const { data: orgRow } = await admin.from("organizations").select("display_name, timezone, onboarding_state").eq("id", orgId).maybeSingle();
  const org = orgRow as { display_name: string | null; timezone: string | null; onboarding_state: unknown } | null;
  const negocio = negocioDaOrganizacao(org?.onboarding_state);
  const fuso = org?.timezone ?? null;

  // ── 2. Números do CRM (réguas existentes) ───────────────────────────────────
  const elegiveis = await universoElegivel(admin, orgId, de, ate);
  const [{ data: atendentes }, { data: acoes }, { data: perdidos }, { data: atrasadas }, { data: scores }] = await Promise.all([
    admin.rpc("fn_attendant_metrics" as never, { p_org: orgId, p_from: de, p_to: ate, p_owner: escopo.owner_user_id ?? null } as never),
    admin.from("supervisor_actions").select("kind, status").eq("organization_id", orgId).gte("created_at", de).lt("created_at", ate).limit(10000),
    admin.from("crm_leads").select("lost_reason").eq("organization_id", orgId).eq("status", "lost").gte("closed_at", de).lt("closed_at", ate).limit(5000),
    admin.from("crm_tasks").select("id").eq("organization_id", orgId).in("status", ["pending", "in_progress"]).lt("due_date", agora.toISOString()).limit(5000),
    admin.from("crm_lead_scores").select("ai_probability_band").eq("organization_id", orgId).not("ai_probability_band", "is", null).limit(10000),
  ]);
  const contagem = <T extends Record<string, unknown>>(rows: T[] | null, chave: (r: T) => string) => {
    const m: Record<string, number> = {};
    for (const r of rows ?? []) m[chave(r)] = (m[chave(r)] ?? 0) + 1;
    return m;
  };
  const { formal, criterios } = criteriosEmVigor(config);
  const metricas = {
    periodo: { de, ate },
    escopo,
    universo_elegivel: elegiveis.size,
    conversas_analisadas: agregado.conversas_analisadas,
    agregado,
    /** Atendimentos distintos por categoria, já sem follow-up não devido e sem falha sem evidência. */
    categorias,
    desconsideradas: contagem(dossies.flatMap((d) => d.desconsideradas) as Array<Record<string, unknown>>, (r) => String(r.motivo)),
    rotulos_dos_criterios: Object.fromEntries(agregado.aderencia.map((a) => [a.criterio, rotuloDoCriterio(a.criterio, config)])),
    por_vendedor: porVendedor.map((v) => ({
      owner_user_id: v.owner_user_id,
      conversas: v.agregado.conversas_analisadas,
      problemas: v.agregado.problemas.slice(0, 3).map((p) => ({ codigo: p.codigo, conversas: p.conversas })),
      aderencia: v.agregado.aderencia.map((a) => ({ criterio: a.criterio, pct: a.pct })),
    })),
    desempenho: atendentes ?? null,
    acoes_do_supervisor: contagem((acoes ?? []) as Array<{ kind: string; status: string }>, (r) => `${r.kind}:${r.status}`),
    motivos_de_perda: contagem((perdidos ?? []) as Array<{ lost_reason: string | null }>, (r) => r.lost_reason ?? "sem_motivo"),
    tarefas_atrasadas: (atrasadas ?? []).length,
    faixas_de_score: contagem((scores ?? []) as Array<{ ai_probability_band: string }>, (r) => r.ai_probability_band),
  };

  const contexto = {
    organizacao: org?.display_name ?? null,
    fuso,
    nicho: negocio,
    criterios_formais: formal,
    base: formal ? "script" : negocio ? "ramo" : "geral",
  };
  const base = {
    organization_id: orgId,
    period_from: de,
    period_to: ate,
    scope: escopo,
    conversations_eligible: elegiveis.size,
    conversations_analyzed: agregado.conversas_analisadas,
    metrics: metricas,
    recurring: meta.recurring,
    requested_by: meta.requestedBy,
  };
  const grava = async (extra: Record<string, unknown>) => {
    const { data, error } = await admin.from("supervisor_reports").insert({ ...base, ...extra }).select("id, status").single();
    if (error) throw new Error(`supervisor_reports: ${error.message}`);
    return data as { id: string; status: string };
  };

  if (agregado.conversas_analisadas === 0) {
    return grava({
      status: "insufficient",
      diagnosis: {
        versao: 2,
        contexto,
        limitacoes: [
          elegiveis.size === 0
            ? "Nenhuma conversa conduzida por vendedor humano no período."
            : `${elegiveis.size} conversa(s) elegível(is), mas nenhuma lida pelo Supervisor no período — confira se ele está ligado e quais funis monitora.`,
        ],
      },
    });
  }

  const limitacoesDoSistema: string[] = [];
  if (agregado.conversas_analisadas < 10) limitacoesDoSistema.push(`Amostra pequena: ${agregado.conversas_analisadas} atendimento(s) analisado(s).`);
  if (elegiveis.size > agregado.conversas_analisadas) {
    limitacoesDoSistema.push(`${elegiveis.size - agregado.conversas_analisadas} atendimento(s) elegível(is) do período ainda não foram lidos pelo Supervisor e não entram nos números.`);
  }
  if (!formal && !negocio) limitacoesDoSistema.push("A empresa não informou o ramo de atuação nem cadastrou um script: a avaliação usou critérios gerais.");
  const naoDevidos = metricas.desconsideradas.follow_up_ainda_nao_devido ?? 0;
  if (naoDevidos > 0) limitacoesDoSistema.push(`${naoDevidos} apontamento(s) de falta de follow-up não foram contados: o prazo de ${config.followup_devido_horas} h ainda não tinha passado ou o retorno já estava programado.`);

  /** Monta o diagnóstico só com o que o código sabe — é também a saída de emergência. */
  const fecha = async (
    geral: Partial<Diagnostico> | null,
    grupos: Grupo[],
    selecionados: CasoSelecionado[],
    redigidos: CasosRedigidos["casos"] | null,
    mensagens: Map<string, MensagemDoCaso[]>,
    titulos: Map<string, string>,
    extra: { llm_call_id?: string | null; error?: string | null; avisos?: string[] },
  ) => {
    /**
     * Completo = interpretação geral E redação dos casos vieram do modelo. Sem
     * isso, o relatório tem números e evidências, mas NÃO é análise consultiva:
     * não há recomendações de abordagem nem sugestões de follow-up. A tela e o
     * PDF dizem isso em destaque, em vez de deixar parecer que é a mesma coisa.
     */
    const completo = geral !== null && (selecionados.length === 0 || redigidos !== null);
    const porRef = new Map(dossies.map((d) => [d.ref, d]));
    const casos = selecionados.map((sel) => {
      const d = porRef.get(sel.ref)!;
      const texto = redigidos?.find((r) => r.conversa?.trim() === sel.ref) ?? null;
      const msgs = mensagens.get(sel.ref) ?? [];
      const citadas = (texto?.evidencias ?? []).map((r) => msgs.find((m) => m.ref === r.trim())).filter((m): m is MensagemDoCaso => Boolean(m));
      const grupo = grupos.find((g) => g.id === sel.grupo_id) ?? null;
      return {
        conversation_id: d.conversation_id,
        lead_id: d.lead_id,
        contact_id: d.contact_id,
        titulo: (d.lead_id && titulos.get(d.lead_id)) || "Atendimento",
        tipo: sel.tipo,
        motivo_da_escolha: sel.motivo_da_escolha,
        situacao: grupo?.titulo ?? null,
        categoria: grupo?.categoria ?? null,
        estagio: grupo ? ROTULO_DO_ESTAGIO[grupo.estagio] : null,
        contexto: texto?.contexto ?? d.resumo,
        // Mensagens REAIS, na ordem em que aconteceram. Sem citação válida do
        // modelo, mostram-se as primeiras da conversa — nunca texto reescrito.
        evidencias: (citadas.length > 0 ? citadas : msgs.slice(0, 8))
          .sort((a, b) => a.em.localeCompare(b.em))
          .map((m) => ({ quem: m.quem, texto: m.texto, em: m.em, transcricao: m.transcricao })),
        positivos: texto?.positivos ?? d.positivos,
        faltou: texto?.faltou ?? d.falhas.map((f) => ({ titulo: f.situacao, explicacao: f.descricao })),
        como_melhorar: texto?.como_melhorar ?? [],
        follow_up_sugerido: texto?.follow_up_sugerido ?? null,
        resumo: texto?.resumo ?? d.resumo,
        limitacao: texto ? texto.limitacao : "A redação detalhada deste caso não pôde ser gerada; o conteúdo acima vem da leitura automática da conversa.",
        recorrencia: grupo && sel.outros_atendimentos > 0
          ? { grupo_id: grupo.id, outros: sel.outros_atendimentos, frase: fraseDeRecorrencia(sel.outros_atendimentos), conversation_ids: grupo.conversation_ids.filter((c) => c !== d.conversation_id) }
          : null,
        outros_achados: sel.outros_achados,
      };
    });
    return grava({
      status: "done",
      error: extra.error ?? null,
      llm_call_id: extra.llm_call_id ?? null,
      // Rótulos internos (c1, c2…) nunca chegam ao gestor: viram o título do caso.
      diagnosis: limparDiagnostico({
        versao: 2,
        completo,
        contexto,
        resumo_executivo: geral?.resumo_executivo ?? null,
        gargalos: geral?.gargalos ?? [],
        pontos_positivos: geral?.pontos_positivos ?? [],
        riscos: geral?.riscos ?? [],
        recomendacoes_priorizadas: geral?.recomendacoes_priorizadas ?? [],
        limitacoes: [...(geral?.limitacoes ?? []), ...limitacoesDoSistema, ...(extra.avisos ?? [])],
        grupos,
        casos,
      }, new Map(selecionados.map((sel, i) => [sel.ref, casos[i]!.titulo]))),
    });
  };

  const vazio = new Map<string, MensagemDoCaso[]>();
  const semTitulos = new Map<string, string>();
  const reserva = async (aviso: string, erro?: string) => {
    const grupos = validaGrupos(dossies, null);
    const selecionados = validaSelecao(dossies, grupos, null);
    const { mensagens, titulos } = await materialDosCasos(selecionados);
    return fecha(null, grupos, selecionados, null, mensagens, titulos, { avisos: [aviso], error: erro ?? null });
  };
  const materialDosCasos = async (selecionados: CasoSelecionado[]) => {
    const mensagens = new Map<string, MensagemDoCaso[]>();
    for (const s of selecionados) mensagens.set(s.ref, await mensagensDoCaso(admin, orgId, s.ref, s.conversation_id, de, ate));
    const leadIds = selecionados.map((s) => dossies.find((d) => d.ref === s.ref)!.lead_id).filter((x): x is string => Boolean(x));
    const titulos = new Map<string, string>();
    if (leadIds.length) {
      const { data } = await admin.from("crm_leads").select("id, title").eq("organization_id", orgId).in("id", leadIds);
      for (const l of (data ?? []) as Array<{ id: string; title: string }>) titulos.set(l.id, l.title);
    }
    return { mensagens, titulos };
  };

  if (await orcamentoEsgotado(orgId)) {
    return reserva("Interpretação não gerada: o orçamento de IA do mês acabou. Os números e os casos abaixo vêm da leitura automática.");
  }

  // ── 3. Chamada 1: geral + agrupamento + seleção ────────────────────────────
  const rotulos = rotulosDeVendedor([
    ...porVendedor.map((v) => v.owner_user_id),
    ...(((atendentes as { attendants?: Array<{ user_id: string }> } | null)?.attendants ?? []).map((a) => a.user_id)),
  ]);
  const comConteudo = dossies.filter((d) => d.falhas.length > 0 || d.positivos.length > 0);
  const fichas = comConteudo.slice(0, MAX_FICHAS_NO_PROMPT);
  if (comConteudo.length > fichas.length) {
    limitacoesDoSistema.push(`A escolha dos estudos de caso considerou ${fichas.length} dos ${comConteudo.length} atendimentos com achados; os demais entram só nos números.`);
  }
  const contextoNoPrompt = [
    negocio ? `O que a empresa faz (informado por ela no cadastro): ${negocio}` : "A empresa NÃO informou o ramo de atuação.",
    formal ? "A empresa cadastrou critérios próprios (SCRIPT FORMAL) — eles mandam." : "A empresa não cadastrou script: os critérios abaixo são boas práticas.",
    config.script.texto.trim() ? `SCRIPT COMERCIAL DA EMPRESA:\n${config.script.texto.trim()}` : "",
  ].filter(Boolean);
  const promptGeral = [
    `Período: ${horaLocal(de, fuso) ?? de} a ${horaLocal(ate, fuso) ?? ate}. Universo elegível: ${elegiveis.size} atendimentos com vendedor humano. Analisados pelo Supervisor: ${agregado.conversas_analisadas}.`,
    ...contextoNoPrompt,
    "",
    "CRITÉRIOS DE ATENDIMENTO (nome legível — definição):",
    ...criterios.map((c) => `- ${rotuloDoCriterio(c.id, config)} — ${c.descricao}`),
    "",
    "ADERÊNCIA POR CRITÉRIO (atendimentos):",
    ...agregado.aderencia.map((a) => `- ${rotuloDoCriterio(a.criterio, config)}: cumprido em ${a.cumpridas} de ${a.avaliadas} (${a.pct ?? "-"}%)`),
    "",
    "FALHAS POR CATEGORIA (atendimentos distintos, já conferidas):",
    ...(categorias.length ? categorias.map((c) => `- ${ROTULO_DO_PROBLEMA[c.codigo]}: ${c.atendimentos} de ${agregado.conversas_analisadas}`) : ["- nenhuma falha comprovada no período"]),
    "",
    `DESFECHOS (atendimentos): ${JSON.stringify(agregado.desfechos)}`,
    `OBJEÇÕES RECORRENTES: ${JSON.stringify(agregado.objecoes_recorrentes)}`,
    `TAREFAS ATRASADAS AGORA: ${metricas.tarefas_atrasadas}`,
    `MOTIVOS DE PERDA REGISTRADOS NO PERÍODO: ${JSON.stringify(metricas.motivos_de_perda)}`,
    `FAIXAS DE SCORE DOS NEGÓCIOS: ${JSON.stringify(metricas.faixas_de_score)}`,
    `DESEMPENHO POR ATENDENTE (ganhos, perdas, 1ª resposta em s): ${rotulaVendedores(JSON.stringify((atendentes as { attendants?: unknown } | null)?.attendants ?? []), rotulos)}`,
    "Refira-se aos vendedores pelos rótulos (Vendedor 1, Vendedor 2…).",
    "",
    "FICHAS DOS ATENDIMENTOS (para 'grupos' e 'selecao'):",
    ...fichas.map((d) =>
      [
        `${d.ref} — ${d.resumo.slice(0, 300)}${d.desfecho ? ` [desfecho: ${d.desfecho}]` : ""}`,
        ...d.falhas.map((f) => `   falha [categoria=${f.categoria}; estagio=${f.estagio}] ${f.situacao} — ${f.descricao.slice(0, 300)}`),
        ...d.positivos.map((p) => `   positivo: ${p.slice(0, 200)}`),
      ].join("\n"),
    ),
  ].join("\n");

  const t0 = Date.now();
  let geral: Chamada<Diagnostico>;
  try {
    geral = await deps.interpretar(orgId, SYSTEM_GERAL, promptGeral);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn("[supervisor] interpretação falhou — relatório com a parte determinística", { organization_id: orgId, error: msg });
    await registraChamada(admin, orgId, null, { purpose: "supervisor_diagnose" }, { modelId: (err as { modelId?: string }).modelId ?? "desconhecido", inputTokens: 0, outputTokens: 0 }, Date.now() - t0, msg);
    return reserva("A interpretação falhou; os números e os casos abaixo vêm da leitura automática.", msg.slice(0, 500));
  }
  if (!geral) return reserva("Interpretação não gerada: nenhum modelo de IA disponível. Os números e os casos abaixo vêm da leitura automática.");
  const llmCallId = await registraChamada(admin, orgId, null, { purpose: "supervisor_diagnose" }, geral, Date.now() - t0, null);

  const grupos = validaGrupos(dossies, geral.object.grupos);
  const selecionados = validaSelecao(dossies, grupos, geral.object.selecao);
  if (selecionados.length === 0) return fecha(geral.object, grupos, [], null, vazio, semTitulos, { llm_call_id: llmCallId });

  // ── 4. Chamada 2: redação dos casos escolhidos ──────────────────────────────
  const { mensagens, titulos } = await materialDosCasos(selecionados);
  const promptCasos = [
    ...contextoNoPrompt,
    "",
    ...selecionados.map((s) => {
      const d = dossies.find((x) => x.ref === s.ref)!;
      const g = grupos.find((x) => x.id === s.grupo_id);
      return [
        `===== CASO ${s.ref} (${s.tipo === "boa_pratica" ? "exemplo de boa condução" : "oportunidade de melhoria"}) =====`,
        g ? `Situação que este caso representa: ${g.titulo} (${ROTULO_DO_ESTAGIO[g.estagio]})` : "",
        s.outros_achados.length ? `Outros achados neste mesmo atendimento: ${s.outros_achados.join("; ")}` : "",
        `Leitura automática: ${d.resumo.slice(0, 300)}`,
        "TRANSCRIÇÃO (horário local da empresa):",
        ...(mensagens.get(s.ref) ?? []).map((m) => `[${m.ref}] ${horaLocal(m.em, fuso) ?? m.em} ${AUTOR[m.quem]}${m.transcricao ? " (áudio transcrito)" : ""}: ${m.texto}`),
      ]
        .filter(Boolean)
        .join("\n");
    }),
  ].join("\n");

  const t1 = Date.now();
  try {
    const red = await deps.redigir(orgId, SYSTEM_CASOS, promptCasos);
    if (red) await registraChamada(admin, orgId, null, { purpose: "supervisor_diagnose" }, red, Date.now() - t1, null);
    return fecha(geral.object, grupos, selecionados, red?.object.casos ?? null, mensagens, titulos, { llm_call_id: llmCallId });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await registraChamada(admin, orgId, null, { purpose: "supervisor_diagnose" }, { modelId: (err as { modelId?: string }).modelId ?? "desconhecido", inputTokens: 0, outputTokens: 0 }, Date.now() - t1, msg);
    return fecha(geral.object, grupos, selecionados, null, mensagens, titulos, { llm_call_id: llmCallId, error: msg.slice(0, 500) });
  }
}

/** Relatório recorrente vencido? (semanal = 7 dias, mensal = 30 dias desde o último). */
export function recorrenteVencido(freq: SupervisorConfig["relatorio_recorrente"], ultimo: string | null, agora: Date): { de: Date; ate: Date } | null {
  if (freq === "desligado") return null;
  const dias = freq === "semanal" ? 7 : 30;
  if (ultimo && agora.getTime() - new Date(ultimo).getTime() < dias * 24 * 3600 * 1000) return null;
  return { de: new Date(agora.getTime() - dias * 24 * 3600 * 1000), ate: agora };
}
