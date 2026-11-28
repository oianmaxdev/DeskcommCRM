import { describe, expect, it } from "vitest";

import { agregaLeituras, agregaPorVendedor, type LeituraParaAgregar } from "./metricas";

// Critério fantasma: na demo PipeMax (28/11/2026) o modelo devolveu `ocasio_tamanho`
// no lugar de `ocasiao_tamanho`, e o diagnóstico ganhou uma linha "Ocasio tamanho 0/1".
const leitura = (conv: string, criterio: string, resultado: "sim" | "nao", owner = "u1"): LeituraParaAgregar =>
  ({ conversation_id: conv, owner_user_id: owner, analysis: { aderencia: [{ criterio, resultado }] } }) as LeituraParaAgregar;

const validos = new Set(["ocasiao_tamanho", "deu_valor"]);
const leituras = [
  leitura("c1", "ocasiao_tamanho", "sim"),
  leitura("c2", "ocasiao_tamanho", "nao"),
  leitura("c3", "ocasio_tamanho", "nao"),
  leitura("c3", "deu_valor", "sim"),
];

describe("aderência só com critérios configurados", () => {
  it("id inventado não vira linha nem mexe nos indicadores", () => {
    const a = agregaLeituras(leituras, validos);
    expect(a.aderencia.map((x) => x.criterio).sort()).toEqual(["deu_valor", "ocasiao_tamanho"]);
    expect(a.aderencia.find((x) => x.criterio === "ocasiao_tamanho")).toMatchObject({ avaliadas: 2, cumpridas: 1, pct: 50 });
  });

  it("o recorte por vendedor obedece à mesma lista", () => {
    const [v] = agregaPorVendedor(leituras, validos);
    expect(v?.agregado.aderencia.some((x) => x.criterio === "ocasio_tamanho")).toBe(false);
  });

  it("sem lista, comportamento antigo (compatibilidade)", () => {
    expect(agregaLeituras(leituras).aderencia.some((x) => x.criterio === "ocasio_tamanho")).toBe(true);
  });
});
