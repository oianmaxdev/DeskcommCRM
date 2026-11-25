/**
 * CASOS E RECORRÊNCIA do diagnóstico — a parte que NÃO é do modelo.
 *
 * O modelo opina (quais situações são equivalentes, quais atendimentos valem
 * virar estudo de caso). Este arquivo decide o que dessa opinião é ACEITO, e
 * faz toda a conta:
 *
 *  - `montaDossies`: uma ficha por ATENDIMENTO (conversa), juntando as leituras
 *    do período. A mesma falha vista em três janelas da mesma conversa é UMA
 *    falha daquele atendimento.
 *  - Pré-agrupamento por (categoria, estágio da negociação). É a cerca que
 *    impede o agrupamento por palavra: "sem follow-up" depois de informar um
 *    preço e "sem follow-up" de uma visita combinada têm estágios diferentes e
 *    nunca caem no mesmo grupo. O modelo só pode REFINAR dentro da cerca
 *    (separar situações), nunca juntar por cima dela.
 *  - `validaGrupos` / `validaSelecao`: membro que não tem aquela falha é
 *    descartado; um atendimento entra uma vez por grupo; no máximo
 *    `MAX_CASOS` estudos de caso, um por atendimento e um por grupo.
 *  - A recorrência ("se repetiu em mais N atendimentos") é `membros − 1`,
 *    contada aqui — nunca um número escrito pelo modelo.
 */
import {
  ESTAGIOS_DA_NEGOCIACAO,
  PROBLEMAS_DE_ATENDIMENTO,
  type EstagioDaNegociacao,
  type ProblemaDeAtendimento,
} from "./analise";
import { fraseDaProva, type ProvaPorOmissao } from "./omissao";
import { ROTULO_DO_PROBLEMA } from "./metricas";

export const MAX_CASOS = 5;

export type Estagio = EstagioDaNegociacao | "nao_informado";

export const ROTULO_DO_ESTAGIO: Record<Estagio, string> = {
  interesse_inicial: "interesse inicial",
  qualificacao: "qualificação",
  apresentacao_da_oferta: "apresentação da oferta",
  proposta_enviada: "proposta enviada",
  negociacao: "negociação",
  compromisso_marcado: "compromisso já combinado",
  fechamento: "fechamento",
  pos_venda: "pós-venda",
  nao_informado: "estágio não informado",
};

export interface Falha {
  categoria: ProblemaDeAtendimento;
  estagio: Estagio;
  situacao: string;
  descricao: string;
  trecho: string | null;
  /** Em quantas leituras desta MESMA conversa a falha apareceu (não infla a recorrência). */
  ocorrencias_na_conversa: number;
  /** Falha por omissão: como ela foi verificada (origem, prazo, ausência no canal) — nunca "não aconteceu". */
  verificacao?: string;
}

export interface Dossie {
  ref: string;
  conversation_id: string;
  lead_id: string | null;
  contact_id: string | null;
  owner_user_id: string | null;
  resumo: string;
  desfecho: string | null;
  falhas: Falha[];
  /** Falhas apontadas e NÃO contadas, com o motivo — rastro, nunca número. */
  desconsideradas: Array<{ categoria: string; motivo: "sem_evidencia" | "follow_up_ainda_nao_devido" }>;
  positivos: string[];
}

export interface LeituraDoPeriodo {
  conversation_id: string;
  lead_id: string | null;
  contact_id: string | null;
  owner_user_id: string | null;
  last_message_at: string;
  summary: string;
  analysis: {
    problemas?: Array<{
      codigo?: string;
      estagio?: string;
      situacao?: string;
      descricao?: string;
      evidencia?: { trecho?: string } | null;
      evidencia_verificada?: boolean;
      prova_por_omissao?: ProvaPorOmissao;
    }>;
    pontos_positivos?: Array<{ texto?: string; evidencia_verificada?: boolean }>;
    desfecho?: { tipo?: string };
  } | null;
}

const ehCategoria = (c: unknown): c is ProblemaDeAtendimento => (PROBLEMAS_DE_ATENDIMENTO as readonly string[]).includes(String(c));
const ehEstagio = (e: unknown): e is EstagioDaNegociacao => (ESTAGIOS_DA_NEGOCIACAO as readonly string[]).includes(String(e));

/**
 * Uma ficha por atendimento. `followUpDevido(conversationId)` diz se, AGORA, já
 * passou o tempo em que um retorno era devido — sem isso, "sem follow-up" é só
 * "ainda não deu tempo" e fica fora de toda contagem.
 */
