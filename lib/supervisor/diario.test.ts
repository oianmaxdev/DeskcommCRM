import { describe, expect, it } from "vitest";

import { dataHora, itensDaAcao, montaDiario, type AcaoDoDiario } from "./diario";

const SP = "America/Sao_Paulo";
const acao = (p: Partial<AcaoDoDiario>): AcaoDoDiario => ({
  id: "a1",
  kind: "move_stage",
  status: "applied",
  before: null,
  after: {},
  reason: "O vendedor apresentou uma proposta com valor definido.",
  created_at: "2026-11-16T17:25:00Z",
  crm_leads: { title: "Site da Clínica Sorriso" },
  ...p,
});

describe("diário do Supervisor", () => {
  it("data e hora no fuso da organização, no formato que se lê", () => {
    expect(dataHora("2026-11-16T17:30:00Z", SP, "pt-BR")).toBe("16/11/2026 às 14h30");
    expect(dataHora("2026-11-16T17:30:00Z", "Marte/Olympus", "pt-BR")).toMatch(/às \d{2}h\d{2}$/); // fuso inválido não derruba
  });

  it("títulos em linguagem natural para cada tipo de ação", () => {
    const de = (p: Partial<AcaoDoDiario>) => itensDaAcao(acao(p), SP, "pt-BR").map((i) => [i.verbo, i.objeto, i.detalhe]);
    expect(de({ before: { stage_name: "Qualificação" }, after: { stage_name: "Proposta Enviada" } })).toEqual([["Moveu o negócio", "Site da Clínica Sorriso", "Qualificação → Proposta Enviada"]]);
    expect(de({ kind: "create_task", after: { title: "Ligar para o cliente", due_date: "2026-11-17T13:00:00Z" } })).toEqual([["Criou uma tarefa", "Ligar para o cliente", "Prazo: 17/11/2026 às 10h00"]]);
    expect(de({ kind: "create_task", after: { title: "Enviar contrato", due_date: null } })[0]![2]).toBe("Sem prazo definido");
    expect(de({ kind: "set_field", after: { label: "Produto de interesse", valor: "Site" } })[0]).toEqual(["Preencheu o campo Produto de interesse", "Site da Clínica Sorriso", "Site"]);
    expect(de({ kind: "set_value", after: { value_cents: 480000 } })[0]![2]).toMatch(/R\$\s4\.800,00/);
    expect(de({ kind: "update_qualification", after: { qualification: { need: "site", budget: "5 mil" } } })[0]![2]).toBe("Necessidade: site · Orçamento: 5 mil");
    expect(de({ kind: "add_tag", after: { tag: "Proposta enviada" } })[0]!.slice(0, 2)).toEqual(["Adicionou a tag", "Proposta enviada"]);
    expect(de({ kind: "mark_lost", after: { lost_reason: "price" } })[0]![2]).toBe("Motivo: price");
  });

  it("a ação que mexeu no score rende também a linha 'Atualizou o score'", () => {
    const itens = itensDaAcao(acao({ kind: "record_signals", after: { commitments: ["x"], objections: [], score: { de: 42, para: 67, faixa: "morno" } } }), SP, "pt-BR");
    expect(itens.map((i) => [i.verbo, i.detalhe])).toEqual([
      ["Registrou os sinais da conversa", "1 compromisso do cliente"],
      ["Atualizou o score", "42% → 67% (Morno)"],
    ]);
    const primeiro = itensDaAcao(acao({ kind: "update_qualification", after: { qualification: {}, score: { de: null, para: 55, faixa: "morno" } } }), SP, "pt-BR");
    expect(primeiro[1]!.detalhe).toBe("sem score → 55% (Morno)");
  });

  it("só entra o que foi REALIZADO: pendente, recusada, pulada e falha ficam de fora", () => {
    const acoes = ["applied", "approved", "pending_approval", "rejected", "skipped", "failed"].map((status, i) => acao({ id: `a${i}`, status }));
    const itens = montaDiario(acoes, SP, "pt-BR").flatMap((d) => d.itens);
    expect(itens.map((i) => i.acao.status).sort()).toEqual(["applied", "approved"]);
    expect(itens.find((i) => i.acao.status === "approved")!.aprovadaPorGestor).toBe(true);
  });

  it("agrupa por dia LOCAL, mais recente primeiro (23h de Brasília não vira o dia seguinte)", () => {
    const acoes = [
      acao({ id: "a", created_at: "2026-11-16T12:00:00Z" }),
      acao({ id: "b", created_at: "2026-11-17T02:30:00Z" }), // 23h30 do dia 16 em São Paulo
      acao({ id: "c", created_at: "2026-11-17T15:00:00Z" }),
      acao({ id: "d", created_at: "2026-11-10T15:00:00Z" }),
    ];
    const dias = montaDiario(acoes, SP, "pt-BR", new Date("2026-11-17T18:00:00Z"));
    expect(dias.map((d) => [d.dia, d.itens.map((i) => i.id)])).toEqual([
      ["2026-11-17", ["c"]],
      ["2026-11-16", ["b", "a"]],
      ["2026-11-10", ["d"]],
    ]);
    expect(dias[0]!.rotulo).toMatch(/^Hoje — /);
    expect(dias[1]!.rotulo).toMatch(/^Ontem — /);
    expect(dias[2]!.rotulo).toMatch(/^Terça-feira, 10 de novembro/);
  });

  it("ação aprovada aparece no momento em que foi executada, não em que foi proposta", () => {
    const i = itensDaAcao(acao({ status: "approved", decided_at: "2026-11-18T12:00:00Z" }), SP, "pt-BR")[0]!;
    expect(i.quando).toBe("2026-11-18T12:00:00Z");
  });
});
