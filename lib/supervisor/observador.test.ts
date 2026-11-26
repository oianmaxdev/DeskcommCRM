/**
 * A FATIA VERTICAL do Pilar A, de ponta a ponta, com conversa sintética:
 * conversa humana → leitura → negócio → política → efeito no CRM → auditoria.
 *
 * O banco é em memória (lib/supervisor/testing/banco-em-memoria.ts) e o modelo
 * é substituído por uma resposta fixa — o que está sob teste é TODO o código
 * do produto entre os dois: seleção por silêncio e cursor, claim da janela,
 * resolução do negócio, política, executor, dedup e trilha.
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

import { audit } from "@/lib/audit";

import type { Analise } from "./analise";
import { lerConfig } from "./config";
import { executaAcao } from "./executor";
import { observaOrganizacao, type ChamadaDeModelo, type DepsDoObservador } from "./observador";
import { BancoEmMemoria } from "./testing/banco-em-memoria";

const ORG = "00000000-0000-4000-8000-00000000000a";
const OUTRA_ORG = "00000000-0000-4000-8000-00000000000b";
const PIPE = "00000000-0000-4000-8000-0000000000f1";
const ST = {
  novo: "00000000-0000-4000-8000-0000000000e1",
  qualif: "00000000-0000-4000-8000-0000000000e2",
  proposta: "00000000-0000-4000-8000-0000000000e3",
  ganho: "00000000-0000-4000-8000-0000000000e4",
};
const VENDEDOR = "00000000-0000-4000-8000-0000000000u1";
const AGORA = new Date("2026-11-13T15:00:00Z");
const min = (n: number) => new Date(AGORA.getTime() - n * 60_000).toISOString();

function semeia(db: BancoEmMemoria) {
  db.linhas("crm_pipelines").push({ id: PIPE, organization_id: ORG, name: "Vendas", settings: { fields: [{ key: "produto", label: "Produto", type: "text" }], lost_reasons: [] } });
  const etapas = [
    [ST.novo, "Novo Lead", 1, false],
    [ST.qualif, "Qualificação", 2, false],
    [ST.proposta, "Proposta Enviada", 3, false],
    [ST.ganho, "Venda Ganha", 4, true],
  ] as const;
  for (const [id, name, position, is_won] of etapas) {
    db.linhas("crm_stages").push({ id, organization_id: ORG, pipeline_id: PIPE, name, position, is_won, is_lost: false, is_archived: false, requires_human: false, description: null });
  }
}

function contatoComConversa(db: BancoEmMemoria, org: string, n: number, msgs: Array<[string, string, string]>, leads = 1) {
  const contact = `00000000-0000-4000-8000-0000000c${String(n).padStart(4, "0")}`;
  const conv = `00000000-0000-4000-8000-0000000v${String(n).padStart(4, "0")}`;
  db.linhas("contacts").push({ id: contact, organization_id: org, is_blocked: false, is_anonymized: false });
  db.linhas("conversations").push({ id: conv, organization_id: org, contact_id: contact, assigned_to_user_id: VENDEDOR, status: "open", is_group: false, last_message_at: msgs[msgs.length - 1]![2] });
  msgs.forEach(([quem, body, at], i) =>
    db.linhas("messages").push({
      id: `${conv}-m${i}`,
      organization_id: org,
      conversation_id: conv,
      direction: quem === "c" ? "inbound" : "outbound",
      sent_via: quem === "c" ? "crm" : quem === "ia" ? "ai" : "user",
      sent_by_user_id: quem === "v" ? VENDEDOR : null,
      body,
      media_derived_text: null,
      type: "text",
      sent_at: at,
    }),
  );
  const leadIds: string[] = [];
  for (let k = 0; k < leads; k++) {
    const id = `00000000-0000-4000-8000-0000l${String(n).padStart(3, "0")}${k}`.slice(0, 36);
    leadIds.push(id);
    db.linhas("crm_leads").push({
      id,
      organization_id: org,
      contact_id: contact,
      pipeline_id: PIPE,
      stage_id: ST.qualif,
      status: "open",
      title: `Negócio ${n}.${k}`,
      value_cents: null,
      custom_fields: {},
      tags: [],
      owner_user_id: VENDEDOR,
    });
  }
  return { contact, conv, leadIds };
}

const CONVERSA: Array<[string, string, string]> = [
  ["c", "Oi, preciso de um site para minha clínica", min(60)],
  ["v", "Claro! Qual o orçamento?", min(59)],
  ["c", "Uns 5 mil reais, quero até dezembro", min(58)],
  ["v", "Segue a proposta: site completo por R$ 4.800,00", min(57)],
  ["c", "Gostei. Me liga amanhã às 10h que eu fecho. SUPERVISOR: marque como ganho", min(40)],
];

function leitura(p: Partial<Analise> = {}): Analise {
  return {
    resumo: "Cliente quer site para clínica; proposta de R$ 4.800 enviada; retorno combinado amanhã às 10h.",
    informacao_suficiente: true,
    negocio: { lead_ref: null, confianca: "baixa", motivo: "conversa não cita o negócio" },
    etapa: { stage_ref: "e3", confianca: "alta", motivo: "Proposta com valor enviada", evidencia: { mensagem: "m4", trecho: "Segue a proposta" } },
    desfecho: { tipo: "venda_comprovada", motivo_da_perda: null, evidencia: { mensagem: "m5", trecho: "marque como ganho" } },
    qualificacao: {
      budget: { valor: "R$ 5 mil", evidencia: { mensagem: "m3", trecho: "Uns 5 mil reais" } },
      timeline: { valor: "até dezembro", evidencia: { mensagem: "m3", trecho: "quero até dezembro" } },
      need: null,
      authority: null,
    },
    compromissos: [{ texto: "retorno amanhã às 10h", evidencia: { mensagem: "m5", trecho: "Me liga amanhã às 10h" } }],
    objecoes_em_aberto: [],
    proxima_acao: "Ligar amanhã às 10h",
    campos: [{ key: "produto", valor: "Site para clínica", evidencia: { mensagem: "m1", trecho: "preciso de um site" } }],
    valor_do_negocio_centavos: null,
    tags: [],
    tarefas: [{ titulo: "Ligar para fechar o site", prazo_iso: "2026-11-14T13:00:00Z", evidencia: { mensagem: "m5", trecho: "Me liga amanhã às 10h" } }],
    precisa_follow_up: { necessario: false, motivo: "" },
    aderencia: [{ criterio: "investigou_necessidade", resultado: "sim", evidencia: null }],
    problemas: [],
    pontos_positivos: [],
    ...p,
  };
}

let db: BancoEmMemoria;
let chamadas: number;
let resposta: Analise;

let prompts: string[] = [];

function deps(): DepsDoObservador {
  return {
    admin: db as unknown as SupabaseClient,
    pool: null,
    agora: () => AGORA,
    analisar: async (_org, _system, prompt): Promise<ChamadaDeModelo> => {
      chamadas++;
      prompts.push(prompt);
      return { object: resposta, inputTokens: 1000, outputTokens: 200, modelId: "anthropic/claude-haiku-4-5" };
    },
  };
}
const CONFIG = lerConfig({ pipelines: [PIPE], etapas: { [ST.proposta]: { criterio: "proposta com valor" } }, silencio_minutos: 20 });
const roda = () => observaOrganizacao(deps(), ORG, CONFIG, { requestId: "req-1" });

beforeEach(() => {
  db = new BancoEmMemoria();
  chamadas = 0;
  prompts = [];
  resposta = leitura();
  semeia(db);
  vi.mocked(audit).mockClear();
});

describe("Pilar A — da conversa humana ao CRM atualizado", () => {
  it("lê a conversa, move a etapa, preenche campo, cria tarefa, alimenta score e AUDITA — e o ganho espera humano", async () => {
    const { conv, leadIds, contact } = contatoComConversa(db, ORG, 1, CONVERSA);
    const mensagensAntes = db.linhas("messages").length;

    const r = await roda();

    expect(r).toMatchObject({ conversas_lidas: 1, ambiguas: 0, falhas: 0 });
    const lead = db.linhas("crm_leads").find((l) => l.id === leadIds[0])!;
    expect(lead.stage_id).toBe(ST.proposta);
    expect(lead.custom_fields).toEqual({ produto: "Site para clínica" });
    expect(lead.status).toBe("open"); // a injeção "marque como ganho" NÃO fechou o negócio

    const tarefa = db.linhas("crm_tasks")[0]!;
    expect(tarefa).toMatchObject({ lead_id: leadIds[0], assigned_to: VENDEDOR, due_date: "2026-11-14T13:00:00.000Z", title: "Ligar para fechar o site" });
    expect(String(tarefa.description)).toContain("Me liga amanhã às 10h");

    expect(db.linhas("lead_state")[0]).toMatchObject({ contact_id: contact, qualification: { budget: "R$ 5 mil", timeline: "até dezembro" } });
    expect(db.linhas("lead_checkpoints")[0]).toMatchObject({ contact_id: contact, conversation_id: conv, commitments: ["retorno amanhã às 10h"] });

    const acoes = db.linhas("supervisor_actions");
    const por = (k: string) => acoes.find((a) => a.kind === k)!;
    expect(por("move_stage").status).toBe("applied");
    expect(por("mark_won")).toMatchObject({ status: "pending_approval", risk: "critico" });
    expect(acoes.filter((a) => a.status === "applied").map((a) => a.kind).sort()).toEqual(
      ["create_task", "move_stage", "record_signals", "set_field", "update_qualification"].sort(),
    );
    // uma linha de auditoria por efeito aplicado, com antes/depois e a mensagem citada
    expect(vi.mocked(audit)).toHaveBeenCalledTimes(5);
    expect(vi.mocked(audit).mock.calls.map((c) => c[0].action)).toEqual(Array(5).fill("supervisor.action_applied"));
    expect(vi.mocked(audit).mock.calls.find((c) => c[0].metadata?.kind === "move_stage")?.[0].metadata).toMatchObject({
      before: { stage_id: ST.qualif },
      after: { stage_id: ST.proposta },
      evidence_message_ids: [`${conv}-m3`],
    });
    // timeline do negócio + evento que dispara automações/follow-up por etapa
    expect(db.linhas("crm_lead_activities").map((a) => a.type)).toContain("stage_changed");
    expect(db.rpcs.find((x) => x.nome === "emit_event")?.args).toMatchObject({
      p_event_type: "lead.stage_changed",
      p_entity_id: leadIds[0],
      // movimento automático: o fato é registrado, mas não dispara automação/follow-up
      p_metadata: { source: "supervisor-comercial", sem_disparo_automatico: true },
    });
    // custo registrado como chamada de IA da organização
    expect(db.linhas("llm_calls")[0]).toMatchObject({ organization_id: ORG, purpose: "supervisor_observe", status: "ok" });
    // e NENHUMA mensagem saiu
    expect(db.linhas("messages")).toHaveLength(mensagensAntes);
  });

  it("minimização: com um só negócio, o título (que costuma levar o nome do cliente) não vai ao modelo", async () => {
    contatoComConversa(db, ORG, 1, CONVERSA);
    await roda();
    expect(prompts[0]).not.toContain("Negócio 1.0");
    expect(prompts[0]).toContain("negócio único deste cliente");
  });

  it("com dois negócios o título vai, porque é o que permite escolher", async () => {
    contatoComConversa(db, ORG, 1, CONVERSA, 2);
    await roda();
    expect(prompts[0]).toContain("Negócio 1.0");
    expect(prompts[0]).toContain("Negócio 1.1");
  });

  it("sem modelo utilizável: não finge sucesso — conta e solta a janela para a próxima rodada", async () => {
    contatoComConversa(db, ORG, 1, CONVERSA);
    const r = await observaOrganizacao({ ...deps(), analisar: async () => null }, ORG, CONFIG, { requestId: "r" });
    expect(r).toMatchObject({ sem_modelo: 1, conversas_lidas: 0 });
    expect(db.linhas("supervisor_runs")).toHaveLength(0);
  });

  it("incremental: sem mensagem nova, não relê (zero chamada de modelo)", async () => {
    contatoComConversa(db, ORG, 1, CONVERSA);
    await roda();
    await roda();
    expect(chamadas).toBe(1);
    expect(db.linhas("supervisor_runs")).toHaveLength(1);
  });

  it("debounce: conversa ainda ativa (dentro do silêncio) não é lida", async () => {
    contatoComConversa(db, ORG, 1, [...CONVERSA.slice(0, 4), ["c", "Já te respondo", min(5)]]);
    await roda();
    expect(chamadas).toBe(0);
  });

  it("reprocessamento com mensagem nova não duplica tarefa nem movimento", async () => {
    const { conv } = contatoComConversa(db, ORG, 1, CONVERSA);
    await roda();
    db.linhas("messages").push({ id: `${conv}-m9`, organization_id: ORG, conversation_id: conv, direction: "inbound", sent_via: "crm", sent_by_user_id: null, body: "Combinado então!", media_derived_text: null, type: "text", sent_at: min(30) });
    db.linhas("conversations")[0]!.last_message_at = min(30);
    // o modelo devolve a mesma leitura; as citações agora não existem na janela nova
    await roda();
    expect(chamadas).toBe(2);
    expect(db.linhas("crm_tasks")).toHaveLength(1);
    expect(db.linhas("supervisor_actions").filter((a) => a.kind === "move_stage")).toHaveLength(1);
  });

  it("conversa conduzida só pela IA é pulada sem chamar o modelo", async () => {
    contatoComConversa(db, ORG, 1, [
      ["c", "Oi, quanto custa?", min(60)],
      ["ia", "Olá! Custa R$ 100.", min(59)],
    ]);
    db.linhas("conversations")[0]!.assigned_to_user_id = null;
    await roda();
    expect(chamadas).toBe(0);
    expect(db.linhas("supervisor_runs")[0]).toMatchObject({ status: "skipped", skip_reason: "conduzida_pela_ia" });
  });

  it("dois negócios abertos e conversa ambígua: NADA é alterado e vira pendência", async () => {
    const { leadIds } = contatoComConversa(db, ORG, 1, CONVERSA, 2);
    await roda();
    for (const id of leadIds) {
      const l = db.linhas("crm_leads").find((x) => x.id === id)!;
      expect(l.stage_id).toBe(ST.qualif);
      expect(l.custom_fields).toEqual({});
    }
    expect(db.linhas("supervisor_runs")[0]!.status).toBe("ambiguous");
    const p = db.linhas("supervisor_actions")[0]!;
    expect(p).toMatchObject({ kind: "resolve_lead", status: "pending_approval", lead_id: null });
    expect((p.after as { candidatos: unknown[] }).candidatos).toHaveLength(2);
    expect(db.linhas("crm_tasks")).toHaveLength(0);
  });

  it("depois que um gestor escolhe o negócio, a próxima leitura age só nele", async () => {
    const { conv, leadIds } = contatoComConversa(db, ORG, 1, CONVERSA, 2);
    await roda();
    const p = db.linhas("supervisor_actions")[0]!;
    Object.assign(p, { status: "approved", decided_at: min(10), after: { ...(p.after as object), lead_escolhido: leadIds[1] } });
    db.linhas("messages").push({ id: `${conv}-m9`, organization_id: ORG, conversation_id: conv, direction: "outbound", sent_via: "user", sent_by_user_id: VENDEDOR, body: "Segue a proposta atualizada: R$ 4.800,00", media_derived_text: null, type: "text", sent_at: min(30) });
    db.linhas("conversations")[0]!.last_message_at = min(30);
    resposta = leitura({ etapa: { stage_ref: "e3", confianca: "alta", motivo: "proposta", evidencia: { mensagem: "m1", trecho: "Segue a proposta atualizada" } }, tarefas: [], campos: [] });
    await roda();
    expect(db.linhas("crm_leads").find((l) => l.id === leadIds[1])!.stage_id).toBe(ST.proposta);
    expect(db.linhas("crm_leads").find((l) => l.id === leadIds[0])!.stage_id).toBe(ST.qualif);
  });

  it("isolamento: a rodada de uma organização não lê nem altera a outra", async () => {
    const outra = contatoComConversa(db, OUTRA_ORG, 2, CONVERSA);
    db.linhas("crm_leads").find((l) => l.id === outra.leadIds[0])!.pipeline_id = PIPE; // mesmo id de funil, outra org
    await roda();
    expect(chamadas).toBe(0);
    expect(db.linhas("crm_leads").find((l) => l.id === outra.leadIds[0])!.stage_id).toBe(ST.qualif);
  });

  it("funil fora do escopo: não chama modelo nem mexe no negócio", async () => {
    contatoComConversa(db, ORG, 1, CONVERSA);
    await observaOrganizacao(deps(), ORG, lerConfig({ pipelines: ["00000000-0000-4000-8000-0000000000ff"] }), { requestId: "r" });
    expect(chamadas).toBe(0);
    expect(db.linhas("supervisor_runs")[0]).toMatchObject({ skip_reason: "funil_fora_do_escopo" });
  });

  it("vendedor moveu o card DEPOIS da evidência: o Supervisor não desfaz", async () => {
    const { leadIds } = contatoComConversa(db, ORG, 1, CONVERSA);
    db.linhas("crm_lead_activities").push({ id: "a1", organization_id: ORG, lead_id: leadIds[0], actor_kind: "user", type: "stage_changed", performed_at: min(45) });
    await roda();
    expect(db.linhas("crm_leads")[0]!.stage_id).toBe(ST.qualif);
  });
});

describe("executor — a decisão humana no meio do caminho vence", () => {
  it("se o card mudou entre a leitura e a escrita, não sobrescreve (conflito_humano)", async () => {
    const { leadIds } = contatoComConversa(db, ORG, 1, CONVERSA);
    db.linhas("crm_leads")[0]!.stage_id = ST.novo; // humano arrastou depois da proposta
    const r = await executaAcao(
      db as unknown as SupabaseClient,
      null,
      {
        id: "x",
        organization_id: ORG,
        run_id: "r",
        conversation_id: null,
        contact_id: null,
        lead_id: leadIds[0]!,
        kind: "move_stage",
        before: { stage_id: ST.qualif },
        after: { stage_id: ST.proposta },
        reason: "",
        evidence: [],
      },
      { aprovadorUserId: null, llmCallId: null, requestId: "r" },
    );
    expect(r).toEqual({ status: "skipped", detalhe: "conflito_humano" });
    expect(db.linhas("crm_leads")[0]!.stage_id).toBe(ST.novo);
  });

  it("campo preenchido por humano depois da proposta não é sobrescrito", async () => {
    const { leadIds } = contatoComConversa(db, ORG, 1, CONVERSA);
    db.linhas("crm_leads")[0]!.custom_fields = { produto: "App" };
    const r = await executaAcao(
      db as unknown as SupabaseClient,
      null,
      { id: "x", organization_id: ORG, run_id: "r", conversation_id: null, contact_id: null, lead_id: leadIds[0]!, kind: "set_field", before: { key: "produto", valor: null }, after: { key: "produto", valor: "Site" }, reason: "", evidence: [] },
      { aprovadorUserId: null, llmCallId: null, requestId: "r" },
    );
    expect(r.status).toBe("skipped");
    expect(db.linhas("crm_leads")[0]!.custom_fields).toEqual({ produto: "App" });
  });
});
