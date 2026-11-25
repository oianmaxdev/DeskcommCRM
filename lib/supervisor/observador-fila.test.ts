/**
 * A FILA do Supervisor (achado A da auditoria de 2026-11-25).
 *
 * Volume com modelo simulado: centenas de conversas, conversas antigas já
 * lidas, conversas novas, reivindicações presas e várias organizações. O que se
 * mede é QUEM é lido em cada rodada — não o conteúdo da leitura.
 *
 * Reprodução: o primeiro caso, rodado contra o código anterior (commit
 * 724347ae5), terminava com 0 das 50 conversas novas lidas — a consulta pegava
 * as 100 mais antigas, todas já lidas, e descartava depois.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/ai/budget/check", () => ({
  getBudgetStatus: vi.fn(async () => ({ enforcement_mode: "off", monthly_limit_cents: 0, current_month_consumed_cents: 0 })),
}));
vi.mock("@/lib/ai/cost", () => ({ computeCost: vi.fn(async () => 1) }));
vi.mock("@/lib/ai/gateway-binding", () => ({ resolverModeloDoPonto: vi.fn(async () => null) }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({}) }));
vi.mock("@/lib/leads/score-writer", () => ({ recalculaScoreDoLead: vi.fn(async () => ({ leadId: "x", gravou: true })) }));
vi.mock("@/lib/followup/enroll", () => ({ enrollFollowupFlow: vi.fn(async () => ({ ok: true, enrollment: {} })) }));

import type { Analise } from "./analise";
import { lerConfig } from "./config";
import { observaOrganizacao, rodadaDoSupervisor, type ChamadaDeModelo, type DepsDoObservador } from "./observador";
import { BancoEmMemoria } from "./testing/banco-em-memoria";

const PIPE = "00000000-0000-4000-8000-0000000000f1";
const STAGE = "00000000-0000-4000-8000-0000000000e1";
const VENDEDOR = "00000000-0000-4000-8000-0000000000aa";
const AGORA_INICIAL = new Date("2026-11-25T15:00:00Z").getTime();
const CONFIG = lerConfig({ pipelines: [PIPE], silencio_minutos: 20, max_conversas_por_rodada: 20 });

const SEM_FATO: Analise = {
  resumo: "Cumprimento, sem fato comercial.",
  informacao_suficiente: false,
  negocio: { lead_ref: null, confianca: "baixa", motivo: "" },
  etapa: null,
  desfecho: null,
  qualificacao: { budget: null, timeline: null, need: null, authority: null },
  compromissos: [],
  objecoes_em_aberto: [],
  proxima_acao: null,
  campos: [],
  valor_do_negocio_centavos: null,
  tags: [],
  tarefas: [],
  precisa_follow_up: { necessario: false, motivo: "" },
  aderencia: [],
  problemas: [],
  pontos_positivos: [],
} as unknown as Analise;

let db: BancoEmMemoria;
let agora: number;
let lidasPor: Map<string, number>;
const org = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

function semeiaOrg(o: string) {
  db.linhas("crm_pipelines").push({ id: `${PIPE}`, organization_id: o, name: "Vendas", settings: { fields: [], lost_reasons: [] } });
  db.linhas("crm_stages").push({ id: STAGE, organization_id: o, pipeline_id: PIPE, name: "Novo", position: 1, is_won: false, is_lost: false, is_archived: false, requires_human: false, description: null });
  db.linhas("organizations").push({ id: o, timezone: "America/Sao_Paulo", onboarding_state: {} });
}

/** Uma conversa humana cuja última mensagem foi há `minutosAtras`. */
function conversa(o: string, n: number, minutosAtras: number): { id: string; lastId: string; lastAt: string } {
  // id único por (organização, n): o sufixo da organização entra no 4º bloco.
  const id = `00000000-0000-4000-a${o.slice(-3)}-${String(n).padStart(12, "0")}`;
  const contact = `c-${o}-${n}`;
  const lastAt = new Date(AGORA_INICIAL - minutosAtras * 60_000).toISOString();
  const lastId = `${id}-m1`;
  db.linhas("contacts").push({ id: contact, organization_id: o, is_blocked: false, is_anonymized: false });
  db.linhas("conversations").push({ id, organization_id: o, contact_id: contact, assigned_to_user_id: VENDEDOR, status: "open", is_group: false, last_message_at: lastAt });
  db.linhas("messages").push(
    { id: `${id}-m0`, organization_id: o, conversation_id: id, direction: "inbound", sent_via: "crm", sent_by_user_id: null, body: "Oi", media_derived_text: null, type: "text", sent_at: new Date(Date.parse(lastAt) - 60_000).toISOString() },
    { id: lastId, organization_id: o, conversation_id: id, direction: "outbound", sent_via: "user", sent_by_user_id: VENDEDOR, body: "Olá!", media_derived_text: null, type: "text", sent_at: lastAt },
  );
  db.linhas("crm_leads").push({ id: `lead-${id}`, organization_id: o, contact_id: contact, pipeline_id: PIPE, stage_id: STAGE, status: "open", title: `N${n}`, value_cents: null, custom_fields: {}, tags: [], owner_user_id: VENDEDOR });
  return { id, lastId, lastAt };
}

