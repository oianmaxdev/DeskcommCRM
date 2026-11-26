import { describe, expect, it } from "vitest";

import {
  contaPorCategoria,
  fraseDeRecorrencia,
  MAX_CASOS,
  montaDossies,
  validaGrupos,
  validaSelecao,
  type LeituraDoPeriodo,
} from "./casos";

type P = NonNullable<NonNullable<LeituraDoPeriodo["analysis"]>["problemas"]>[number];
const falha = (codigo: string, estagio: string, situacao: string, extra: Partial<P> = {}): P => ({
  codigo,
  estagio,
  situacao,
  descricao: `fatos: ${situacao}`,
  evidencia: { trecho: "trecho real" },
  evidencia_verificada: true,
  ...extra,
});
const leitura = (conv: string, problemas: P[], extra: Partial<LeituraDoPeriodo> = {}, positivos: string[] = []): LeituraDoPeriodo => ({
  conversation_id: conv,
  lead_id: `lead-${conv}`,
  contact_id: `contato-${conv}`,
  owner_user_id: "u1",
  last_message_at: "2026-11-10T12:00:00Z",
  summary: `resumo ${conv}`,
  analysis: { problemas, pontos_positivos: positivos.map((texto) => ({ texto, evidencia_verificada: true })) },
  ...extra,
});
const sempreDevido = () => true;
const PRECO = falha("sem_proximo_passo", "interesse_inicial", "informou o preço e não conduziu para o próximo passo");

describe("1. período com 30 conversas", () => {
  const leituras = Array.from({ length: 30 }, (_, i) =>
    leitura(`conv${i}`, [falha(["sem_proximo_passo", "nao_pediu_fechamento", "objecao_sem_resposta", "demora_para_responder", "nao_investigou_necessidade", "informacao_inconsistente"][i % 6]!, "negociacao", `situação ${i % 6}`)]),
  );
  const dossies = montaDossies(leituras, sempreDevido);
  const grupos = validaGrupos(dossies, null);

  it("a seleção de reserva nunca passa de cinco", () => {
    expect(validaSelecao(dossies, grupos, null).length).toBeLessThanOrEqual(MAX_CASOS);
  });
  it("o modelo pedindo trinta casos recebe no máximo cinco", () => {
    const pedido = dossies.map((d) => ({ conversa: d.ref, tipo: "problema" as const, motivo: "x" }));
    const casos = validaSelecao(dossies, grupos, pedido);
    expect(casos).toHaveLength(MAX_CASOS);
    expect(new Set(casos.map((c) => c.conversation_id)).size).toBe(MAX_CASOS);
  });
  it("8. os 30 atendimentos seguem contados no agregado, não só os 5 exemplos", () => {
    expect(contaPorCategoria(dossies).reduce((n, c) => n + c.atendimentos, 0)).toBe(30);
    expect(contaPorCategoria(dossies).find((c) => c.codigo === "sem_proximo_passo")?.atendimentos).toBe(5);
  });
});

describe("2. só duas conversas relevantes", () => {
  it("apresenta duas — não preenche o limite com atendimentos sem achado", () => {
    const leituras = [leitura("a", [PRECO]), leitura("b", [falha("objecao_sem_resposta", "negociacao", "cliente achou caro e ficou sem resposta")]), ...["c", "d", "e", "f"].map((c) => leitura(c, []))];
    const dossies = montaDossies(leituras, sempreDevido);
    const grupos = validaGrupos(dossies, null);
    expect(validaSelecao(dossies, grupos, null).map((c) => c.conversation_id).sort()).toEqual(["a", "b"]);
    // e o modelo insistindo num atendimento sem falha comprovada é ignorado
    const forcado = validaSelecao(dossies, grupos, [{ conversa: "c3", tipo: "problema", motivo: "encher" }]);
    expect(forcado).toEqual([]);
  });
});

