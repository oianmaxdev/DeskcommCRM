import { describe, expect, it } from "vitest";

import type { Analise, MensagemDaJanela } from "./analise";
import { lerConfig } from "./config";
import { marcosDaAcao } from "./executor";
import { decideAcoes, type ContextoDoNegocio } from "./politica";

// Marcos comerciais das etapas PULADAS e o contexto temporal das tarefas.
// Defeitos vistos na demo PipeMax de 28/11/2026: (1) o Supervisor levou um negócio
// de Novo Lead direto para Negociação e o QualifiedLead da etapa Qualificação nunca
// saiu; (2) compromissos já cumpridos do histórico viraram tarefas pendentes.

const S = {
  novo: "00000000-0000-4000-8000-000000000001",
  qualif: "00000000-0000-4000-8000-000000000002",
  apres: "00000000-0000-4000-8000-000000000003",
  negoc: "00000000-0000-4000-8000-000000000004",
  ganho: "00000000-0000-4000-8000-000000000005",
};
const AGORA = new Date("2026-11-28T15:00:00Z");

const janela: MensagemDaJanela[] = [
  { ref: "m1", id: "msg-1", quem: "cliente", texto: "Oi! Vi o anúncio do vestido midi", enviadaEm: "2026-11-28T12:00:00Z" },
  { ref: "m2", id: "msg-2", quem: "cliente", texto: "É para um casamento dia 13, uso tamanho 40", enviadaEm: "2026-11-28T12:02:00Z" },
  { ref: "m3", id: "msg-3", quem: "vendedor", texto: "Combinado, te espero quarta às 18h para a prova", enviadaEm: "2026-11-28T12:05:00Z" },
  { ref: "m4", id: "msg-4", quem: "cliente", texto: "Fechado, quarta às 18h estou aí", enviadaEm: "2026-11-28T12:06:00Z" },
];

function analise(p: Partial<Analise> = {}): Analise {
  return {
    resumo: "",
    informacao_suficiente: true,
    negocio: { lead_ref: null, confianca: "alta", motivo: "" },
    etapa: null,
    marcos: [],
    desfecho: { tipo: "nenhum", motivo_da_perda: null, evidencia: null },
    qualificacao: { budget: null, authority: null, need: null, timeline: null },
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
    ...p,
  } as Analise;
}

function ctx(p: Partial<ContextoDoNegocio> = {}): ContextoDoNegocio {
  const etapa = (id: string, name: string, position: number, x: Partial<{ is_won: boolean }> = {}) => ({
    id, name, position, is_won: false, is_lost: false, is_archived: false, requires_human: false, ...x,
  });
  return {
    leadId: "lead-1",
    stageId: S.novo,
    status: "open",
    valueCents: null,
    customFields: {},
    tags: [],
    etapas: [
      etapa(S.novo, "Novo Lead", 1),
      etapa(S.qualif, "Qualificação", 2),
      etapa(S.apres, "Apresentação", 3),
      etapa(S.negoc, "Negociação", 4),
      etapa(S.ganho, "Venda Ganha", 5, { is_won: true }),
    ],
    refsDeEtapa: { e1: S.novo, e2: S.qualif, e3: S.apres, e4: S.negoc, e5: S.ganho },
    campos: [],
    motivosDePerda: [],
    qualificacaoAtual: {},
    sinaisAnteriores: null,
    tarefasAbertas: [],
    contatoBloqueado: false,
    ultimaMudancaHumana: { etapa: null, campos: null },
    ultimaMensagemId: "msg-4",
    ...p,
  };
}

const config = (auto = true) =>
  lerConfig({
    pipelines: ["00000000-0000-4000-8000-0000000000aa"],
    autonomia: auto ? { mover_etapa: "automatico" } : { mover_etapa: "aprovacao" },
    etapas: { [S.negoc]: { criterio: "visita ou prova agendada", automatico: true } },
  });

const paraNegociacao = {
  stage_ref: "e4",
  confianca: "alta" as const,
  motivo: "Prova agendada",
  evidencia: { mensagem: "m4", trecho: "Fechado, quarta às 18h estou aí" },
};
const marcoQualificacao = { stage_ref: "e2", evidencia: { mensagem: "m2", trecho: "É para um casamento dia 13, uso tamanho 40" } };

const movimento = (r: ReturnType<typeof decideAcoes>) => r.acoes.find((a) => a.kind === "move_stage");

