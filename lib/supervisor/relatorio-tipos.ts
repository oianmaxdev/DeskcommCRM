/**
 * A forma de um diagnóstico GRAVADO (`supervisor_reports`), como a tela e o PDF
 * a leem. Tudo opcional de propósito: relatórios anteriores à versão 2 não têm
 * casos, grupos nem contexto, e continuam abrindo — sem ser reescritos.
 */
import type { ProblemaDeAtendimento } from "./analise";

export interface EvidenciaDoCaso {
  quem: "cliente" | "vendedor" | "ia" | "automacao";
  texto: string;
  em: string;
  transcricao?: boolean;
}

export interface CasoDoRelatorio {
  conversation_id: string;
  lead_id: string | null;
  contact_id: string | null;
  titulo: string;
  tipo: "problema" | "boa_pratica";
  motivo_da_escolha: string;
  situacao: string | null;
  estagio: string | null;
  contexto: string;
  evidencias: EvidenciaDoCaso[];
  positivos: string[];
  faltou: Array<{ titulo: string; explicacao: string }>;
  como_melhorar: Array<{ quando: string; exemplo_de_mensagem: string }>;
  follow_up_sugerido: string | null;
  resumo: string;
  limitacao: string | null;
  recorrencia: { grupo_id: string; outros: number; frase: string | null; conversation_ids: string[] } | null;
  outros_achados: string[];
}

export interface RelatorioGravado {
  id: string;
  period_from: string;
  period_to: string;
  status: string;
  conversations_eligible: number;
  conversations_analyzed: number;
  recurring: boolean;
  created_at: string;
  error: string | null;
  metrics: {
    agregado?: {
      problemas: Array<{ codigo: ProblemaDeAtendimento; conversas: number; pct: number; exemplos: string[] }>;
      aderencia: Array<{ criterio: string; avaliadas: number; cumpridas: number; pct: number | null }>;
      criterios_formais: boolean;
      desfechos: Record<string, number>;
      objecoes_recorrentes: Array<{ texto: string; conversas: number }>;
      precisam_follow_up: number;
    };
    categorias?: Array<{ codigo: ProblemaDeAtendimento; atendimentos: number }>;
    rotulos_dos_criterios?: Record<string, string>;
    tarefas_atrasadas?: number;
  };
  diagnosis: {
    versao?: number;
    /** false = sem a análise consultiva do modelo (só números e evidências). Ausente em relatórios antigos. */
    completo?: boolean;
    contexto?: { organizacao: string | null; fuso: string | null; nicho: string | null; criterios_formais: boolean; base: "script" | "ramo" | "geral" };
    resumo_executivo?: string | null;
    gargalos?: Array<{ titulo: string; descricao: string; frequencia_observada: string; evidencias: string[]; impacto: string; confianca: string; acao_recomendada: string; indicador: string }>;
    pontos_positivos?: string[];
    riscos?: string[];
    recomendacoes_priorizadas?: Array<{ prioridade: number; acao: string; indicador: string }>;
    limitacoes?: string[];
    casos?: CasoDoRelatorio[];
  };
}

/**
 * Falhas por categoria para exibir: relatório novo usa a contagem já filtrada
 * (follow-up devido, evidência conferida); relatório antigo cai no agregado que
 * ele gravou na época.
 */
export function falhasPorCategoria(r: Pick<RelatorioGravado, "metrics" | "conversations_analyzed">): Array<{ codigo: ProblemaDeAtendimento; atendimentos: number }> {
  if (r.metrics.categorias) return r.metrics.categorias;
  return (r.metrics.agregado?.problemas ?? []).map((p) => ({ codigo: p.codigo, atendimentos: p.conversas }));
}

export const AUTOR_DA_MENSAGEM: Record<EvidenciaDoCaso["quem"], string> = {
  cliente: "Cliente",
  vendedor: "Vendedor",
  ia: "Assistente de IA",
  automacao: "Mensagem automática",
};