/** A conversa já foi lida até a última mensagem (leitura concluída). */
function jaLida(o: string, c: { id: string; lastId: string; lastAt: string }, status = "analyzed", skip_reason: string | null = null, criadaHaMin = 60) {
  db.linhas("supervisor_runs").push({
    id: `run-${c.id}-${status}`,
    organization_id: o,
    conversation_id: c.id,
    contact_id: `c-${o}`,
    last_message_at: c.lastAt,
    last_message_id: c.lastId,
    status,
    skip_reason,
    summary: "",
    analysis: {},
    created_at: new Date(agora - criadaHaMin * 60_000).toISOString(),
  });
}

function deps(): DepsDoObservador {
  return {
    admin: db as unknown as SupabaseClient,
    pool: null,
    agora: () => new Date(agora),
    analisar: async (o: string, _s: string, prompt: string): Promise<ChamadaDeModelo> => {
      // Cada leitura "custa" 1 s de relógio — é o que faz o prazo da rodada morder.
      agora += 1000;
      lidasPor.set(o, (lidasPor.get(o) ?? 0) + 1);
      void prompt;
      return { object: SEM_FATO, inputTokens: 10, outputTokens: 5, modelId: "teste/simulado" };
    },
  };
}

/** Conversas com leitura CONCLUÍDA até a última mensagem. */
function concluidas(o: string): Set<string> {
  return new Set(
    db
      .linhas("supervisor_runs")
      .filter((r) => r.organization_id === o && r.status !== "failed" && r.skip_reason !== "em_processamento")
      .map((r) => r.conversation_id as string),
  );
}

beforeEach(() => {
  db = new BancoEmMemoria();
  agora = AGORA_INICIAL;
  lidasPor = new Map();
});

