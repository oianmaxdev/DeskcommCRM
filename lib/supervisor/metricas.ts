/**
 * A AGREGAÇÃO do diagnóstico — pura, sobre as leituras que o Pilar A já gravou.
 *
 * O diagnóstico NÃO relê conversa nenhuma: cada `supervisor_runs.analysis` já
 * traz aderência por critério, problemas de atendimento com citação e o
 * desfecho. Somar isso é SQL-barato e não custa modelo; o modelo entra uma vez
 * só, depois, para escrever a interpretação a partir destes números.
 *
 * Frequência é sempre contada por CONVERSA (uma conversa com o mesmo problema
 * em três janelas conta uma vez), e sempre sobre o universo ANALISADO — o
 * relatório mostra ao lado o universo ELEGÍVEL para ninguém confundir amostra
 * com totalidade.
 */
import { PROBLEMAS_DE_ATENDIMENTO, type ProblemaDeAtendimento } from "./analise";

export interface LeituraParaAgregar {
  conversation_id: string;
  owner_user_id: string | null;
  analysis: {
    aderencia?: Array<{ criterio: string; resultado: "sim" | "nao" | "nao_aplicavel"; evidencia?: { trecho?: string } | null }>;
    problemas?: Array<{ codigo: string; evidencia?: { trecho?: string } | null }>;
    desfecho?: { tipo?: string };
    objecoes_em_aberto?: Array<{ texto: string }>;
    precisa_follow_up?: { necessario?: boolean };
    criterios_formais?: boolean;
  };
}

export interface Agregado {
  conversas_analisadas: number;
  problemas: Array<{ codigo: ProblemaDeAtendimento; conversas: number; pct: number; exemplos: string[] }>;
  aderencia: Array<{ criterio: string; avaliadas: number; cumpridas: number; pct: number | null }>;
  criterios_formais: boolean;
  desfechos: Record<string, number>;
  objecoes_recorrentes: Array<{ texto: string; conversas: number }>;
  precisam_follow_up: number;
}

const pct = (a: number, b: number): number | null => (b === 0 ? null : Math.round((a / b) * 1000) / 10);

/**
 * `criteriosValidos`: os ids dos critérios EM VIGOR no diagnóstico (`criteriosEmVigor`).
 * Id que o modelo inventou ou escreveu errado (ex.: `ocasio_tamanho` no lugar de
 * `ocasiao_tamanho`, visto na demo de 28/11/2026) não vira linha do relatório nem
 * mexe nos indicadores. Sem o conjunto, nada é filtrado (compatibilidade).
 */