export function montaDossies(
  leituras: readonly LeituraDoPeriodo[],
  followUpDevido: (conversationId: string) => boolean,
  /** Formata data/hora no fuso da empresa para a frase de verificação da omissão. */
  formata: (iso: string) => string = (iso) => iso,
): Dossie[] {
  const porConversa = new Map<string, LeituraDoPeriodo[]>();
  for (const l of [...leituras].sort((a, b) => a.last_message_at.localeCompare(b.last_message_at))) {
    const g = porConversa.get(l.conversation_id) ?? [];
    g.push(l);
    porConversa.set(l.conversation_id, g);
  }
  const out: Dossie[] = [];
  for (const [conversation_id, janelas] of porConversa) {
    const ultima = janelas[janelas.length - 1]!;
    const falhas = new Map<string, Falha>();
    const desconsideradas: Dossie["desconsideradas"] = [];
    const positivos: string[] = [];
    let desfecho: string | null = null;
    for (const j of janelas) {
      const a = j.analysis ?? {};
      if (a.desfecho?.tipo && a.desfecho.tipo !== "nenhum") desfecho = a.desfecho.tipo;
      for (const p of a.pontos_positivos ?? []) {
        const t = p.texto?.trim();
        if (t && p.evidencia_verificada !== false && !positivos.includes(t) && positivos.length < 4) positivos.push(t);
      }
      for (const p of a.problemas ?? []) {
        if (!ehCategoria(p.codigo)) continue;
        const trecho = p.prova_por_omissao?.origem.trecho?.trim() || p.evidencia?.trecho?.trim() || null;
        // Leitura antiga não tem a marca: vale a citação existir. Leitura nova:
        // só conta se o código conferiu o trecho na conversa.
        const comprovada = p.evidencia_verificada === undefined ? trecho !== null : p.evidencia_verificada;
        if (!comprovada) {
          desconsideradas.push({ categoria: p.codigo, motivo: "sem_evidencia" });
          continue;
        }
        // Retorno ainda dentro do prazo não é falha: nem a falta de follow-up nem o
        // passo prometido que ainda pode ser cumprido.
        if ((p.codigo === "sem_follow_up" || p.codigo === "compromisso_nao_cumprido") && !followUpDevido(conversation_id)) {
          desconsideradas.push({ categoria: p.codigo, motivo: "follow_up_ainda_nao_devido" });
          continue;
        }
        const estagio: Estagio = ehEstagio(p.estagio) ? p.estagio : "nao_informado";
        const chave = `${p.codigo}|${estagio}`;
        const ja = falhas.get(chave);
        if (ja) ja.ocorrencias_na_conversa += 1;
        else {
          falhas.set(chave, {
            categoria: p.codigo,
            estagio,
            situacao: p.situacao?.trim() || ROTULO_DO_PROBLEMA[p.codigo],
            descricao: p.descricao?.trim() || "",
            trecho,
            ocorrencias_na_conversa: 1,
            ...(p.prova_por_omissao ? { verificacao: fraseDaProva(p.prova_por_omissao, formata) } : {}),
          });
        }
      }
    }
    out.push({
      ref: `c${out.length + 1}`,
      conversation_id,
      lead_id: ultima.lead_id,
      contact_id: ultima.contact_id,
      owner_user_id: ultima.owner_user_id,
      resumo: ultima.summary,
      desfecho,
      falhas: [...falhas.values()],
      desconsideradas,
      positivos,
    });
  }
  return out;
}

export interface Grupo {
  id: string;
  categoria: ProblemaDeAtendimento;
  estagio: Estagio;
  titulo: string;
  /** Atendimentos DISTINTOS com esta situação. */
  conversation_ids: string[];
}

export interface GrupoDoModelo {
  categoria: string;
  estagio: string;
  titulo: string;
  membros: string[];
}

const tituloPadrao = (c: ProblemaDeAtendimento, e: Estagio) => `${ROTULO_DO_PROBLEMA[c]} (${ROTULO_DO_ESTAGIO[e]})`;