describe("3. mesma falha, contexto equivalente, em vários atendimentos", () => {
  const leituras = ["a", "b", "c", "d", "e"].map((c) => leitura(c, [PRECO]));
  const dossies = montaDossies(leituras, sempreDevido);
  const grupos = validaGrupos(dossies, [{ categoria: "sem_proximo_passo", estagio: "interesse_inicial", titulo: "Preço informado sem condução", membros: dossies.map((d) => d.ref) }]);

  it("um grupo, um exemplo, e a recorrência é 'mais 4'", () => {
    expect(grupos).toHaveLength(1);
    const pedido = dossies.map((d) => ({ conversa: d.ref, tipo: "problema" as const, motivo: "x" }));
    const casos = validaSelecao(dossies, grupos, pedido);
    expect(casos).toHaveLength(1); // os outros quatro são a MESMA situação: não viram caso
    expect(casos[0]!.outros_atendimentos).toBe(4);
    expect(fraseDeRecorrencia(casos[0]!.outros_atendimentos)).toBe("Essa situação se repetiu em mais 4 atendimentos analisados no período.");
  });
  it("a frase no singular e a ausência dela", () => {
    expect(fraseDeRecorrencia(1)).toBe("Essa situação se repetiu em mais 1 atendimento analisado no período.");
    expect(fraseDeRecorrencia(0)).toBeNull();
  });
});

describe("4. uma conversa com várias ocorrências do mesmo problema", () => {
  it("conta como UM atendimento", () => {
    const leituras = [
      leitura("a", [PRECO], { last_message_at: "2026-11-10T10:00:00Z" }),
      leitura("a", [PRECO, PRECO], { last_message_at: "2026-11-10T15:00:00Z" }),
      leitura("b", [PRECO]),
    ];
    const dossies = montaDossies(leituras, sempreDevido);
    expect(dossies).toHaveLength(2);
    expect(dossies.find((d) => d.conversation_id === "a")!.falhas).toEqual([expect.objectContaining({ ocorrencias_na_conversa: 3 })]);
    const grupos = validaGrupos(dossies, null);
    expect(grupos[0]!.conversation_ids).toHaveLength(2);
    expect(validaSelecao(dossies, grupos, null)[0]!.outros_atendimentos).toBe(1);
  });
});

describe("5. follow-up após preço × follow-up de visita combinada", () => {
  const leituras = [
    leitura("preco", [falha("sem_follow_up", "interesse_inicial", "informou o preço e não retomou")]),
    leitura("visita", [falha("sem_follow_up", "compromisso_marcado", "cliente combinou visitar a loja e a visita não foi confirmada")]),
  ];
  const dossies = montaDossies(leituras, sempreDevido);

  it("não são a mesma situação, nem na reserva…", () => {
    const grupos = validaGrupos(dossies, null);
    expect(grupos).toHaveLength(2);
    expect(grupos.every((g) => g.conversation_ids.length === 1)).toBe(true);
  });
  it("…nem quando o MODELO tenta juntar as duas por serem 'falta de follow-up'", () => {
    const grupos = validaGrupos(dossies, [{ categoria: "sem_follow_up", estagio: "interesse_inicial", titulo: "Falta de follow-up", membros: ["c1", "c2"] }]);
    expect(grupos).toHaveLength(2);
    expect(grupos.map((g) => g.conversation_ids)).toEqual([["preco"], ["visita"]]);
    const casos = validaSelecao(dossies, grupos, null);
    expect(casos.every((c) => c.outros_atendimentos === 0)).toBe(true);
  });
  it("mas a CATEGORIA geral soma as duas", () => {
    expect(contaPorCategoria(dossies)).toEqual([{ codigo: "sem_follow_up", atendimentos: 2 }]);
  });
  it("o modelo pode SEPARAR dentro do mesmo estágio; quem ele não citou fica sozinho", () => {
    const tres = montaDossies(["a", "b", "c"].map((c) => leitura(c, [PRECO])), sempreDevido);
    const grupos = validaGrupos(tres, [{ categoria: "sem_proximo_passo", estagio: "interesse_inicial", titulo: "t", membros: ["c1", "c2"] }]);
    expect(grupos.map((g) => g.conversation_ids.length)).toEqual([2, 1]);
  });
});

describe("6. conversa com várias falhas distintas", () => {
  it("aparece UMA vez; os outros achados vão dentro do mesmo caso", () => {
    const leituras = [
      leitura("a", [PRECO, falha("demora_para_responder", "interesse_inicial", "resposta após 2h"), falha("objecao_sem_resposta", "negociacao", "objeção de prazo ignorada")]),
      leitura("b", [PRECO]),
    ];
    const dossies = montaDossies(leituras, sempreDevido);
    const grupos = validaGrupos(dossies, null);
    const casos = validaSelecao(dossies, grupos, [
      { conversa: "c1", tipo: "problema", motivo: "a" },
      { conversa: "c1", tipo: "problema", motivo: "de novo" },
    ]);
    expect(casos).toHaveLength(1);
    expect(casos[0]!.outros_atendimentos).toBe(1); // representa o grupo que se repete
    expect(casos[0]!.outros_achados).toHaveLength(2);
  });
});