describe("marcos comerciais de etapas puladas", () => {
  it("salto Novo Lead → Negociação com qualificação comprovada leva o marco, com o horário da mensagem", () => {
    const r = decideAcoes(analise({ etapa: paraNegociacao, marcos: [marcoQualificacao] }), janela, ctx(), config(), AGORA);
    const m = movimento(r);
    expect(m?.after.stage_id).toBe(S.negoc);
    expect(m?.after.marcos).toEqual([
      { stage_id: S.qualif, stage_name: "Qualificação", message_id: "msg-2", occurred_at: "2026-11-28T12:02:00Z" },
    ]);
    expect(m?.reason).toContain("marco comprovado: Qualificação");
    expect(marcosDaAcao(m!)).toEqual([{ stage_id: S.qualif, occurred_at: "2026-11-28T12:02:00Z", message_id: "msg-2" }]);
  });

  it("sem evidência literal NÃO há marco (e o descarte fica registrado)", () => {
    const inventado = { stage_ref: "e2", evidencia: { mensagem: "m2", trecho: "orçamento de 5 mil aprovado pela diretoria" } };
    const r = decideAcoes(analise({ etapa: paraNegociacao, marcos: [inventado] }), janela, ctx(), config(), AGORA);
    expect(movimento(r)?.after.marcos).toBeUndefined();
    expect(r.descartes).toContainEqual({ o_que: "marco:Qualificação", motivo: "trecho_nao_encontrado" });
  });

  it("sem marco declarado, o salto não inventa os intermediários", () => {
    const r = decideAcoes(analise({ etapa: paraNegociacao }), janela, ctx(), config(), AGORA);
    expect(movimento(r)?.after.marcos).toBeUndefined();
  });

  it("só etapas ESTRITAMENTE entre a atual e o destino: nem a atual, nem o destino, nem fechamento", () => {
    const ev = marcoQualificacao.evidencia;
    const r = decideAcoes(
      analise({ etapa: paraNegociacao, marcos: [{ stage_ref: "e1", evidencia: ev }, { stage_ref: "e4", evidencia: ev }, { stage_ref: "e5", evidencia: ev }, { stage_ref: "e9", evidencia: ev }] }),
      janela, ctx(), config(), AGORA,
    );
    expect(movimento(r)?.after.marcos).toBeUndefined();
  });

  it("movimento para trás não carrega marco", () => {
    const voltar = { ...paraNegociacao, stage_ref: "e1" };
    const r = decideAcoes(analise({ etapa: voltar, marcos: [marcoQualificacao] }), janela, ctx({ stageId: S.negoc }), config(), AGORA);
    expect(movimento(r)?.after.marcos).toBeUndefined();
  });

  it("movimento que espera o gestor leva os marcos junto: só valem se ele aprovar", () => {
    const r = decideAcoes(analise({ etapa: paraNegociacao, marcos: [marcoQualificacao] }), janela, ctx(), config(false), AGORA);
    const m = movimento(r);
    expect(m?.status).toBe("pending_approval");
    expect(m?.after.marcos).toHaveLength(1);
  });

  it("marcosDaAcao recusa jsonb adulterado (id que não é uuid, data inválida)", () => {
    expect(marcosDaAcao({ after: { marcos: [{ stage_id: "x", occurred_at: "2026-11-28T12:00:00Z" }, { stage_id: S.qualif, occurred_at: "ontem" }] } })).toEqual([]);
    expect(marcosDaAcao({ after: {} })).toEqual([]);
  });
});

describe("tarefas: histórico × futuro × vencido", () => {
  const tarefa = (p: Record<string, unknown>) => ({
    titulo: "Receber a cliente para a prova",
    prazo_iso: null,
    ainda_pendente: true,
    evidencia: { mensagem: "m4", trecho: "Fechado, quarta às 18h estou aí" },
    ...p,
  });
  const tarefas = (r: ReturnType<typeof decideAcoes>) => r.acoes.filter((a) => a.kind === "create_task");

  it("compromisso histórico já cumprido não vira tarefa pendente", () => {
    const r = decideAcoes(analise({ tarefas: [tarefa({ prazo_iso: "2026-11-20T21:00:00Z", ainda_pendente: false })] as never }), janela, ctx(), config(), AGORA);
    expect(tarefas(r)).toHaveLength(0);
    expect(r.descartes).toContainEqual({ o_que: "tarefa", motivo: "compromisso_historico" });
  });

  it("tarefa futura mantém data e hora", () => {
    const r = decideAcoes(analise({ tarefas: [tarefa({ prazo_iso: "2026-12-02T18:00:00-03:00" })] as never }), janela, ctx(), config(), AGORA);
    expect(tarefas(r)[0]?.after.due_date).toBe("2026-12-02T21:00:00.000Z");
    expect(tarefas(r)[0]?.reason).toBe("Compromisso combinado na conversa");
  });

  it("obrigação vencida e ainda pendente mantém a data real (aparece como atrasada)", () => {
    const r = decideAcoes(analise({ tarefas: [tarefa({ prazo_iso: "2026-11-26T13:00:00Z" })] as never }), janela, ctx(), config(), AGORA);
    expect(tarefas(r)[0]?.after.due_date).toBe("2026-11-26T13:00:00.000Z");
    expect(tarefas(r)[0]?.reason).toBe("Compromisso combinado na conversa e já vencido");
  });

  it("data mais velha que 30 dias é tratada como leitura errada: tarefa sem prazo", () => {
    const r = decideAcoes(analise({ tarefas: [tarefa({ prazo_iso: "2026-09-01T13:00:00Z" })] as never }), janela, ctx(), config(), AGORA);
    expect(tarefas(r)[0]?.after.due_date).toBeNull();
  });

  it("sem momento combinado, sem prazo (nenhum horário inventado)", () => {
    const r = decideAcoes(analise({ tarefas: [tarefa({})] as never }), janela, ctx(), config(), AGORA);
    expect(tarefas(r)[0]?.after.due_date).toBeNull();
  });
});
