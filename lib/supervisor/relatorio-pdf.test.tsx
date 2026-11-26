// @vitest-environment node
import { describe, expect, it } from "vitest";

import { renderizaDiagnosticoEmPdf, textoParaPdf, type OpcoesDoPdf } from "./relatorio-pdf";
import type { CasoDoRelatorio, RelatorioGravado } from "./relatorio-tipos";

const caso = (n: number): CasoDoRelatorio => ({
  conversation_id: `conv-${n}`, lead_id: `lead-${n}`, contact_id: `c-${n}`, titulo: `Tênis da Tatiana ${n}`, tipo: "problema",
  motivo_da_escolha: "representa", situacao: "Preço informado sem condução", estagio: "interesse inicial",
  contexto: `A cliente ${n} perguntou o valor de um tênis.`,
  evidencias: [
    { quem: "cliente", texto: `Quanto custa esse tênis? (${n}) 😍`, em: "2026-11-12T18:15:00Z" },
    { quem: "vendedor", texto: "Fica em 4x de R$67,48", em: "2026-11-12T18:54:00Z" },
  ],
  positivos: ["Enviou fotos reais dos produtos."],
  faltou: [{ titulo: "Faltou conduzir", explicacao: "Informou o parcelamento e não perguntou a numeração." }],
  como_melhorar: [{ quando: "Ao informar o preço", exemplo_de_mensagem: "Qual numeração você calça? Já verifico a disponibilidade!" }],
  follow_up_sugerido: "Oi! Conseguiu dar uma olhadinha no tênis?",
  resumo: "Houve interesse inicial, mas a conversa não foi conduzida para uma decisão.",
  limitacao: null,
  recorrencia: n === 1 ? { grupo_id: "g1", outros: 3, frase: "Essa situação se repetiu em mais 3 atendimentos analisados no período.", conversation_ids: ["a", "b", "c"] } : null,
  outros_achados: [],
});

const relatorio = (casos: number): RelatorioGravado => ({
  id: "r1", period_from: "2026-11-10T03:00:00Z", period_to: "2026-11-17T03:00:00Z", status: "done", conversations_eligible: 40, conversations_analyzed: 30,
  recurring: false, created_at: "2026-11-17T12:00:00Z", error: null,
  metrics: {
    agregado: { problemas: [], aderencia: [{ criterio: "investigou_necessidade", avaliadas: 30, cumpridas: 9, pct: 30 }], criterios_formais: false, desfechos: {}, objecoes_recorrentes: [], precisam_follow_up: 4 },
    categorias: [{ codigo: "sem_proximo_passo", atendimentos: 12 }, { codigo: "objecao_sem_resposta", atendimentos: 5 }],
  },
  diagnosis: {
    versao: 2,
    contexto: { organizacao: "Visual Multimarcas", fuso: "America/Sao_Paulo", nicho: "Moda feminina e calçados", criterios_formais: false, base: "ramo" },
    resumo_executivo: "A equipe responde, mas não conduz a cliente para o próximo passo.",
    gargalos: [{ titulo: "Preço sem condução", descricao: "Informa o valor e para.", frequencia_observada: "12 de 30", evidencias: [], impacto: "Conversas esfriam.", confianca: "media", acao_recomendada: "Perguntar a numeração.", indicador: "% com próximo passo" }],
    pontos_positivos: ["Cordialidade."], riscos: [], recomendacoes_priorizadas: [{ prioridade: 1, acao: "Treinar a condução.", indicador: "aderência" }],
    limitacoes: ["Amostra de 30 atendimentos."],
    casos: Array.from({ length: casos }, (_, i) => caso(i + 1)),
  },
});

const opcoes = (p: Partial<OpcoesDoPdf> = {}): OpcoesDoPdf => ({
  modo: "detalhado", anonimo: false, organizacao: "Visual Multimarcas", fuso: "America/Sao_Paulo",
  rotuloDoCriterio: (id) => (id === "investigou_necessidade" ? "Entendeu a necessidade do cliente" : id), geradoEm: new Date("2026-11-17T12:00:00Z"), ...p,
});

async function leitura(pdf: Buffer): Promise<{ paginas: number; texto: string }> {
  const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const doc = await getDocument({ data: new Uint8Array(pdf), useSystemFonts: true }).promise;
  let texto = "";
  for (let i = 1; i <= doc.numPages; i++) {
    const c = await (await doc.getPage(i)).getTextContent();
    texto += c.items.map((x) => ("str" in x ? x.str : "")).join(" ") + "\n";
  }
  return { paginas: doc.numPages, texto: texto.replace(/\s+/g, " ") };
}

