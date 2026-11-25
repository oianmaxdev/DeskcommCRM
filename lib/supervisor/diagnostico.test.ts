/**
 * O diagnóstico de ponta a ponta com o modelo substituído: o que está sob teste
 * é o que o CÓDIGO faz com a opinião do modelo — quais casos aceita, que
 * evidência mostra, como conta a recorrência e o que acontece quando ele falha.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/ai/budget/check", () => ({ getBudgetStatus: vi.fn(async () => ({ enforcement_mode: "off", monthly_limit_cents: 0, current_month_consumed_cents: 0 })) }));
vi.mock("@/lib/ai/cost", () => ({ computeCost: vi.fn(async () => 1) }));
vi.mock("@/lib/ai/gateway-binding", () => ({ resolverModeloDoPonto: vi.fn(async () => null) }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({}) }));
vi.mock("@/lib/leads/score-writer", () => ({ recalculaScoreDoLead: vi.fn() }));
vi.mock("@/lib/followup/enroll", () => ({ enrollFollowupFlow: vi.fn() }));

import { lerConfig } from "./config";
import { geraDiagnostico, type CasosRedigidos, type DepsDoDiagnostico, type Diagnostico } from "./diagnostico";
import { BancoEmMemoria } from "./testing/banco-em-memoria";

const ORG = "00000000-0000-4000-8000-00000000000a";
const AGORA = new Date("2026-11-20T15:00:00Z");
const PERIODO = { de: new Date("2026-11-10T00:00:00Z"), ate: AGORA };
const PRECO = { codigo: "sem_proximo_passo", estagio: "interesse_inicial", situacao: "informou o preço e não conduziu", descricao: "cliente perguntou o valor às 15h15 e recebeu só o parcelamento", evidencia: { trecho: "4x de R$67" }, evidencia_verificada: true };
const VISITA = { codigo: "sem_follow_up", estagio: "compromisso_marcado", situacao: "visita combinada não confirmada", descricao: "cliente disse que iria à loja no dia seguinte", evidencia: { trecho: "vou aí amanhã" }, evidencia_verificada: true };

let db: BancoEmMemoria;
let chamadas: string[];
let promptGeral = "";
let promptCasos = "";

function atendimento(n: number, problemas: unknown[], opts: { horasAtras?: number; positivos?: string[] } = {}) {
  const conv = `conv-${n}`;
  const ultima = new Date(AGORA.getTime() - (opts.horasAtras ?? 72) * 3600 * 1000).toISOString();
  db.linhas("conversations").push({ id: conv, organization_id: ORG, last_message_at: ultima });
  db.linhas("crm_leads").push({ id: `lead-${n}`, organization_id: ORG, title: `Negócio ${n}`, status: "open" });
  db.linhas("supervisor_runs").push({
    organization_id: ORG, conversation_id: conv, lead_id: `lead-${n}`, contact_id: `contato-${n}`, owner_user_id: "u1", pipeline_id: "p1",
    status: "analyzed", last_message_at: ultima, summary: `Resumo do atendimento ${n}`,
    analysis: { problemas, pontos_positivos: (opts.positivos ?? []).map((texto) => ({ texto, evidencia_verificada: true })), aderencia: [{ criterio: "pediu_fechamento", resultado: "nao" }] },
  });
  const msgs: Array<[string, string]> = [["inbound", `Oi, quanto custa o tênis ${n}?`], ["outbound", `Fica em 4x de R$67 (${n})`]];
  msgs.forEach(([direction, body], i) =>
    db.linhas("messages").push({ organization_id: ORG, conversation_id: conv, direction, sent_via: direction === "inbound" ? "crm" : "user", body, media_derived_text: null, type: "text", sent_at: new Date(new Date(ultima).getTime() - (10 - i) * 60000).toISOString() }),
  );
}

const geral = (p: Partial<Diagnostico>): Diagnostico => ({
  resumo_executivo: "Resumo consultivo.", gargalos: [], pontos_positivos: [], riscos: [], recomendacoes_priorizadas: [], limitacoes: [], grupos: [], selecao: [], ...p,
});

function deps(g: Diagnostico | "falha" | null, c: CasosRedigidos | "falha" | null): DepsDoDiagnostico {
  return {
    admin: db as unknown as SupabaseClient,
    agora: () => AGORA,
    interpretar: async (_o, _s, prompt) => {
      chamadas.push("geral");
      promptGeral = prompt;
      if (g === "falha") throw new Error("provedor fora");
      return g ? { object: g, inputTokens: 10, outputTokens: 10, modelId: "google/gemini-x" } : null;
    },
    redigir: async (_o, _s, prompt) => {
      chamadas.push("casos");
      promptCasos = prompt;
      if (c === "falha") throw new Error("tempo esgotado");
      return c ? { object: c, inputTokens: 10, outputTokens: 10, modelId: "google/gemini-x" } : null;
    },
  };
}
const roda = (d: DepsDoDiagnostico, cfg: Record<string, unknown> = {}) =>
  geraDiagnostico(d, ORG, lerConfig(cfg), PERIODO, {}, { requestedBy: null, recurring: false });
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- jsonb gravado: o teste navega a forma livremente
type Livre = any;
const relatorio = () => db.linhas("supervisor_reports")[0]! as { status: string; diagnosis: Livre; metrics: Livre; conversations_analyzed: number };

beforeEach(() => {
  db = new BancoEmMemoria();
  chamadas = [];
  db.linhas("organizations").push({ id: ORG, display_name: "Visual Multimarcas", timezone: "America/Sao_Paulo", onboarding_state: { welcome: { o_que_faz: "Loja de moda feminina e calçados" } } });
});

describe("diagnóstico em dois níveis", () => {
  it("30 atendimentos: no máximo 5 casos, e os 30 seguem nos números", async () => {
    for (let i = 1; i <= 30; i++) atendimento(i, [PRECO]);
    const todos = Array.from({ length: 30 }, (_, i) => `c${i + 1}`);
    await roda(
      deps(
        geral({
          // o modelo junta tudo num grupo e pede oito casos, todos da mesma situação
          grupos: [{ categoria: "sem_proximo_passo", estagio: "interesse_inicial", titulo: "Preço informado sem condução", membros: todos }],
          selecao: todos.slice(0, 5).map((conversa) => ({ conversa, tipo: "problema" as const, motivo: "representa" })),
        }),
        { casos: [{ conversa: "c1", contexto: "Cliente perguntou o preço.", evidencias: ["c1-m1", "c1-m2", "c9-m1", "inventada"], positivos: [], faltou: [{ titulo: "Não conduziu", explicacao: "Só informou o parcelamento." }], como_melhorar: [{ quando: "Ao informar o preço", exemplo_de_mensagem: "Qual numeração você calça? Já verifico!" }], follow_up_sugerido: "Oi! Conseguiu ver o tênis?", resumo: "Faltou conduzir.", limitacao: null }] },
      ),
    );
    const r = relatorio();
    expect(chamadas).toEqual(["geral", "casos"]); // duas chamadas, com 30 atendimentos
    expect(r.conversations_analyzed).toBe(30);
    expect(r.metrics.categorias).toEqual([{ codigo: "sem_proximo_passo", atendimentos: 30 }]);
    // cinco pedidos da MESMA situação viram um caso só
    expect(r.diagnosis.casos).toHaveLength(1);
    const caso = r.diagnosis.casos[0];
    expect(caso.titulo).toBe("Negócio 1");
    // a recorrência é conta do código: 30 no grupo − o próprio
    expect(caso.recorrencia).toMatchObject({ outros: 29, frase: "Essa situação se repetiu em mais 29 atendimentos analisados no período." });
    expect(caso.recorrencia.conversation_ids).toHaveLength(29);
    // evidência = mensagens REAIS daquela conversa; ref de outra conversa e ref inventada caem
    expect(caso.evidencias.map((e: { texto: string }) => e.texto)).toEqual(["Oi, quanto custa o tênis 1?", "Fica em 4x de R$67 (1)"]);
    // o exemplo hipotético fica no campo dele e não vira mensagem
    expect(caso.como_melhorar[0].exemplo_de_mensagem).toContain("Qual numeração");
    expect(db.linhas("messages").some((m) => String(m.body).includes("Qual numeração"))).toBe(false);
    expect(caso.evidencias.some((e: { texto: string }) => e.texto.includes("Qual numeração"))).toBe(false);
  });

  it("preço × visita combinada: o modelo junta, o código separa; cada caso sem recorrência", async () => {
    atendimento(1, [{ ...PRECO, codigo: "sem_follow_up" }]);
    atendimento(2, [VISITA]);
    await roda(
      deps(
        geral({
          grupos: [{ categoria: "sem_follow_up", estagio: "interesse_inicial", titulo: "Falta de follow-up", membros: ["c1", "c2"] }],
          selecao: [{ conversa: "c1", tipo: "problema", motivo: "a" }, { conversa: "c2", tipo: "problema", motivo: "b" }],
        }),
        { casos: [] },
      ),
    );
    const d = relatorio().diagnosis;
    expect(d.grupos.map((g: { conversation_ids: string[] }) => g.conversation_ids)).toEqual([["conv-1"], ["conv-2"]]);
    expect(d.casos).toHaveLength(2);
    expect(d.casos.every((c: { recorrencia: unknown }) => c.recorrencia === null)).toBe(true);
    expect(relatorio().metrics.categorias).toEqual([{ codigo: "sem_follow_up", atendimentos: 2 }]);
  });

  it("follow-up ainda não devido (2 h) ou já programado em tarefa: não é falha", async () => {
    atendimento(1, [VISITA], { horasAtras: 2 });
    atendimento(2, [VISITA], { horasAtras: 72 });
    db.linhas("crm_tasks").push({ organization_id: ORG, lead_id: "lead-2", status: "pending", due_date: "2026-11-21T13:00:00Z" });
    atendimento(3, [VISITA], { horasAtras: 72 });
    await roda(deps(geral({}), { casos: [] }));
    const r = relatorio();
    expect(r.metrics.categorias).toEqual([{ codigo: "sem_follow_up", atendimentos: 1 }]);
    expect(r.metrics.desconsideradas).toEqual({ follow_up_ainda_nao_devido: 2 });
    expect(r.diagnosis.limitacoes.join(" ")).toContain("2 apontamento(s) de falta de follow-up não foram contados");
  });

  it("o nicho do onboarding e a precedência do script chegam ao modelo", async () => {
    atendimento(1, [PRECO]);
    await roda(deps(geral({ selecao: [{ conversa: "c1", tipo: "problema", motivo: "x" }] }), { casos: [] }));
    expect(promptGeral).toContain("Loja de moda feminina e calçados");
    expect(promptGeral).toContain("não cadastrou script");
    expect(promptCasos).toContain("Loja de moda feminina e calçados");
    expect(relatorio().diagnosis.contexto).toMatchObject({ nicho: "Loja de moda feminina e calçados", base: "ramo", organizacao: "Visual Multimarcas" });

    db.tabelas.supervisor_reports = [];
    await roda(deps(geral({}), null), { script: { texto: "Sempre oferecer prova na loja.", criterios: [{ id: "ofereceu_prova", descricao: "Ofereceu prova na loja" }] } });
    expect(promptGeral).toContain("SCRIPT FORMAL");
    expect(promptGeral).toContain("Sempre oferecer prova na loja.");
    expect(relatorio().diagnosis.contexto.base).toBe("script");
  });

  it("sem nicho e sem script: critérios gerais, e a limitação é declarada", async () => {
    db.linhas("organizations")[0]!.onboarding_state = {};
    atendimento(1, [PRECO]);
    await roda(deps(geral({}), null));
    expect(promptGeral).toContain("NÃO informou o ramo");
    expect(relatorio().diagnosis.contexto).toMatchObject({ nicho: null, base: "geral" });
    expect(relatorio().diagnosis.limitacoes.join(" ")).toContain("não informou o ramo de atuação");
  });

  it("nome e identificador do cliente não vão ao modelo; o título do negócio também não", async () => {
    atendimento(1, [PRECO]);
    await roda(deps(geral({ selecao: [{ conversa: "c1", tipo: "problema", motivo: "x" }] }), { casos: [] }));
    for (const p of [promptGeral, promptCasos]) {
      expect(p).not.toContain("Negócio 1");
      expect(p).not.toContain("contato-1");
      expect(p).not.toContain("conv-1");
    }
  });
});

describe("quando o modelo falha, o relatório ainda sai — e diz o que faltou", () => {
  it("chamada geral falha: seleção de reserva, casos com a leitura automática", async () => {
    atendimento(1, [PRECO]);
    atendimento(2, [PRECO]);
    atendimento(3, [VISITA], { positivos: [] });
    await roda(deps("falha", null));
    const r = relatorio();
    expect(r.status).toBe("done");
    expect(chamadas).toEqual(["geral"]);
    expect(r.diagnosis.resumo_executivo).toBeNull();
    expect(r.diagnosis.casos.length).toBeGreaterThan(0);
    expect(r.diagnosis.casos.length).toBeLessThanOrEqual(5);
    expect(r.diagnosis.casos[0].recorrencia.outros).toBe(1);
    expect(r.diagnosis.casos[0].limitacao).toContain("redação detalhada");
    expect(r.diagnosis.limitacoes.join(" ")).toContain("A interpretação falhou");
  });

  it("redação dos casos falha: o geral fica, os casos saem com conteúdo determinístico", async () => {
    atendimento(1, [PRECO]);
    await roda(deps(geral({ selecao: [{ conversa: "c1", tipo: "problema", motivo: "x" }] }), "falha"));
    const d = relatorio().diagnosis;
    expect(d.resumo_executivo).toBe("Resumo consultivo.");
    expect(d.casos[0].faltou).toEqual([{ titulo: "informou o preço e não conduziu", explicacao: PRECO.descricao }]);
    expect(d.casos[0].como_melhorar).toEqual([]);
  });

  it("nenhum atendimento relevante escolhido: zero casos e nenhuma segunda chamada", async () => {
    atendimento(1, []);
    await roda(deps(geral({ selecao: [{ conversa: "c1", tipo: "problema", motivo: "forçando" }] }), { casos: [] }));
    expect(relatorio().diagnosis.casos).toEqual([]);
    expect(chamadas).toEqual(["geral"]);
  });

  it("período sem leitura: insuficiente, sem chamada nenhuma", async () => {
    await roda(deps(geral({}), null));
    expect(relatorio().status).toBe("insufficient");
    expect(chamadas).toEqual([]);
  });
});

describe("análise completa × incompleta", () => {
  it("duas chamadas bem-sucedidas: completo = true", async () => {
    atendimento(1, [PRECO]);
    await roda(deps(geral({ selecao: [{ conversa: "c1", tipo: "problema", motivo: "x" }] }), { casos: [{ conversa: "c1", contexto: "c", evidencias: ["c1-m1"], positivos: [], faltou: [], como_melhorar: [{ quando: "q", exemplo_de_mensagem: "e" }], follow_up_sugerido: null, resumo: "r", limitacao: null }] }));
    expect(relatorio().diagnosis.completo).toBe(true);
  });
  it("geral falhou ou redação falhou: completo = false (a tela e o PDF avisam)", async () => {
    atendimento(1, [PRECO]);
    await roda(deps("falha", null));
    expect(relatorio().diagnosis.completo).toBe(false);
    db.tabelas.supervisor_reports = [];
    await roda(deps(geral({ selecao: [{ conversa: "c1", tipo: "problema", motivo: "x" }] }), "falha"));
    expect(relatorio().diagnosis.completo).toBe(false);
  });
  it("os prompts de diagnóstico levam as regras de julgamento e a base da aderência", async () => {
    atendimento(1, [PRECO]);
    let sistema = "";
    const d = deps(geral({}), null);
    await roda({ ...d, interpretar: async (o, s, p) => { sistema = s; return d.interpretar(o, s, p); } });
    expect(sistema).toContain("Responder o preço quando o cliente pergunta NÃO é falha");
    expect(sistema).toContain("cada critério tem o SEU denominador");
  });
});
