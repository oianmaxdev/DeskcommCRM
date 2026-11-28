/**
 * A POLÍTICA DE AUTONOMIA — leitura verificada + estado do negócio + config → ações.
 *
 * Função pura: não lê banco, não chama modelo, não escreve. Tudo o que decide
 * se o Supervisor AGE, PEDE APROVAÇÃO ou SE CALA mora aqui, e por isso é aqui
 * que os testes batem (`politica.test.ts`).
 *
 * Três graus de risco (o mesmo vocabulário de `supervisor_actions.risk`):
 *  - `baixo`: etapa para frente com regra, campo vazio, tag permitida, tarefa,
 *    sinais do score. Automático quando a organização deixou.
 *  - `condicional`: sobrescrever campo, voltar etapa, etapa sensível, valor do
 *    negócio, iniciar follow-up, remover tag. Automático só com o knob próprio.
 *  - `critico`: ganho e perda. Automático só com autorização explícita E prova
 *    no nível exigido — "vou comprar" é intenção, nunca venda.
 *
 * E uma regra acima das três: decisão humana mais recente que a evidência
 * VENCE. Se o vendedor mexeu na etapa depois da mensagem que justificaria o
 * movimento, o Supervisor não desfaz — ele não sabe o que o humano sabe.
 */
import { createHash } from "node:crypto";

import type { CustomFieldDef } from "@/lib/schemas/settings";

import {
  verificaEvidencia,
  type Analise,
  type EvidenciaVerificada,
  type MensagemDaJanela,
} from "./analise";
import type { Modo, SupervisorConfig } from "./config";

export type TipoDeAcao =
  | "move_stage"
  | "set_field"
  | "set_value"
  | "add_tag"
  | "remove_tag"
  | "create_task"
  | "start_followup"
  | "update_qualification"
  | "record_signals"
  | "mark_won"
  | "mark_lost"
  | "resolve_lead";

export type Risco = "baixo" | "condicional" | "critico";
export type StatusPlanejado = "applied" | "pending_approval" | "skipped";

export interface EvidenciaGravada {
  message_id: string;
  ref: string;
  quem: MensagemDaJanela["quem"];
  trecho: string;
}

export interface AcaoPlanejada {
  kind: TipoDeAcao;
  risk: Risco;
  /** `applied` aqui = "pode aplicar"; o executor ainda pode terminar em failed/skipped. */
  status: StatusPlanejado;
  before: Record<string, unknown> | null;
  after: Record<string, unknown>;
  reason: string;
  evidence: EvidenciaGravada[];
  dedupKey: string;
}

export interface EtapaDoFunil {
  id: string;
  name: string;
  position: number;
  is_won: boolean;
  is_lost: boolean;
  is_archived: boolean;
  requires_human: boolean;
}

export interface ContextoDoNegocio {
  leadId: string;
  stageId: string;
  status: "open" | "won" | "lost";
  valueCents: number | null;
  customFields: Record<string, unknown>;
  tags: string[];
  etapas: EtapaDoFunil[];
  /** ref curta (e1, e2…) → id, como foi apresentada ao modelo. */
  refsDeEtapa: Record<string, string>;
  campos: CustomFieldDef[];
  motivosDePerda: string[];
  qualificacaoAtual: Record<string, string>;
  sinaisAnteriores: { commitments: string[]; objections: string[] } | null;
  tarefasAbertas: string[];
  contatoBloqueado: boolean;
  /** Quando um HUMANO mexeu pela última vez em cada coisa (null = nunca). */
  ultimaMudancaHumana: { etapa: string | null; campos: string | null };
  /** A última mensagem da janela — entra nas chaves que dependem de "agora". */
  ultimaMensagemId: string;
}

const hash = (s: string): string => createHash("sha256").update(s).digest("hex").slice(0, 16);

