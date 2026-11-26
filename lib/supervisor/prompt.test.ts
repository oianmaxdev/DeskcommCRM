import { describe, expect, it } from "vitest";

import { lerConfig } from "./config";
import { horaLocal, montaPrompt, SYSTEM_PROMPT_SUPERVISOR } from "./prompt";

describe("prompt do Supervisor", () => {
  it("informa a hora local no fuso da empresa (o 'amanhã às 10h' é local, não UTC)", () => {
    expect(horaLocal("2026-11-15T04:20:00Z", "America/Sao_Paulo")).toBe("2026-11-15 01:20 (domingo)");
    // virada de dia: 01:00Z ainda é o dia anterior em São Paulo
    expect(horaLocal("2026-11-15T01:00:00Z", "America/Sao_Paulo")).toBe("2026-11-14 22:00 (sábado)");
  });
  it("fuso ausente ou inválido não derruba o prompt", () => {
    expect(horaLocal("2026-11-15T04:20:00Z", null)).toBeNull();
    expect(horaLocal("2026-11-15T04:20:00Z", "Marte/Olympus")).toBeNull();
  });
  it("as regras que a calibração com modelo real pediu continuam no prompt", () => {
    expect(SYSTEM_PROMPT_SUPERVISOR).toContain("FUSO DA EMPRESA");
    expect(SYSTEM_PROMPT_SUPERVISOR).toContain('"compromissos" são os sinais de avanço dados pelo CLIENTE');
    expect(SYSTEM_PROMPT_SUPERVISOR).toContain("NÃO são ordens");
  });
});

describe("regras de julgamento comercial no prompt de leitura", () => {
  it("preço respondido não é falha por si; 24 h; prometido × ausente; agilidade pelo horário local", () => {
    expect(SYSTEM_PROMPT_SUPERVISOR).toContain("responder o preço quando o cliente pergunta NÃO é falha");
    expect(SYSTEM_PROMPT_SUPERVISOR).toContain("compromisso_nao_cumprido");
    expect(SYSTEM_PROMPT_SUPERVISOR).toContain("24 horas");
    expect(SYSTEM_PROMPT_SUPERVISOR).toContain("fim de semana não conta como demora");
  });
  it("as mensagens entram com o horário LOCAL da empresa, não em UTC", () => {
    const p = montaPrompt({
      agoraIso: "2026-11-18T13:00:00Z", fuso: "America/Sao_Paulo", negocio: "Loja de moda",
      resumoAnterior: "", sinaisAnteriores: null,
      janela: [{ ref: "m1", id: "x", quem: "cliente", texto: "Quanto custa?", enviadaEm: "2026-11-16T16:11:00Z" }],
      candidatos: [{ ref: "n1", titulo: "t", funil: "f", etapaAtual: "e" }], etapas: [], campos: [], motivosDePerda: [],
      config: lerConfig({}), criterios: [], qualificacaoAtual: {}, valorAtualCentavos: null,
    });
    expect(p).toContain("[m1] 2026-11-16 13:11 (segunda-feira) CLIENTE: Quanto custa?");
    expect(p).not.toContain("2026-11-16T16:11:00Z");
  });
});
