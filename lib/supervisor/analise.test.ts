import { describe, expect, it } from "vitest";

import { analiseSchema, normalizaTexto, verificaEvidencia, type MensagemDaJanela } from "./analise";

const janela: MensagemDaJanela[] = [
  { ref: "m1", id: "a", quem: "cliente", texto: "Quero  fechar o “plano anual”\n amanhã", enviadaEm: "2026-11-13T12:00:00Z" },
  { ref: "m2", id: "b", quem: "vendedor", texto: "Perfeito, envio o contrato", enviadaEm: "2026-11-13T12:01:00Z" },
];

describe("verificaEvidencia", () => {
  it("aceita trecho literal, tolerando caixa, espaços e aspas tipográficas", () => {
    expect(verificaEvidencia(janela, { mensagem: "m1", trecho: 'quero fechar o "plano anual" amanhã' })).toMatchObject({
      ok: true,
      messageId: "a",
      quem: "cliente",
    });
  });
  it("recusa paráfrase", () => {
    expect(verificaEvidencia(janela, { mensagem: "m1", trecho: "deseja contratar o plano anual" })).toEqual({
      ok: false,
      motivo: "trecho_nao_encontrado",
    });
  });
  it("recusa citação atribuída à mensagem errada", () => {
    expect(verificaEvidencia(janela, { mensagem: "m2", trecho: "plano anual" }).ok).toBe(false);
  });
  it("recusa mensagem fora da janela e trecho curto demais", () => {
    expect(verificaEvidencia(janela, { mensagem: "m9", trecho: "plano anual" })).toEqual({ ok: false, motivo: "mensagem_fora_da_janela" });
    expect(verificaEvidencia(janela, { mensagem: "m2", trecho: "ok" })).toEqual({ ok: false, motivo: "trecho_curto" });
    expect(verificaEvidencia(janela, null).ok).toBe(false);
  });
  it("não remove acento: palavras diferentes continuam diferentes", () => {
    expect(normalizaTexto("Pagó")).not.toBe(normalizaTexto("Pago"));
  });
});

describe("analiseSchema", () => {
  it("recusa vocabulário fora da lista (desfecho/problema inventado)", () => {
    const base = {
      resumo: "",
      informacao_suficiente: true,
      negocio: { lead_ref: null, confianca: "alta", motivo: "" },
      etapa: null,
      desfecho: { tipo: "venda_quase_certa", motivo_da_perda: null, evidencia: null },
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
    };
    expect(analiseSchema.safeParse(base).success).toBe(false);
    expect(analiseSchema.safeParse({ ...base, desfecho: { ...base.desfecho, tipo: "nenhum" } }).success).toBe(true);
  });
});