export function agregaLeituras(leituras: readonly LeituraParaAgregar[], criteriosValidos?: ReadonlySet<string>): Agregado {
  const conversas = new Set(leituras.map((l) => l.conversation_id));
  const total = conversas.size;

  const porProblema = new Map<string, { convs: Set<string>; exemplos: string[] }>();
  const porCriterio = new Map<string, { avaliadas: Set<string>; cumpridas: Set<string> }>();
  const desfechos: Record<string, number> = {};
  const desfechoPorConversa = new Map<string, string>();
  const objecoes = new Map<string, { texto: string; convs: Set<string> }>();
  const followUp = new Set<string>();
  let formais = false;

  for (const l of leituras) {
    const a = l.analysis ?? {};
    if (a.criterios_formais) formais = true;
    for (const p of a.problemas ?? []) {
      if (!(PROBLEMAS_DE_ATENDIMENTO as readonly string[]).includes(p.codigo)) continue;
      const e = porProblema.get(p.codigo) ?? { convs: new Set(), exemplos: [] };
      e.convs.add(l.conversation_id);
      const trecho = p.evidencia?.trecho?.trim();
      if (trecho && e.exemplos.length < 3 && !e.exemplos.includes(trecho)) e.exemplos.push(trecho.slice(0, 160));
      porProblema.set(p.codigo, e);
    }
    for (const c of a.aderencia ?? []) {
      if (c.resultado === "nao_aplicavel") continue;
      if (criteriosValidos && !criteriosValidos.has(c.criterio)) continue;
      const e = porCriterio.get(c.criterio) ?? { avaliadas: new Set(), cumpridas: new Set() };
      e.avaliadas.add(l.conversation_id);
      if (c.resultado === "sim") e.cumpridas.add(l.conversation_id);
      porCriterio.set(c.criterio, e);
    }
    // O desfecho que vale é o MAIS FORTE visto na conversa, não o da última janela.
    const tipo = a.desfecho?.tipo;
    if (tipo && tipo !== "nenhum") {
      const ordem = ["intencao_de_compra", "promessa_de_pagamento", "confirmacao_verbal", "venda_comprovada", "perda_definitiva"];
      const atual = desfechoPorConversa.get(l.conversation_id);
      if (!atual || ordem.indexOf(tipo) > ordem.indexOf(atual)) desfechoPorConversa.set(l.conversation_id, tipo);
    }
    for (const o of a.objecoes_em_aberto ?? []) {
      const k = o.texto.trim().toLowerCase();
      if (!k) continue;
      const e = objecoes.get(k) ?? { texto: o.texto.trim(), convs: new Set() };
      e.convs.add(l.conversation_id);
      objecoes.set(k, e);
    }
    if (a.precisa_follow_up?.necessario) followUp.add(l.conversation_id);
  }
  for (const t of desfechoPorConversa.values()) desfechos[t] = (desfechos[t] ?? 0) + 1;

  return {
    conversas_analisadas: total,
    problemas: [...porProblema.entries()]
      .map(([codigo, e]) => ({
        codigo: codigo as ProblemaDeAtendimento,
        conversas: e.convs.size,
        pct: pct(e.convs.size, total) ?? 0,
        exemplos: e.exemplos,
      }))
      .sort((x, y) => y.conversas - x.conversas),
    aderencia: [...porCriterio.entries()]
      .map(([criterio, e]) => ({
        criterio,
        avaliadas: e.avaliadas.size,
        cumpridas: e.cumpridas.size,
        pct: pct(e.cumpridas.size, e.avaliadas.size),
      }))
      .sort((x, y) => (x.pct ?? 101) - (y.pct ?? 101)),
    criterios_formais: formais,
    desfechos,
    objecoes_recorrentes: [...objecoes.values()]
      .map((o) => ({ texto: o.texto, conversas: o.convs.size }))
      .sort((x, y) => y.conversas - x.conversas)
      .slice(0, 8),
    precisam_follow_up: followUp.size,
  };
}

/** O mesmo agregado, por vendedor — para o gestor ver quem precisa de quê. */
export function agregaPorVendedor(leituras: readonly LeituraParaAgregar[], criteriosValidos?: ReadonlySet<string>): Array<{ owner_user_id: string; agregado: Agregado }> {
  const grupos = new Map<string, LeituraParaAgregar[]>();
  for (const l of leituras) {
    if (!l.owner_user_id) continue;
    const g = grupos.get(l.owner_user_id) ?? [];
    g.push(l);
    grupos.set(l.owner_user_id, g);
  }
  return [...grupos.entries()].map(([owner_user_id, g]) => ({ owner_user_id, agregado: agregaLeituras(g, criteriosValidos) }));
}

/** Rótulos legíveis — a tela e o prompt do diagnóstico usam os mesmos. */
export const ROTULO_DO_PROBLEMA: Record<ProblemaDeAtendimento, string> = {
  preco_sem_agregar_valor: "Preço informado sem agregar valor ao produto",
  preco_antes_da_necessidade: "Preço apresentado antes de entender a necessidade (critério antigo)",
  nao_investigou_necessidade: "Necessidade do cliente não investigada",
  nao_pediu_fechamento: "Não pediu o fechamento",
  sem_proximo_passo: "Conversa terminou sem próximo passo",
  compromisso_nao_cumprido: "Próximo passo prometido e não cumprido",
  objecao_sem_resposta: "Objeção ficou sem resposta",
  demora_para_responder: "Demora para responder o cliente",
  informacao_inconsistente: "Informação inconsistente passada ao cliente",
  sem_follow_up: "Faltou follow-up",
};