/** A cerca: (categoria, estágio) → atendimentos. É também o agrupamento de reserva. */
export function preAgrupa(dossies: readonly Dossie[]): Map<string, { categoria: ProblemaDeAtendimento; estagio: Estagio; refs: string[] }> {
  const m = new Map<string, { categoria: ProblemaDeAtendimento; estagio: Estagio; refs: string[] }>();
  for (const d of dossies) {
    for (const f of d.falhas) {
      const k = `${f.categoria}|${f.estagio}`;
      const b = m.get(k) ?? { categoria: f.categoria, estagio: f.estagio, refs: [] };
      if (!b.refs.includes(d.ref)) b.refs.push(d.ref);
      m.set(k, b);
    }
  }
  return m;
}

/**
 * Aceita do agrupamento do modelo só o que os FATOS sustentam.
 * `doModelo = null` (chamada falhou) → o agrupamento é a própria cerca.
 */
export function validaGrupos(dossies: readonly Dossie[], doModelo: readonly GrupoDoModelo[] | null): Grupo[] {
  const cerca = preAgrupa(dossies);
  const idDe = new Map(dossies.map((d) => [d.ref, d.conversation_id]));
  const usados = new Set<string>(); // `${ref}|${categoria}|${estagio}`
  const grupos: Grupo[] = [];
  const novo = (categoria: ProblemaDeAtendimento, estagio: Estagio, titulo: string, refs: string[]) =>
    grupos.push({ id: `g${grupos.length + 1}`, categoria, estagio, titulo, conversation_ids: refs.map((r) => idDe.get(r)!) });

  for (const g of doModelo ?? []) {
    if (!ehCategoria(g.categoria)) continue;
    const estagio: Estagio = ehEstagio(g.estagio) ? g.estagio : "nao_informado";
    const balde = cerca.get(`${g.categoria}|${estagio}`);
    if (!balde) continue;
    const refs: string[] = [];
    for (const r of g.membros) {
      const k = `${r}|${g.categoria}|${estagio}`;
      // membro tem de estar NA cerca (ter esta falha neste estágio) e ainda livre
      if (balde.refs.includes(r) && !usados.has(k) && !refs.includes(r)) {
        refs.push(r);
        usados.add(k);
      }
    }
    if (refs.length > 0) novo(g.categoria, estagio, g.titulo?.trim().slice(0, 160) || tituloPadrao(g.categoria, estagio), refs);
  }

  for (const [k, balde] of cerca) {
    const livres = balde.refs.filter((r) => !usados.has(`${r}|${k}`));
    if (livres.length === 0) continue;
    if (doModelo === null) novo(balde.categoria, balde.estagio, tituloPadrao(balde.categoria, balde.estagio), livres);
    // O modelo agrupou e deixou estes de fora: cada um fica SOZINHO. Juntá-los
    // por conta própria inflaria uma recorrência que ninguém afirmou.
    else for (const r of livres) novo(balde.categoria, balde.estagio, dossies.find((d) => d.ref === r)!.falhas.find((f) => `${f.categoria}|${f.estagio}` === k)!.situacao, [r]);
  }
  return grupos;
}

export interface EscolhaDoModelo {
  conversa: string;
  tipo: "problema" | "boa_pratica";
  motivo: string;
}

export interface CasoSelecionado {
  ref: string;
  conversation_id: string;
  tipo: "problema" | "boa_pratica";
  motivo_da_escolha: string;
  /** O grupo que este caso REPRESENTA (o maior entre os do atendimento). */
  grupo_id: string | null;
  /** Quantos OUTROS atendimentos têm a mesma situação. */
  outros_atendimentos: number;
  /** Demais achados do mesmo atendimento — citados no caso, nunca viram outro caso. */
  outros_achados: string[];
}

const ORDEM_DO_ESTAGIO = (e: Estagio) => (e === "nao_informado" ? -1 : ESTAGIOS_DA_NEGOCIACAO.indexOf(e));

function grupoPrincipal(d: Dossie, grupos: readonly Grupo[], jaRepresentados: ReadonlySet<string>): Grupo | null {
  const meus = grupos.filter((g) => g.conversation_ids.includes(d.conversation_id) && !jaRepresentados.has(g.id));
  if (meus.length === 0) return null;
  return [...meus].sort(
    (a, b) => b.conversation_ids.length - a.conversation_ids.length || ORDEM_DO_ESTAGIO(b.estagio) - ORDEM_DO_ESTAGIO(a.estagio),
  )[0]!;
}