export const BASE_DA_AVALIACAO: Record<"script" | "ramo" | "geral", string> = {
  script: "Script e critérios cadastrados pela empresa",
  ramo: "Boas práticas do ramo informado pela empresa",
  geral: "Critérios gerais de venda consultiva (ramo não informado)",
};

/** Aviso de análise incompleta: diagnóstico v2 cuja interpretação ou redação não veio do modelo. */
export function avisoDeIncompleto(r: Pick<RelatorioGravado, "diagnosis" | "status">): string | null {
  if (r.status !== "done" || r.diagnosis?.versao !== 2 || r.diagnosis.completo !== false) return null;
  return "Análise consultiva incompleta: o modelo de IA não estava disponível quando este diagnóstico foi gerado. Os números, as evidências e as recorrências são válidos, mas faltam a interpretação, as recomendações de abordagem e as sugestões de follow-up. Gere o diagnóstico novamente quando o modelo estiver disponível.";
}

/** Explica a base da aderência quando ela não é o total analisado. */
export function notaDosDenominadores(aderencia: ReadonlyArray<{ avaliadas: number }>, analisados: number): string | null {
  if (!aderencia.some((a) => a.avaliadas !== analisados)) return null;
  return `Cada critério é medido só nos atendimentos em que se aplicava: em "3 de 6", o 6 é a quantidade de atendimentos em que aquele critério fazia sentido, dentre os ${analisados} analisados.`;
}

/**
 * Tira do texto do relatório as referências internas que o modelo recebe
 * (`c1`, `c2`… — o rótulo de cada atendimento no prompt). Elas não significam
 * nada para o gestor: viram o título do estudo de caso, quando o atendimento
 * foi escolhido como caso, ou "um atendimento" / "N atendimentos". Puro.
 * Medido na homologação com o modelo real: "como em c1 e c3", "Em c2, o vendedor…".
 */
const LISTA_DE_REFS = /\b(?:(em|no|na|nos|nas|de|do|da|dos|das)\s+)?(?:atendimentos?\s+)?((?:c\d{1,2}(?!-m))(?:\s*(?:,|e)\s*c\d{1,2}(?!-m))*)\b/gi;
export function semReferenciaInterna(texto: string, titulos: ReadonlyMap<string, string> = new Map()): string {
  return texto.replace(LISTA_DE_REFS, (_tudo, prep: string | undefined, lista: string) => {
    const refs = lista.match(/c\d{1,2}/gi)!.map((r) => r.toLowerCase());
    const maiuscula = (prep ?? lista)[0] === (prep ?? lista)[0]!.toUpperCase() && /[A-ZÀ-Ú]/.test((prep ?? "")[0] ?? "");
    let corpo: string;
    if (refs.length === 1 && titulos.has(refs[0]!)) corpo = `no caso “${titulos.get(refs[0]!)}”`;
    else corpo = refs.length === 1 ? "em um atendimento" : `em ${refs.length} atendimentos`;
    if (!prep) corpo = corpo.replace(/^(no|em) /, "");
    return maiuscula ? corpo[0]!.toUpperCase() + corpo.slice(1) : corpo;
  });
}

const CHAVES_DE_DADO = new Set(["conversation_id", "contact_id", "lead_id", "id", "grupo_id", "conversation_ids", "categoria", "estagio", "tipo", "ref", "evidencias"]);
/** O diagnóstico inteiro com `semReferenciaInterna` aplicada a todo texto de leitura. */
export function limparDiagnostico<T>(valor: T, titulos: ReadonlyMap<string, string> = new Map()): T {
  const limpa = (v: unknown, chave?: string): unknown => {
    if (chave && CHAVES_DE_DADO.has(chave)) return v;
    if (typeof v === "string") return semReferenciaInterna(v, titulos);
    if (Array.isArray(v)) return v.map((x) => limpa(x));
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, limpa(x, k)]));
    return v;
  };
  return limpa(valor) as T;
}
