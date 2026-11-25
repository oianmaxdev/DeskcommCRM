/**
 * A política do Supervisor Comercial — a ÚNICA forma de `supervisor_settings.config`.
 *
 * O jsonb do banco não tem schema; este arquivo é o schema. Duas leituras dele:
 *  - `supervisorConfigSchema` (ESTRITA): é o contrato da API. Valor inválido é
 *    recusado com 422 — a tela precisa saber o que não foi aceito.
 *  - `lerConfig` (TOLERANTE): é como o worker lê o banco. Nunca lança: campo
 *    velho ou corrompido cai no padrão daquele campo, sozinho, sem derrubar os
 *    outros. O padrão é SEGURO (nenhum funil monitorado = o Supervisor não age).
 *
 * ── Os três modos ────────────────────────────────────────────────────────────
 *  - `automatico`: o Supervisor aplica quando a evidência basta.
 *  - `aprovacao`: registra a ação como pendente; um gestor decide.
 *  - `desligado`: nem propõe.
 *
 * O padrão é deliberadamente assimétrico, e é isto que separa o produto de "um
 * assistente que sugere tudo": o trabalho ADMINISTRATIVO de baixo risco (etapa
 * para frente, campo vazio, tag permitida, tarefa, sinais do score) nasce
 * AUTOMÁTICO; o que fecha negócio, mexe em dinheiro ou dispara mensagem por
 * fluxo nasce em APROVAÇÃO. A organização sobe ou desce cada degrau.
 */
import { z } from "zod";

export const MODOS = ["automatico", "aprovacao", "desligado"] as const;
export type Modo = (typeof MODOS)[number];

export const NIVEIS_DE_GANHO = ["venda_comprovada", "confirmacao_verbal"] as const;

const etapaSchema = z.object({
  /** O que, na conversa, justifica entrar nesta etapa — em português de gente. */
  criterio: z.string().max(500).default(""),
  /** `false` = a etapa existe para o Supervisor, mas mover para ela pede aprovação. */
  automatico: z.boolean().default(true),
});
export type RegraDeEtapa = z.infer<typeof etapaSchema>;

const autonomiaSchema = z.object({
  mover_etapa: z.enum(MODOS).default("automatico"),
  campos: z.enum(MODOS).default("automatico"),
  /** Trocar valor JÁ preenchido. Desligado = só preenche campo vazio sozinho. */
  sobrescrever_campos: z.boolean().default(false),
  valor: z.enum(MODOS).default("aprovacao"),
  tags: z.enum(MODOS).default("automatico"),
  tarefas: z.enum(MODOS).default("automatico"),
  qualificacao: z.enum(MODOS).default("automatico"),
  followup: z.enum(MODOS).default("aprovacao"),
  ganho: z.enum(MODOS).default("aprovacao"),
  perda: z.enum(MODOS).default("aprovacao"),
});
export type Autonomia = z.infer<typeof autonomiaSchema>;

const scriptSchema = z.object({
  texto: z.string().max(4000).default(""),
  criterios: z
    .array(z.object({ id: z.string().regex(/^[a-z0-9_]{1,40}$/), descricao: z.string().min(1).max(300) }))
    .max(15)
    .default([]),
});

export const supervisorConfigSchema = z.object({
  /**
   * Funis sob responsabilidade do Supervisor. VAZIO = NENHUM. Ligar o
   * Supervisor sem escolher funil não pode fazê-lo mexer no funil de pós-venda
   * que ninguém pediu.
   */
  pipelines: z.array(z.string().uuid()).max(50).default([]),
  /** Debounce: a conversa só é lida depois de N minutos sem mensagem nova. */
  silencio_minutos: z.number().int().min(1).max(1440).default(20),
  /** Teto de conversas lidas por organização em cada rodada do cron. */
  max_conversas_por_rodada: z.number().int().min(1).max(200).default(20),
  autonomia: autonomiaSchema.prefault({}),
  /** Regras por etapa (chave = `crm_stages.id`). Etapa sem regra não é destino automático. */
  etapas: z.record(z.string().uuid(), etapaSchema).default({}),
  /** Tags que o Supervisor pode APLICAR. Fora da lista, nunca. */
  tags_permitidas: z.array(z.string().trim().min(1).max(60)).max(60).default([]),
  /** Tags que pode REMOVER. Lista separada: remover tem dependência operacional. */
  tags_removiveis: z.array(z.string().trim().min(1).max(60)).max(60).default([]),
  /** Campos personalizados que pode preencher. Vazio = todos os campos do funil. */
  campos_permitidos: z.array(z.string().max(40)).max(80).default([]),
  /** Fluxo de follow-up (ponteiro publicado) que o Supervisor pode iniciar. */
  followup_pointer_id: z.string().uuid().nullable().default(null),
  /** Nível mínimo de prova para registrar ganho SEM aprovação. */
  ganho_exige: z.enum(NIVEIS_DE_GANHO).default("venda_comprovada"),
  /** Script comercial da organização — a régua de aderência do diagnóstico. */
  script: scriptSchema.prefault({}),
  relatorio_recorrente: z.enum(["desligado", "semanal", "mensal"]).default("desligado"),
  /**
   * Depois de quantas horas sem retorno a ausência de follow-up passa a ser
   * FALHA. Antes disso é só "ainda não deu tempo" e não entra em contagem.
   */
  followup_devido_horas: z.number().int().min(1).max(720).default(24),
  /**
   * Movimento de etapa / tag feito SOZINHO pelo Supervisor dispara as regras de
   * automação e o follow-up por etapa da organização? Padrão NÃO: uma decisão
   * administrativa da IA não vira mensagem ao cliente por tabela. O evento é
   * emitido do mesmo jeito (ver lib/event-log/sem-disparo.ts).
   */
  movimento_dispara_automacoes: z.boolean().default(false),
});

