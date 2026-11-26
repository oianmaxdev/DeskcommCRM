import { describe, expect, it } from "vitest";

import { agregaLeituras, agregaPorVendedor, type LeituraParaAgregar } from "./metricas";
import { recorrenteVencido, rotulaVendedores, rotulosDeVendedor } from "./diagnostico";
import { resolvePeriodo } from "./periodo";

const L = (conv: string, owner: string | null, a: LeituraParaAgregar["analysis"]): LeituraParaAgregar => ({
  conversation_id: conv,
  owner_user_id: owner,
  analysis: a,
});

describe("agregaLeituras", () => {
  const leituras = [
    // a mesma conversa em duas janelas conta UMA vez
    L("c1", "u1", { problemas: [{ codigo: "preco_antes_da_necessidade", evidencia: { trecho: "custa 5 mil" } }], desfecho: { tipo: "intencao_de_compra" } }),
    L("c1", "u1", { problemas: [{ codigo: "preco_antes_da_necessidade" }], desfecho: { tipo: "venda_comprovada" } }),
    L("c2", "u2", {
      problemas: [{ codigo: "sem_proximo_passo" }, { codigo: "codigo_inventado" }],
      aderencia: [
        { criterio: "pediu_fechamento", resultado: "nao" },
        { criterio: "investigou_necessidade", resultado: "sim" },
      ],
      objecoes_em_aberto: [{ texto: "Preço" }],
      precisa_follow_up: { necessario: true },
    }),
    L("c3", "u2", {
      aderencia: [
        { criterio: "pediu_fechamento", resultado: "sim" },
        { criterio: "investigou_necessidade", resultado: "nao_aplicavel" },
      ],
      objecoes_em_aberto: [{ texto: "preço " }],
    }),
  ];
  const ag = agregaLeituras(leituras);

  it("conta por conversa, não por janela", () => {
    expect(ag.conversas_analisadas).toBe(3);
    expect(ag.problemas.find((p) => p.codigo === "preco_antes_da_necessidade")).toMatchObject({ conversas: 1, pct: 33.3, exemplos: ["custa 5 mil"] });
  });
  it("ignora código fora do vocabulário", () => {
    expect(ag.problemas.map((p) => p.codigo)).not.toContain("codigo_inventado");
  });
  it("aderência ignora não-aplicável no denominador", () => {
    expect(ag.aderencia.find((a) => a.criterio === "pediu_fechamento")).toMatchObject({ avaliadas: 2, cumpridas: 1, pct: 50 });
    expect(ag.aderencia.find((a) => a.criterio === "investigou_necessidade")).toMatchObject({ avaliadas: 1, cumpridas: 1 });
  });
  it("desfecho que vale é o mais forte da conversa; objeções agrupadas sem caixa/espaço", () => {
    expect(ag.desfechos).toEqual({ venda_comprovada: 1 });
    expect(ag.objecoes_recorrentes[0]).toMatchObject({ conversas: 2 });
    expect(ag.precisam_follow_up).toBe(1);
  });
  it("por vendedor separa os universos", () => {
    const v = agregaPorVendedor(leituras);
    expect(v.find((x) => x.owner_user_id === "u2")?.agregado.conversas_analisadas).toBe(2);
  });
});

describe("períodos", () => {
  const agora = new Date("2026-11-13T15:00:00Z");
  it("resolve os atalhos e valida o personalizado", () => {
    expect(resolvePeriodo({ periodo: "7d" }, agora)?.de.toISOString()).toBe("2026-11-06T15:00:00.000Z");
    expect(resolvePeriodo({ periodo: "custom", de: "2026-11-10T00:00:00Z", ate: "2026-11-01T00:00:00Z" }, agora)).toBeNull();
    expect(resolvePeriodo({ periodo: "custom" }, agora)).toBeNull();
  });
  it("relatório recorrente vence pelo intervalo desde o último", () => {
    expect(recorrenteVencido("desligado", null, agora)).toBeNull();
    expect(recorrenteVencido("semanal", "2026-11-10T00:00:00Z", agora)).toBeNull();
    expect(recorrenteVencido("semanal", "2026-11-01T00:00:00Z", agora)).not.toBeNull();
    expect(recorrenteVencido("mensal", null, agora)?.de.toISOString()).toBe("2026-10-14T15:00:00.000Z");
  });
});

describe("vendedores no prompt do diagnóstico", () => {
  it("o id do vendedor vira rótulo estável e não aparece no texto enviado", () => {
    const r = rotulosDeVendedor(["u-1", "u-2", "u-1"]);
    const t = rotulaVendedores('[{"user_id":"u-2","won":1},{"owner_user_id":"u-1"}]', r);
    expect(t).toBe('[{"user_id":"Vendedor 2","won":1},{"owner_user_id":"Vendedor 1"}]');
  });
});