describe("PDF do diagnóstico", () => {
  it("é um PDF com TEXTO pesquisável: estrutura, números, evidências reais e sugestões rotuladas", async () => {
    const pdf = await renderizaDiagnosticoEmPdf(relatorio(2), opcoes());
    expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
    const { paginas, texto } = await leitura(pdf);
    expect(paginas).toBeGreaterThanOrEqual(2);
    for (const esperado of [
      "Diagnóstico comercial", "Visual Multimarcas", "10/11/2026 a 17/11/2026", "Atendimentos elegíveis", "40", "Analisados: 30",
      "Moda feminina e calçados", "Resumo executivo", "Falhas recorrentes", "12 de 30 atendimentos", "Entendeu a necessidade do cliente",
      "Recomendações comerciais", "Limitações da análise", "ESTUDO DE CASO 1", "Tênis da Tatiana 1", "Evidências do atendimento",
      "Fica em 4x de R$67,48", "O que foi positivo", "O que faltou no atendimento", "Como poderia ter sido melhor",
      "SUGESTÃO DE ABORDAGEM — NÃO FOI ENVIADA", "SUGESTÃO DE FOLLOW-UP — NÃO FOI ENVIADA", "Resumo da análise",
      "Essa situação se repetiu em mais 3 atendimentos analisados no período.", "Página 1 de",
    ]) {
      expect(texto, `faltou no PDF: ${esperado}`).toContain(esperado);
    }
    expect(texto).not.toContain("investigou_necessidade"); // id técnico não vaza
    expect(texto).toContain("12/11/2026"); // horário da mensagem no fuso da empresa
    expect(texto).toContain("15:15");
  }, 60_000);

  it("nunca mais que cinco estudos de caso, mesmo que o relatório gravado tenha mais", async () => {
    const { texto } = await leitura(await renderizaDiagnosticoEmPdf(relatorio(7), opcoes()));
    expect(texto).toContain("ESTUDO DE CASO 5");
    expect(texto).not.toContain("ESTUDO DE CASO 6");
  }, 60_000);

  it("modo resumo não traz casos; modo anônimo troca o título do negócio", async () => {
    const resumo = await leitura(await renderizaDiagnosticoEmPdf(relatorio(2), opcoes({ modo: "resumo" })));
    expect(resumo.texto).not.toContain("ESTUDO DE CASO");
    expect(resumo.texto).toContain("Resumo executivo");
    const anonimo = await leitura(await renderizaDiagnosticoEmPdf(relatorio(2), opcoes({ anonimo: true })));
    expect(anonimo.texto).toContain("Atendimento 1");
    expect(anonimo.texto).not.toContain("Tênis da Tatiana");
  }, 60_000);

  it("relatório ANTIGO (sem casos, sem contexto) continua exportável", async () => {
    const antigo = relatorio(0);
    antigo.diagnosis = { resumo_executivo: "Relatório da versão anterior.", limitacoes: [] };
    antigo.metrics = { agregado: { problemas: [{ codigo: "sem_proximo_passo", conversas: 2, pct: 50, exemplos: [] }], aderencia: [], criterios_formais: false, desfechos: {}, objecoes_recorrentes: [], precisam_follow_up: 0 } };
    const { texto } = await leitura(await renderizaDiagnosticoEmPdf(antigo, opcoes()));
    expect(texto).toContain("Relatório da versão anterior.");
    expect(texto).toContain("Conversa terminou sem próximo passo");
  }, 60_000);

  it("relatório incompleto avisa em destaque; denominadores diferentes ganham nota", async () => {
    const r = relatorio(1);
    r.diagnosis.completo = false;
    r.metrics.agregado!.aderencia = [{ criterio: "investigou_necessidade", avaliadas: 12, cumpridas: 4, pct: 33.3 }];
    const { texto } = await leitura(await renderizaDiagnosticoEmPdf(r, opcoes()));
    expect(texto).toContain("Análise consultiva incompleta");
    expect(texto).toContain("Cada critério é medido só nos atendimentos em que se aplicava");
    const completo = relatorio(1);
    completo.diagnosis.completo = true;
    expect((await leitura(await renderizaDiagnosticoEmPdf(completo, opcoes()))).texto).not.toContain("Análise consultiva incompleta");
  }, 60_000);

  it("emoji e seta não viram lixo no texto", () => {
    expect(textoParaPdf("Oi 😍  Qualificação → Proposta…")).toBe("Oi Qualificação -> Proposta...");
  });
});

describe("rótulos internos não chegam ao gestor", () => {
  it("troca c1/c2 por título do caso ou contagem, sem tocar ids nem citações de mensagem", async () => {
    const { semReferenciaInterna, limparDiagnostico } = await import("./relatorio-tipos");
    const t = new Map([["c1", "Site da clínica"]]);
    expect(semReferenciaInterna("boas conduções, como em c1 e c3. Porém", t)).toBe("boas conduções, como em 2 atendimentos. Porém");
    expect(semReferenciaInterna("Em c1, o vendedor investigou", t)).toBe("No caso “Site da clínica”, o vendedor investigou");
    expect(semReferenciaInterna("Em c2, o vendedor respondeu", t)).toBe("Em um atendimento, o vendedor respondeu");
    expect(semReferenciaInterna("nos atendimentos c2, c4 e c5", t)).toBe("em 3 atendimentos");
    const d = limparDiagnostico({ resumo_executivo: "como em c1 e c3", casos: [{ conversation_id: "c1", contexto: "visto em c2" }] });
    expect(d).toEqual({ resumo_executivo: "como em 2 atendimentos", casos: [{ conversation_id: "c1", contexto: "visto em um atendimento" }] });
  });
});
