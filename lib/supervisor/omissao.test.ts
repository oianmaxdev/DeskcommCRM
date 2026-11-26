import { describe, expect, it } from "vitest";

import type { MensagemDaJanela } from "./analise";
import { fraseDaProva, proximoHorarioComercial, provaPorOmissao } from "./omissao";

const SP = "America/Sao_Paulo";
// Sexta, 14/11/2026, 10:00 em São Paulo = 13:00Z
const msg = (ref: string, quem: MensagemDaJanela["quem"], texto: string, iso: string): MensagemDaJanela => ({
  ref,
  id: `id-${ref}`,
  quem,
  texto,
  enviadaEm: iso,
});

const VISITA: MensagemDaJanela[] = [
  msg("m1", "cliente", "Tem a calça pantalona no 38?", "2026-11-13T17:00:00Z"),
  msg("m2", "vendedor", "Tenho sim! Quer que eu separe?", "2026-11-13T17:05:00Z"),
  msg("m3", "cliente", "Amanhã passo aí para provar", "2026-11-13T17:10:00Z"),
  msg("m4", "vendedor", "Combinado, te espero!", "2026-11-13T17:12:00Z"),
];
const COMPROMISSO = { mensagem: "m3", trecho: "Amanhã passo aí" };

describe("prova por omissão", () => {
  it("compromisso vencido e sem acompanhamento depois da combinação → comprovado", () => {
    const r = provaPorOmissao({
      codigo: "compromisso_nao_cumprido",
      janela: VISITA,
      citacao: COMPROMISSO,
      prazoIso: "2026-11-14T13:00:00Z", // sábado 10h
      agora: new Date("2026-11-17T15:00:00Z"),
      fuso: SP,
      acaoProgramada: false,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.prova.origem).toMatchObject({ mensagem: "m3", trecho: "Amanhã passo aí", quem: "cliente" });
    expect(r.prova.devido_em).toBe("2026-11-14T13:00:00.000Z");
  });

  it("a resposta imediata do vendedor (\"combinado\") é parte da combinação, não o acompanhamento", () => {
    const r = provaPorOmissao({ codigo: "compromisso_nao_cumprido", janela: VISITA, citacao: COMPROMISSO, agora: new Date("2026-11-17T15:00:00Z"), fuso: SP, acaoProgramada: false });
    expect(r.ok).toBe(true);
  });

  it("compromisso ainda não vencido → não é falha", () => {
    const r = provaPorOmissao({
      codigo: "compromisso_nao_cumprido",
      janela: VISITA,
      citacao: COMPROMISSO,
      prazoIso: "2026-11-14T13:00:00Z",
      agora: new Date("2026-11-14T12:00:00Z"),
      fuso: SP,
      acaoProgramada: false,
    });
    expect(r).toEqual({ ok: false, motivo: "ainda_nao_vencido" });
  });

  it("vendedor voltou a falar horas depois → houve acompanhamento", () => {
    const janela = [...VISITA, msg("m5", "vendedor", "Bom dia! Vai passar hoje?", "2026-11-14T12:30:00Z")];
    const r = provaPorOmissao({ codigo: "compromisso_nao_cumprido", janela, citacao: COMPROMISSO, agora: new Date("2026-11-17T15:00:00Z"), fuso: SP, acaoProgramada: false });
    expect(r).toEqual({ ok: false, motivo: "houve_acompanhamento" });
  });

  it("mensagem de automação também conta como acompanhamento", () => {
    const janela = [...VISITA, msg("m5", "automacao", "Lembrete da sua visita", "2026-11-14T11:00:00Z")];
    const r = provaPorOmissao({ codigo: "compromisso_nao_cumprido", janela, citacao: COMPROMISSO, agora: new Date("2026-11-17T15:00:00Z"), fuso: SP, acaoProgramada: false });
    expect(r).toEqual({ ok: false, motivo: "houve_acompanhamento" });
  });

  it("tarefa futura ou follow-up ativo → ação programada, não falha", () => {
    const r = provaPorOmissao({ codigo: "compromisso_nao_cumprido", janela: VISITA, citacao: COMPROMISSO, agora: new Date("2026-11-17T15:00:00Z"), fuso: SP, acaoProgramada: true });
    expect(r).toEqual({ ok: false, motivo: "acao_programada" });
  });

  it("compromisso sem citação → recusado (não se inventa a origem)", () => {
    const r = provaPorOmissao({ codigo: "compromisso_nao_cumprido", janela: VISITA, citacao: null, agora: new Date("2026-11-17T15:00:00Z"), fuso: SP, acaoProgramada: false });
    expect(r).toEqual({ ok: false, motivo: "origem_nao_citada" });
  });

  it("citação que não está na mensagem → recusado", () => {
    const r = provaPorOmissao({ codigo: "compromisso_nao_cumprido", janela: VISITA, citacao: { mensagem: "m3", trecho: "vou comprar duas" }, agora: new Date("2026-11-17T15:00:00Z"), fuso: SP, acaoProgramada: false });
    expect(r).toEqual({ ok: false, motivo: "origem_nao_citada" });
  });

  it("citação de mensagem fora da janela → recusado (o histórico depois dela não é verificável)", () => {
    const r = provaPorOmissao({ codigo: "compromisso_nao_cumprido", janela: VISITA, citacao: { mensagem: "m99", trecho: "qualquer" }, agora: new Date("2026-11-17T15:00:00Z"), fuso: SP, acaoProgramada: false });
    expect(r).toEqual({ ok: false, motivo: "origem_fora_da_janela" });
  });

  it("falta de follow-up sem citação: a origem é a última mensagem; vence 24 h depois em horário comercial", () => {
    // Cliente some sábado 19h; 24 h depois = domingo 19h → próximo horário comercial = segunda 9h
    const janela = [msg("m1", "vendedor", "Fica R$ 189,90", "2026-11-14T21:00:00Z"), msg("m2", "cliente", "Vou pensar", "2026-11-14T22:00:00Z")];
    const antes = provaPorOmissao({ codigo: "sem_follow_up", janela, citacao: null, agora: new Date("2026-11-16T11:30:00Z"), fuso: SP, acaoProgramada: false });
    expect(antes).toEqual({ ok: false, motivo: "ainda_nao_vencido" });
    const depois = provaPorOmissao({ codigo: "sem_follow_up", janela, citacao: null, agora: new Date("2026-11-16T12:30:00Z"), fuso: SP, acaoProgramada: false });
    expect(depois.ok).toBe(true);
    if (depois.ok) expect(depois.prova.devido_em).toBe("2026-11-16T12:00:00.000Z"); // segunda 9h em SP
  });
});

describe("horário comercial", () => {
  it("madrugada vai para as 9h do mesmo dia", () => {
    expect(proximoHorarioComercial(new Date("2026-11-17T06:20:00Z"), SP).toISOString()).toBe("2026-11-17T12:00:00.000Z");
  });
  it("domingo vai para segunda 9h", () => {
    expect(proximoHorarioComercial(new Date("2026-11-15T15:00:00Z"), SP).toISOString()).toBe("2026-11-16T12:00:00.000Z");
  });
  it("dentro do horário não muda", () => {
    const d = new Date("2026-11-17T15:30:00Z");
    expect(proximoHorarioComercial(d, SP).getTime()).toBe(d.getTime());
  });
});

describe("a frase nunca afirma que algo não aconteceu", () => {
  it("fala de registro no canal e da limitação de outros canais", () => {
    const r = provaPorOmissao({ codigo: "compromisso_nao_cumprido", janela: VISITA, citacao: COMPROMISSO, agora: new Date("2026-11-17T15:00:00Z"), fuso: SP, acaoProgramada: false });
    if (!r.ok) throw new Error("esperava prova");
    const f = fraseDaProva(r.prova, (iso) => iso.slice(0, 16));
    expect(f).toContain("não há mensagem do vendedor registrada no WhatsApp");
    expect(f).toContain("outro canal");
    expect(f).not.toMatch(/nunca|não aconteceu|não foi feit/i);
  });
});