export type SupervisorConfig = z.infer<typeof supervisorConfigSchema>;

/** O padrão SEGURO: nada monitorado. */
export function configPadrao(): SupervisorConfig {
  return supervisorConfigSchema.parse({});
}

function objeto(raw: unknown): Record<string, unknown> {
  return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
}

/** Lê o jsonb do banco. Nunca lança — campo inválido vira o padrão DAQUELE campo. */
export function lerConfig(raw: unknown): SupervisorConfig {
  const inteira = supervisorConfigSchema.safeParse(objeto(raw));
  if (inteira.success) return inteira.data;
  const obj = objeto(raw);
  const out = configPadrao() as Record<string, unknown>;
  for (const [chave, campo] of Object.entries(supervisorConfigSchema.shape)) {
    if (chave === "autonomia") {
      const a = objeto(obj.autonomia);
      const aut = autonomiaSchema.parse({}) as Record<string, unknown>;
      for (const [k, s] of Object.entries(autonomiaSchema.shape)) {
        const r = (s as z.ZodType).safeParse(a[k]);
        if (r.success) aut[k] = r.data;
      }
      out.autonomia = aut;
      continue;
    }
    const r = (campo as z.ZodType).safeParse(obj[chave]);
    if (r.success) out[chave] = r.data;
  }
  return out as SupervisorConfig;
}

/**
 * Critérios de aderência quando a organização não escreveu os dela.
 *
 * ⚠️ Avaliação contra ESTES critérios não é "conformidade com o script da
 * empresa" — é boa prática geral, e o diagnóstico rotula assim. Misturar os
 * dois faria um gestor cobrar da equipe um script que ele nunca escreveu.
 */
export const CRITERIOS_PADRAO: ReadonlyArray<{ id: string; rotulo: string; descricao: string }> = [
  {
    id: "investigou_necessidade",
    rotulo: "Entendeu a necessidade do cliente",
    descricao:
      "Entendeu O QUE o cliente precisa e para quê: perguntou sobre uso, preferência, problema a resolver — ou o cliente já explicou com clareza e o vendedor demonstrou ter entendido (aí conta como sim). Perguntar só orçamento ou prazo NÃO é investigar a necessidade.",
  },
  {
    id: "qualificou_orcamento",
    rotulo: "Verificou orçamento ou condição de pagamento",
    descricao: "Perguntou ou confirmou quanto o cliente pretende investir ou como pretende pagar. Não aplicável quando o produto tem preço fixo e baixo e a pergunta não faria sentido.",
  },
  {
    id: "qualificou_prazo",
    rotulo: "Verificou prazo ou urgência",
    descricao: "Perguntou ou confirmou para quando o cliente precisa. Não aplicável quando prazo não é uma variável da venda.",
  },
  {
    id: "apresentou_valor",
    rotulo: "Apresentou a oferta ligada ao que o cliente pediu",
    descricao: "Apresentou produto, serviço ou proposta relacionando-o ao que o cliente disse precisar (diferenciais, benefícios, alternativas), e não só o preço.",
  },
  {
    id: "tratou_objecao",
    rotulo: "Respondeu às objeções",
    descricao: "Quando o cliente levantou uma objeção (preço, prazo, dúvida), o vendedor respondeu a ela. Não aplicável se não houve objeção.",
  },
  {
    id: "pediu_fechamento",
    rotulo: "Conduziu para a decisão",
    descricao: "Quando havia sinal de interesse, fez uma pergunta ou proposta que levasse à decisão (fechar, reservar, agendar, visitar). Não aplicável se a conversa ainda não tinha chegado a esse ponto.",
  },
  {
    id: "combinou_proximo_passo",
    rotulo: "Combinou o próximo passo",
    descricao: "A conversa terminou com um próximo passo definido (data, ação ou responsável).",
  },
];

export function criteriosEmVigor(config: SupervisorConfig): {
  formal: boolean;
  criterios: ReadonlyArray<{ id: string; descricao: string; rotulo?: string }>;
} {
  if (config.script.criterios.length > 0) return { formal: true, criterios: config.script.criterios };
  return { formal: false, criterios: CRITERIOS_PADRAO };
}

/**
 * O nome que o USUÁRIO lê para um critério. O id fica para dentro: padrão →
 * rótulo escrito; critério da organização → a descrição que ela mesma deu;
 * id desconhecido (relatório antigo) → o id sem sublinhado, nunca o cru.
 */
export function rotuloDoCriterio(id: string, config?: SupervisorConfig | null): string {
  const padrao = CRITERIOS_PADRAO.find((c) => c.id === id);
  if (padrao) return padrao.rotulo;
  if (id === "qualificou") return "Fez perguntas de qualificação";
  const daOrg = config?.script.criterios.find((c) => c.id === id);
  if (daOrg) return daOrg.descricao;
  const t = id.replace(/_/g, " ");
  return t.charAt(0).toUpperCase() + t.slice(1);
}