describe("a fila do Supervisor não deixa conversa nova para trás", () => {
  it("150 elegíveis, as 100 mais antigas já lidas: as 50 novas são lidas em 3 rodadas", async () => {
    const o = org(1);
    semeiaOrg(o);
    const antigas = Array.from({ length: 100 }, (_, i) => conversa(o, i, 5000 - i)); // 3,5 dias atrás
    const novas = Array.from({ length: 50 }, (_, i) => conversa(o, 1000 + i, 120 - i)); // 2 h atrás
    for (const c of antigas) jaLida(o, c);

    for (let rodada = 0; rodada < 3; rodada++) await observaOrganizacao(deps(), o, CONFIG, { requestId: `r${rodada}` });

    const lidas = concluidas(o);
    expect(novas.filter((c) => lidas.has(c.id))).toHaveLength(50);
    // Nenhuma antiga foi relida: o modelo foi chamado 50 vezes, não 150.
    expect(lidasPor.get(o)).toBe(50);
  });

  it("reivindicação EM ANDAMENTO de um processo morto é retomada depois de 15 min", async () => {
    const o = org(2);
    semeiaOrg(o);
    const c = conversa(o, 1, 120);
    jaLida(o, c, "skipped", "em_processamento", 30); // morreu há 30 min, no meio da leitura

    await observaOrganizacao(deps(), o, CONFIG, { requestId: "r" });
    expect(lidasPor.get(o)).toBe(1);
  });

  it("reivindicação RECENTE (falha há 2 min) não ocupa vaga da rodada", async () => {
    const o = org(3);
    semeiaOrg(o);
    const falhando = Array.from({ length: 20 }, (_, i) => conversa(o, i, 300 - i));
    for (const c of falhando) jaLida(o, c, "failed", null, 2);
    const novas = Array.from({ length: 5 }, (_, i) => conversa(o, 100 + i, 100 - i));

    await observaOrganizacao(deps(), o, CONFIG, { requestId: "r" });
    const lidas = concluidas(o);
    expect(novas.every((c) => lidas.has(c.id))).toBe(true);
    expect(lidasPor.get(o)).toBe(5);
  });

  it("conversa com mensagem NOVA depois da leitura volta para a fila", async () => {
    const o = org(4);
    semeiaOrg(o);
    const c = conversa(o, 1, 600);
    jaLida(o, c);
    // chega mensagem nova; a última leitura ficou para trás
    const novaAt = new Date(AGORA_INICIAL - 60 * 60_000).toISOString();
    db.linhas("messages").push({ id: `${c.id}-m2`, organization_id: o, conversation_id: c.id, direction: "inbound", sent_via: "crm", sent_by_user_id: null, body: "E aí?", media_derived_text: null, type: "text", sent_at: novaAt });
    db.linhas("conversations").find((x) => x.id === c.id)!.last_message_at = novaAt;

    await observaOrganizacao(deps(), o, CONFIG, { requestId: "r" });
    expect(lidasPor.get(o)).toBe(1);
  });
});

describe("justiça entre organizações e volume", () => {
  function liga(o: string) {
    db.linhas("supervisor_settings").push({ organization_id: o, enabled: true, config: CONFIG, ultima_rodada_em: null });
  }

  it("com prazo curto, organizações diferentes são atendidas em rodadas seguidas — nenhuma fica sempre por último", async () => {
    const orgs = [org(10), org(11), org(12)];
    for (const o of orgs) {
      semeiaOrg(o);
      liga(o);
      for (let i = 0; i < 30; i++) conversa(o, i, 200 - i);
    }
    // Prazo de 5 s e 1 s por leitura: cabe ~uma organização parcial por rodada.
    for (let rodada = 0; rodada < 3; rodada++) await rodadaDoSupervisor(deps(), `r${rodada}`, 5_000);
    for (const o of orgs) expect(lidasPor.get(o) ?? 0, o).toBeGreaterThan(0);
  });

  it("300 conversas em 2 organizações: todas lidas, cada uma exatamente uma vez", async () => {
    const orgs = [org(20), org(21)];
    for (const o of orgs) {
      semeiaOrg(o);
      liga(o);
      for (let i = 0; i < 150; i++) conversa(o, i, 3000 - i * 10);
    }
    for (let rodada = 0; rodada < 10; rodada++) await rodadaDoSupervisor(deps(), `r${rodada}`, 10_000_000);
    for (const o of orgs) {
      expect(concluidas(o).size, o).toBe(150);
      expect(lidasPor.get(o), o).toBe(150);
    }
    // e uma 11ª rodada não chama o modelo nenhuma vez
    const antes = [...lidasPor.values()].reduce((a, b) => a + b, 0);
    await rodadaDoSupervisor(deps(), "r-extra", 10_000_000);
    expect([...lidasPor.values()].reduce((a, b) => a + b, 0)).toBe(antes);
  });
});