function monta(d: Dossie, tipo: CasoSelecionado["tipo"], motivo: string, g: Grupo | null, grupos: readonly Grupo[]): CasoSelecionado {
  return {
    ref: d.ref,
    conversation_id: d.conversation_id,
    tipo,
    motivo_da_escolha: motivo.trim().slice(0, 400),
    grupo_id: g?.id ?? null,
    outros_atendimentos: g ? g.conversation_ids.length - 1 : 0,
    outros_achados: grupos
      .filter((x) => x.id !== g?.id && x.conversation_ids.includes(d.conversation_id))
      .map((x) => x.titulo),
  };
}

/**
 * Até `MAX_CASOS`, um por atendimento e um por grupo. Escolha do modelo
 * inválida é descartada SEM substituto: menos casos é resposta legítima.
 * `doModelo = null` → seleção de reserva, determinística.
 */
export function validaSelecao(
  dossies: readonly Dossie[],
  grupos: readonly Grupo[],
  doModelo: readonly EscolhaDoModelo[] | null,
): CasoSelecionado[] {
  const porRef = new Map(dossies.map((d) => [d.ref, d]));
  const casos: CasoSelecionado[] = [];
  const representados = new Set<string>();
  const usados = new Set<string>();

  const tenta = (d: Dossie, tipo: CasoSelecionado["tipo"], motivo: string): void => {
    if (casos.length >= MAX_CASOS || usados.has(d.ref)) return;
    if (tipo === "boa_pratica") {
      if (d.positivos.length === 0) return;
      usados.add(d.ref);
      casos.push(monta(d, tipo, motivo, null, grupos));
      return;
    }
    const g = grupoPrincipal(d, grupos, representados);
    if (!g) return; // sem falha comprovada, ou a situação dele já tem um representante
    usados.add(d.ref);
    representados.add(g.id);
    casos.push(monta(d, tipo, motivo, g, grupos));
  };

  if (doModelo !== null) {
    for (const e of doModelo) {
      const d = porRef.get(e.conversa?.trim());
      if (d) tenta(d, e.tipo === "boa_pratica" ? "boa_pratica" : "problema", e.motivo ?? "");
    }
    return casos;
  }

  // Reserva: grupos mais recorrentes primeiro (e, no empate, o estágio mais
  // avançado); representante = o atendimento com a descrição mais completa.
  const ordenados = [...grupos].sort(
    (a, b) => b.conversation_ids.length - a.conversation_ids.length || ORDEM_DO_ESTAGIO(b.estagio) - ORDEM_DO_ESTAGIO(a.estagio),
  );
  for (const g of ordenados) {
    if (casos.length >= MAX_CASOS - 1 || representados.has(g.id)) continue;
    const candidatos = dossies
      .filter((d) => g.conversation_ids.includes(d.conversation_id) && !usados.has(d.ref))
      .sort((a, b) => b.falhas.reduce((n, f) => n + f.descricao.length, 0) - a.falhas.reduce((n, f) => n + f.descricao.length, 0));
    const d = candidatos[0];
    if (!d) continue;
    usados.add(d.ref);
    representados.add(g.id);
    const outros = g.conversation_ids.length - 1;
    casos.push(monta(d, "problema", outros > 0 ? `Representa uma situação vista em ${outros + 1} atendimentos.` : "Achado relevante do período.", g, grupos));
  }
  const bom = dossies.filter((d) => !usados.has(d.ref) && d.positivos.length > 0).sort((a, b) => a.falhas.length - b.falhas.length)[0];
  if (bom) tenta(bom, "boa_pratica", "Boa condução que vale ser reproduzida pela equipe.");
  return casos;
}

/** "Essa situação se repetiu em mais N atendimento(s)…" — ou null quando não se repetiu. */
export function fraseDeRecorrencia(outros: number): string | null {
  if (outros <= 0) return null;
  return outros === 1
    ? "Essa situação se repetiu em mais 1 atendimento analisado no período."
    : `Essa situação se repetiu em mais ${outros} atendimentos analisados no período.`;
}

/** Atendimentos distintos por CATEGORIA — o número do diagnóstico geral. */
export function contaPorCategoria(dossies: readonly Dossie[]): Array<{ codigo: ProblemaDeAtendimento; atendimentos: number }> {
  const m = new Map<ProblemaDeAtendimento, Set<string>>();
  for (const d of dossies) for (const f of d.falhas) m.set(f.categoria, (m.get(f.categoria) ?? new Set()).add(d.conversation_id));
  return [...m.entries()].map(([codigo, s]) => ({ codigo, atendimentos: s.size })).sort((a, b) => b.atendimentos - a.atendimentos);
}