describe("7. follow-up ainda não devido", () => {
  it("não é falha: fica fora de grupo, de caso e de contagem — e o motivo fica registrado", () => {
    const leituras = [leitura("a", [falha("sem_follow_up", "proposta_enviada", "proposta enviada há 2h sem retorno")])];
    const dossies = montaDossies(leituras, () => false);
    expect(dossies[0]!.falhas).toEqual([]);
    expect(dossies[0]!.desconsideradas).toEqual([{ categoria: "sem_follow_up", motivo: "follow_up_ainda_nao_devido" }]);
    expect(validaGrupos(dossies, null)).toEqual([]);
    expect(contaPorCategoria(dossies)).toEqual([]);
    expect(validaSelecao(dossies, [], null)).toEqual([]);
  });
});

describe("9. evidência insuficiente", () => {
  it("falha sem citação conferida não entra em classificação nem recorrência", () => {
    const leituras = [
      leitura("a", [falha("nao_pediu_fechamento", "negociacao", "x", { evidencia_verificada: false })]),
      leitura("b", [falha("nao_pediu_fechamento", "negociacao", "x", { evidencia: null, evidencia_verificada: undefined })]),
      leitura("c", [falha("codigo_inventado", "negociacao", "x")]),
    ];
    const dossies = montaDossies(leituras, sempreDevido);
    expect(dossies.flatMap((d) => d.falhas)).toEqual([]);
    expect(dossies[0]!.desconsideradas).toEqual([{ categoria: "nao_pediu_fechamento", motivo: "sem_evidencia" }]);
    expect(validaGrupos(dossies, [{ categoria: "nao_pediu_fechamento", estagio: "negociacao", titulo: "inventado", membros: ["c1", "c2", "c3"] }])).toEqual([]);
  });
  it("membro que o modelo põe num grupo sem ter aquela falha é descartado", () => {
    const dossies = montaDossies([leitura("a", [PRECO]), leitura("b", [])], sempreDevido);
    const grupos = validaGrupos(dossies, [{ categoria: "sem_proximo_passo", estagio: "interesse_inicial", titulo: "t", membros: ["c1", "c2", "c99"] }]);
    expect(grupos[0]!.conversation_ids).toEqual(["a"]);
  });
  it("leitura ANTIGA (sem estágio nem marca) segue utilizável: compatibilidade", () => {
    const antiga = leitura("a", [{ codigo: "sem_proximo_passo", evidencia: { trecho: "ok então" } }]);
    const d = montaDossies([antiga], sempreDevido)[0]!;
    expect(d.falhas[0]).toMatchObject({ estagio: "nao_informado", situacao: "Conversa terminou sem próximo passo" });
  });
});

describe("boas práticas", () => {
  it("exemplo positivo entra sem tirar a vaga de um problema e exige ponto positivo real", () => {
    const leituras = [leitura("ruim", [PRECO]), leitura("boa", [], {}, ["Investigou a numeração e enviou fotos reais"]), leitura("neutra", [])];
    const dossies = montaDossies(leituras, sempreDevido);
    const grupos = validaGrupos(dossies, null);
    expect(validaSelecao(dossies, grupos, null).map((c) => [c.conversation_id, c.tipo])).toEqual([["ruim", "problema"], ["boa", "boa_pratica"]]);
    expect(validaSelecao(dossies, grupos, [{ conversa: "c3", tipo: "boa_pratica", motivo: "x" }])).toEqual([]);
  });
});

describe("próximo passo prometido × ausente", () => {
  it("compromisso ainda dentro do prazo não é falha; vencido conta, e em grupo separado de 'sem próximo passo'", () => {
    const prometido = falha("compromisso_nao_cumprido", "compromisso_marcado", "prometeu enviar fotos e não enviou");
    const ausente = falha("sem_proximo_passo", "compromisso_marcado", "nada combinado");
    expect(montaDossies([leitura("a", [prometido])], () => false)[0]!.falhas).toEqual([]);
    const dossies = montaDossies([leitura("a", [prometido]), leitura("b", [ausente])], sempreDevido);
    expect(validaGrupos(dossies, null).map((g) => g.categoria).sort()).toEqual(["compromisso_nao_cumprido", "sem_proximo_passo"]);
  });
});
