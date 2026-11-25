import { describe, expect, it } from "vitest";

import { configPadrao, criteriosEmVigor, lerConfig, supervisorConfigSchema } from "./config";

describe("config do Supervisor", () => {
  it("o padrão é SEGURO: nenhum funil, ganho/perda/follow-up/valor pedem aprovação", () => {
    const c = configPadrao();
    expect(c.pipelines).toEqual([]);
    expect(c.autonomia).toMatchObject({
      mover_etapa: "automatico",
      campos: "automatico",
      tarefas: "automatico",
      qualificacao: "automatico",
      ganho: "aprovacao",
      perda: "aprovacao",
      followup: "aprovacao",
      valor: "aprovacao",
      sobrescrever_campos: false,
    });
    expect(c.ganho_exige).toBe("venda_comprovada");
  });

  it("lerConfig nunca lança e degrada campo a campo", () => {
    expect(lerConfig(null)).toEqual(configPadrao());
    expect(lerConfig("lixo")).toEqual(configPadrao());
    const c = lerConfig({
      pipelines: ["não-é-uuid"],
      silencio_minutos: 45,
      autonomia: { ganho: "automatico", perda: "talvez" },
    });
    expect(c.pipelines).toEqual([]);
    expect(c.silencio_minutos).toBe(45);
    expect(c.autonomia.ganho).toBe("automatico");
    expect(c.autonomia.perda).toBe("aprovacao");
  });

  it("o schema estrito (API) recusa o que a leitura tolera", () => {
    expect(supervisorConfigSchema.safeParse({ autonomia: { perda: "talvez" } }).success).toBe(false);
    expect(supervisorConfigSchema.safeParse({ silencio_minutos: 0 }).success).toBe(false);
  });

  it("sem script cadastrado, os critérios são de boa prática — e marcados como não formais", () => {
    expect(criteriosEmVigor(configPadrao()).formal).toBe(false);
    const c = lerConfig({ script: { criterios: [{ id: "saudacao", descricao: "Cumprimenta pelo nome" }] } });
    expect(criteriosEmVigor(c)).toEqual({ formal: true, criterios: [{ id: "saudacao", descricao: "Cumprimenta pelo nome" }] });
  });
});