function statusPeloModo(modo: Modo, podeAutomatico: boolean): StatusPlanejado | null {
  if (modo === "desligado") return null;
  if (modo === "aprovacao") return "pending_approval";
  return podeAutomatico ? "applied" : "pending_approval";
}

function gravada(v: Extract<EvidenciaVerificada, { ok: true }>): EvidenciaGravada {
  return { message_id: v.messageId, ref: v.ref, quem: v.quem, trecho: v.trecho };
}

/** A evidência é mais nova que a última decisão humana sobre a mesma coisa? */
function evidenciaVenceHumano(
  janela: readonly MensagemDaJanela[],
  messageId: string,
  mudancaHumana: string | null,
): boolean {
  if (!mudancaHumana) return true;
  const msg = janela.find((m) => m.id === messageId);
  if (!msg) return false;
  return new Date(msg.enviadaEm).getTime() > new Date(mudancaHumana).getTime();
}

// ── Validação de valor de campo personalizado ─────────────────────────────────

export type ValorDeCampo = { ok: true; valor: unknown } | { ok: false; motivo: string };

/** Converte o texto citado para o tipo do campo — ou recusa. Nunca inventa. */
export function valorParaCampo(def: CustomFieldDef, bruto: string): ValorDeCampo {
  const v = bruto.trim();
  if (v === "") return { ok: false, motivo: "vazio" };
  switch (def.type) {
    case "number": {
      const n = Number(v.replace(/\./g, "").replace(",", "."));
      return Number.isFinite(n) ? { ok: true, valor: n } : { ok: false, motivo: "nao_numerico" };
    }
    case "date": {
      if (!/^\d{4}-\d{2}-\d{2}/.test(v)) return { ok: false, motivo: "data_invalida" };
      const d = new Date(v.slice(0, 10) + "T00:00:00Z");
      return Number.isNaN(d.getTime()) ? { ok: false, motivo: "data_invalida" } : { ok: true, valor: v.slice(0, 10) };
    }
    case "boolean": {
      const s = v.toLowerCase();
      if (["sim", "true", "yes", "si"].includes(s)) return { ok: true, valor: true };
      if (["não", "nao", "false", "no"].includes(s)) return { ok: true, valor: false };
      return { ok: false, motivo: "booleano_invalido" };
    }
    case "select": {
      const op = (def.options ?? []).find(
        (o) => o.value.toLowerCase() === v.toLowerCase() || o.label.toLowerCase() === v.toLowerCase(),
      );
      return op ? { ok: true, valor: op.value } : { ok: false, motivo: "opcao_inexistente" };
    }
    case "multiselect": {
      const partes = v.split(/[,;]/).map((p) => p.trim()).filter(Boolean);
      const valores: string[] = [];
      for (const p of partes) {
        const op = (def.options ?? []).find(
          (o) => o.value.toLowerCase() === p.toLowerCase() || o.label.toLowerCase() === p.toLowerCase(),
        );
        if (!op) return { ok: false, motivo: "opcao_inexistente" };
        valores.push(op.value);
      }
      return valores.length > 0 ? { ok: true, valor: valores } : { ok: false, motivo: "vazio" };
    }
    case "email":
      return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v) ? { ok: true, valor: v } : { ok: false, motivo: "email_invalido" };
    case "phone":
      return /^\+?[\d\s().-]{8,20}$/.test(v) ? { ok: true, valor: v } : { ok: false, motivo: "telefone_invalido" };
    case "url":
      return /^https?:\/\/\S+$/.test(v) ? { ok: true, valor: v } : { ok: false, motivo: "url_invalida" };
    default:
      return { ok: true, valor: v.slice(0, 300) };
  }
}

function vazio(v: unknown): boolean {
  return v === null || v === undefined || (typeof v === "string" && v.trim() === "") || (Array.isArray(v) && v.length === 0);
}

const normaliza = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");

// ── A política ─────────────────────────────────────────────────────────────────

export interface ResultadoDaPolitica {
  acoes: AcaoPlanejada[];
  /** Afirmações descartadas, para o rastro do run (nunca viram efeito). */
  descartes: Array<{ o_que: string; motivo: string }>;
}

export function decideAcoes(
  analise: Analise,
  janela: readonly MensagemDaJanela[],
  ctx: ContextoDoNegocio,
  config: SupervisorConfig,
  agora: Date,
): ResultadoDaPolitica {
  const acoes: AcaoPlanejada[] = [];
  const descartes: ResultadoDaPolitica["descartes"] = [];
  const a = config.autonomia;
  const L = ctx.leadId;

  if (ctx.status !== "open") {
    return { acoes, descartes: [{ o_que: "negocio", motivo: "negocio_fechado" }] };
  }
  if (!analise.informacao_suficiente) {
    return { acoes, descartes: [{ o_que: "janela", motivo: "informacao_insuficiente" }] };
  }

  const push = (acao: Omit<AcaoPlanejada, "status">, modo: Modo, podeAutomatico: boolean) => {
    const status = statusPeloModo(modo, podeAutomatico);
    if (status) acoes.push({ ...acao, status });
  };

  const atual = ctx.etapas.find((e) => e.id === ctx.stageId);

  // ── DESFECHO (crítico) ──────────────────────────────────────────────────────
  // Vem antes da etapa: se o fechamento é APLICADO nesta rodada, mover para
  // "Negociação" junto seria ruído. Mas fechamento só PROPOSTO (aguardando um
  // gestor) não pode travar o resto: um "ganho" alegado — inclusive por
  // injeção na conversa — congelaria o card até alguém decidir.
  let houveDesfecho = false;
  const d = analise.desfecho;
  if (d.tipo === "venda_comprovada" || d.tipo === "confirmacao_verbal") {
    const ev = verificaEvidencia(janela, d.evidencia);
    if (!ev.ok) {
      descartes.push({ o_que: "ganho", motivo: ev.motivo });
    } else {
      const provaBasta = d.tipo === "venda_comprovada" || config.ganho_exige === "confirmacao_verbal";
      push(
        {
          kind: "mark_won",
          risk: "critico",
          before: { status: ctx.status },
          after: { status: "won", nivel_de_prova: d.tipo },
          reason:
            d.tipo === "venda_comprovada"
              ? "Venda comprovada na conversa"
              : "Cliente confirmou a compra verbalmente (sem comprovante)",
          evidence: [gravada(ev)],
          dedupKey: `won:${L}:${ev.messageId}`,
        },
        a.ganho,
        provaBasta,
      );
      houveDesfecho = acoes.some((x) => x.kind === "mark_won" && x.status === "applied");
    }
  } else if (d.tipo === "perda_definitiva") {
    const ev = verificaEvidencia(janela, d.evidencia);
    if (!ev.ok) {
      descartes.push({ o_que: "perda", motivo: ev.motivo });
    } else {
      const motivo =
        d.motivo_da_perda && ctx.motivosDePerda.find((m) => normaliza(m) === normaliza(d.motivo_da_perda!));
      push(
        {
          kind: "mark_lost",
          risk: "critico",
          before: { status: ctx.status },
          after: { status: "lost", lost_reason: motivo ?? null },
          reason: motivo ? `Perda definitiva — motivo: ${motivo}` : "Perda definitiva — motivo a confirmar",
          evidence: [gravada(ev)],
          dedupKey: `lost:${L}:${ev.messageId}`,
        },
        a.perda,
        // Sem motivo do vocabulário do funil, perda NUNCA é automática: o banco
        // recusaria, e inventar um motivo gravaria uma causa que ninguém afirmou.
        Boolean(motivo),
      );
      houveDesfecho = acoes.some((x) => x.kind === "mark_lost" && x.status === "applied");
    }
  } else if (d.tipo !== "nenhum") {
    // intenção / promessa: sinal comercial, nunca fechamento.
    descartes.push({ o_que: "desfecho", motivo: `apenas_${d.tipo}` });
  }

  // ── ETAPA ───────────────────────────────────────────────────────────────────
  if (analise.etapa && !houveDesfecho) {
    const e = analise.etapa;
    const destinoId = ctx.refsDeEtapa[e.stage_ref.trim()];
    const destino = destinoId ? ctx.etapas.find((s) => s.id === destinoId) : undefined;
    const ev = verificaEvidencia(janela, e.evidencia);
    if (!destino || destino.is_archived) {
      descartes.push({ o_que: "etapa", motivo: "etapa_fora_do_funil" });
    } else if (destino.id === ctx.stageId) {
      // já está lá — nada a fazer
    } else if (!ev.ok) {
      descartes.push({ o_que: "etapa", motivo: ev.motivo });
    } else if (e.confianca === "baixa") {
      descartes.push({ o_que: "etapa", motivo: "confianca_baixa" });
    } else if (!evidenciaVenceHumano(janela, ev.messageId, ctx.ultimaMudancaHumana.etapa)) {
      descartes.push({ o_que: "etapa", motivo: "decisao_humana_mais_recente" });
    } else if (destino.is_won || destino.is_lost) {
      // Etapa que fecha o negócio só se alcança pelo desfecho (crítico), nunca
      // como "movimento comum": é o atalho que a política existe para fechar.
      descartes.push({ o_que: "etapa", motivo: "etapa_de_fechamento_exige_desfecho" });
    } else {
      const regra = config.etapas[destino.id];
      const paraFrente = atual ? destino.position > atual.position : true;
      const sensivel = destino.requires_human || !paraFrente || !regra || !regra.automatico;
      // MARCOS das etapas PULADAS: só as que ficam estritamente entre a etapa atual
      // e o destino, com o critério comprovado por citação literal. Viajam DENTRO do
      // movimento: se ele espera o gestor, os marcos esperam junto; se é recusado,
      // nenhum marco existe. Nunca etapa de fechamento, nunca movimento para trás.
      const marcos: Array<{ stage_id: string; stage_name: string; message_id: string; occurred_at: string }> = [];
      if (paraFrente && atual) {
        const vistos = new Set<string>();
        for (const m of analise.marcos ?? []) {
          const id = ctx.refsDeEtapa[m.stage_ref.trim()];
          const etapa = id ? ctx.etapas.find((s) => s.id === id) : undefined;
          if (!etapa || vistos.has(etapa.id)) continue;
          if (etapa.is_archived || etapa.is_won || etapa.is_lost) continue;
          if (!(etapa.position > atual.position && etapa.position < destino.position)) continue;
          const evm = verificaEvidencia(janela, m.evidencia);
          if (!evm.ok) {
            descartes.push({ o_que: `marco:${etapa.name}`, motivo: evm.motivo });
            continue;
          }
          const msg = janela.find((x) => x.id === evm.messageId);
          if (!msg) continue;
          vistos.add(etapa.id);
          marcos.push({ stage_id: etapa.id, stage_name: etapa.name, message_id: evm.messageId, occurred_at: msg.enviadaEm });
        }
        marcos.sort((x, y) => (ctx.etapas.find((s) => s.id === x.stage_id)?.position ?? 0) - (ctx.etapas.find((s) => s.id === y.stage_id)?.position ?? 0));
      }
      push(
        {
          kind: "move_stage",
          risk: sensivel ? "condicional" : "baixo",
          before: { stage_id: ctx.stageId, stage_name: atual?.name ?? null },
          after: marcos.length
            ? { stage_id: destino.id, stage_name: destino.name, marcos }
            : { stage_id: destino.id, stage_name: destino.name },
          reason:
            (e.motivo || `Movido para ${destino.name}`) +
            (marcos.length ? ` · marco${marcos.length > 1 ? "s" : ""} comprovado${marcos.length > 1 ? "s" : ""}: ${marcos.map((m) => m.stage_name).join(", ")}` : ""),
          evidence: [gravada(ev)],
          dedupKey: `stage:${L}:${ctx.stageId}>${destino.id}`,
        },
        a.mover_etapa,
        !sensivel && e.confianca === "alta",
      );
    }
  }

  // ── CAMPOS PERSONALIZADOS ───────────────────────────────────────────────────
  const permitidos = new Set(config.campos_permitidos);
  for (const c of analise.campos) {
    const def = ctx.campos.find((f) => f.key === c.key);
    if (!def || (permitidos.size > 0 && !permitidos.has(c.key))) {
      descartes.push({ o_que: `campo:${c.key}`, motivo: "campo_nao_permitido" });
      continue;
    }
    const ev = verificaEvidencia(janela, c.evidencia);
    if (!ev.ok) {
      descartes.push({ o_que: `campo:${c.key}`, motivo: ev.motivo });
      continue;
    }
    const conv = valorParaCampo(def, c.valor);
    if (!conv.ok) {
      descartes.push({ o_que: `campo:${c.key}`, motivo: conv.motivo });
      continue;
    }
    const anterior = ctx.customFields[c.key];
    if (JSON.stringify(anterior) === JSON.stringify(conv.valor)) continue;
    const sobrescreve = !vazio(anterior);
    if (sobrescreve && !evidenciaVenceHumano(janela, ev.messageId, ctx.ultimaMudancaHumana.campos)) {
      descartes.push({ o_que: `campo:${c.key}`, motivo: "decisao_humana_mais_recente" });
      continue;
    }
    push(
      {
        kind: "set_field",
        risk: sobrescreve ? "condicional" : "baixo",
        before: { key: c.key, valor: anterior ?? null },
        after: { key: c.key, valor: conv.valor, label: def.label },
        reason: sobrescreve ? `Atualiza ${def.label} (havia outro valor)` : `Preenche ${def.label}`,
        evidence: [gravada(ev)],
        dedupKey: `field:${L}:${c.key}:${hash(JSON.stringify(conv.valor))}`,
      },
      a.campos,
      !sobrescreve || config.autonomia.sobrescrever_campos,
    );
  }

  // ── VALOR DO NEGÓCIO (impacto financeiro → condicional) ─────────────────────
  if (analise.valor_do_negocio_centavos && analise.valor_do_negocio_centavos.valor !== ctx.valueCents) {
    const ev = verificaEvidencia(janela, analise.valor_do_negocio_centavos.evidencia);
    if (!ev.ok) descartes.push({ o_que: "valor", motivo: ev.motivo });
    else {
      const valor = analise.valor_do_negocio_centavos.valor;
      push(
        {
          kind: "set_value",
          risk: "condicional",
          before: { value_cents: ctx.valueCents },
          after: { value_cents: valor },
          reason: "Valor da negociação mencionado na conversa",
          evidence: [gravada(ev)],
          dedupKey: `value:${L}:${valor}`,
        },
        a.valor,
        true,
      );
    }
  }

  // ── TAGS ────────────────────────────────────────────────────────────────────
  const tagsDoLead = new Set(ctx.tags.map(normaliza));
  for (const t of analise.tags) {
    const lista = t.acao === "adicionar" ? config.tags_permitidas : config.tags_removiveis;
    const canonica = lista.find((x) => normaliza(x) === normaliza(t.tag));
    if (!canonica) {
      descartes.push({ o_que: `tag:${t.tag}`, motivo: "tag_nao_permitida" });
      continue;
    }
    const tem = tagsDoLead.has(normaliza(canonica));
    if ((t.acao === "adicionar" && tem) || (t.acao === "remover" && !tem)) continue;
    const ev = verificaEvidencia(janela, t.evidencia);
    if (!ev.ok) {
      descartes.push({ o_que: `tag:${t.tag}`, motivo: ev.motivo });
      continue;
    }
    push(
      {
        kind: t.acao === "adicionar" ? "add_tag" : "remove_tag",
        // Remover tem dependência operacional (automação lê tag), mas a lista de
        // removíveis é a autorização EXPLÍCITA da organização para isso.
        risk: t.acao === "adicionar" ? "baixo" : "condicional",
        before: { tags: ctx.tags },
        after: { tag: canonica },
        reason: t.acao === "adicionar" ? `Tag “${canonica}”` : `Remove a tag “${canonica}”`,
        evidence: [gravada(ev)],
        dedupKey: `tag:${L}:${t.acao}:${normaliza(canonica)}:${ev.messageId}`,
      },
      a.tags,
      true,
    );
  }

  // ── TAREFAS ─────────────────────────────────────────────────────────────────
  const abertas = new Set(ctx.tarefasAbertas.map(normaliza));
  let criouTarefa = false;
  for (const t of analise.tarefas) {
    const titulo = t.titulo.trim();
    if (titulo === "" || abertas.has(normaliza(titulo))) continue;
    const ev = verificaEvidencia(janela, t.evidencia);
    if (!ev.ok) {
      descartes.push({ o_que: "tarefa", motivo: ev.motivo });
      continue;
    }
    // Compromisso HISTÓRICO (já cumprido ou sem ação possível) não vira tarefa
    // pendente: a lista de pendências não é o diário da conversa.
    if (t.ainda_pendente === false) {
      descartes.push({ o_que: "tarefa", motivo: "compromisso_historico" });
      continue;
    }
    // Prazo só quando alguém combinou um momento E ele é uma data válida no
    // futuro próximo. Sem isso, "sem prazo" — inventar data envenena a lista
    // de atrasadas (ver o cabeçalho de crm_tasks no baseline).
    // Obrigação VENCIDA (o momento passou e ainda exige ação) mantém a data real —
    // é exatamente o que a lista de atrasadas existe para mostrar — mas só até 30
    // dias; data mais velha que isso é quase sempre leitura errada do histórico.
    let prazo: string | null = null;
    let vencida = false;
    if (t.prazo_iso) {
      const p = new Date(t.prazo_iso);
      const trintaDias = agora.getTime() - 30 * 24 * 3600 * 1000;
      const umAno = agora.getTime() + 366 * 24 * 3600 * 1000;
      if (!Number.isNaN(p.getTime()) && p.getTime() > trintaDias && p.getTime() < umAno) {
        prazo = p.toISOString();
        vencida = p.getTime() < agora.getTime();
      }
    }
    abertas.add(normaliza(titulo));
    criouTarefa = true;
    push(
      {
        kind: "create_task",
        risk: "baixo",
        before: null,
        after: { title: titulo, due_date: prazo },
        reason: vencida
          ? "Compromisso combinado na conversa e já vencido"
          : prazo
            ? "Compromisso combinado na conversa"
            : "Compromisso combinado na conversa (sem data definida)",
        evidence: [gravada(ev)],
        dedupKey: `task:${L}:${hash(normaliza(titulo))}`,
      },
      a.tarefas,
      true,
    );
  }

  // ── FOLLOW-UP ───────────────────────────────────────────────────────────────
  if (analise.precisa_follow_up.necessario && !criouTarefa && !houveDesfecho) {
    if (config.followup_pointer_id && !ctx.contatoBloqueado) {
      push(
        {
          kind: "start_followup",
          risk: "condicional",
          before: null,
          after: { pointer_id: config.followup_pointer_id },
          reason: analise.precisa_follow_up.motivo || "Negociação parada sem próximo passo",
          evidence: [],
          dedupKey: `followup:${L}:${config.followup_pointer_id}:${ctx.ultimaMensagemId}`,
        },
        a.followup,
        true,
      );
    } else {
      const titulo = "Fazer follow-up com o cliente";
      if (!abertas.has(normaliza(titulo))) {
        push(
          {
            kind: "create_task",
            risk: "baixo",
            before: null,
            after: { title: titulo, due_date: null, detalhe: analise.precisa_follow_up.motivo },
            reason: analise.precisa_follow_up.motivo || "Negociação sem próximo passo",
            evidence: [],
            dedupKey: `task:${L}:${hash(normaliza(titulo))}:${ctx.ultimaMensagemId}`,
          },
          a.tarefas,
          true,
        );
      }
    }
  }

  // ── QUALIFICAÇÃO (BANT) — alimenta o score existente ────────────────────────
  const novaQualificacao: Record<string, string> = {};
  const evQual: EvidenciaGravada[] = [];
  for (const chave of ["budget", "authority", "need", "timeline"] as const) {
    const item = analise.qualificacao[chave];
    if (!item) continue;
    const ev = verificaEvidencia(janela, item.evidencia);
    if (!ev.ok) {
      descartes.push({ o_que: `bant:${chave}`, motivo: ev.motivo });
      continue;
    }
    const anterior = ctx.qualificacaoAtual[chave];
    if (anterior && normaliza(anterior) === normaliza(item.valor)) continue;
    if (anterior && !config.autonomia.sobrescrever_campos) {
      descartes.push({ o_que: `bant:${chave}`, motivo: "ja_preenchido" });
      continue;
    }
    novaQualificacao[chave] = item.valor.trim().slice(0, 300);
    evQual.push(gravada(ev));
  }
  if (Object.keys(novaQualificacao).length > 0) {
    push(
      {
        kind: "update_qualification",
        risk: "baixo",
        before: { qualification: ctx.qualificacaoAtual },
        after: { qualification: novaQualificacao },
        reason: `Qualificação: ${Object.keys(novaQualificacao).join(", ")}`,
        evidence: evQual,
        dedupKey: `bant:${L}:${hash(JSON.stringify(novaQualificacao))}`,
      },
      a.qualificacao,
      true,
    );
  }

  // ── SINAIS DO SCORE (compromissos/objeções → lead_checkpoints) ──────────────
  const ant = ctx.sinaisAnteriores ?? { commitments: [], objections: [] };
  const evSinais: EvidenciaGravada[] = [];
  const compromissos = [...ant.commitments];
  for (const c of analise.compromissos) {
    const ev = verificaEvidencia(janela, c.evidencia);
    if (!ev.ok) continue;
    if (!compromissos.some((x) => normaliza(x) === normaliza(c.texto))) {
      compromissos.push(c.texto.trim());
      evSinais.push(gravada(ev));
    }
  }
  const objecoes: string[] = [];
  for (const o of analise.objecoes_em_aberto) {
    const ev = verificaEvidencia(janela, o.evidencia);
    const jaExistia = ant.objections.some((x) => normaliza(x) === normaliza(o.texto));
    if (ev.ok || jaExistia) {
      if (!objecoes.some((x) => normaliza(x) === normaliza(o.texto))) objecoes.push(o.texto.trim());
      if (ev.ok && !jaExistia) evSinais.push(gravada(ev));
    }
  }
  const mudou =
    JSON.stringify(compromissos.slice(-10)) !== JSON.stringify(ant.commitments) ||
    JSON.stringify(objecoes) !== JSON.stringify(ant.objections);
  if (mudou) {
    push(
      {
        kind: "record_signals",
        risk: "baixo",
        before: { commitments: ant.commitments, objections: ant.objections },
        after: {
          commitments: compromissos.slice(-10),
          objections: objecoes.slice(0, 6),
          next_action: analise.proxima_acao,
          rolling_summary: analise.resumo,
        },
        reason: "Compromissos e objeções da conversa",
        evidence: evSinais,
        dedupKey: `signals:${L}:${ctx.ultimaMensagemId}`,
      },
      a.qualificacao,
      true,
    );
  }

  return { acoes, descartes };
}
