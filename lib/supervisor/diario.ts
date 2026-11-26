/**
 * O DIÁRIO do Supervisor — como cada ação gravada vira uma linha legível.
 *
 * Puro e sem dado novo: lê as mesmas linhas de `supervisor_actions` que a
 * auditoria e a linha do tempo do negócio já refletem. Só entram ações
 * EFETIVAMENTE realizadas (`applied` = o Supervisor fez; `approved` = um gestor
 * aprovou e foi feito). Proposta aguardando aprovação fica na aba Pendências —
 * mostrá-la aqui seria contar como feito o que ninguém fez.
 */
export interface AcaoDoDiario {
  id: string;
  kind: string;
  status: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown>;
  reason: string;
  created_at: string;
  decided_at?: string | null;
  crm_leads: { title: string } | null;
}

export interface ItemDoDiario {
  id: string;
  /** "Moveu o negócio", "Criou uma tarefa"… */
  verbo: string;
  /** O que vem depois dos dois-pontos no título (nome do negócio, da tarefa…). */
  objeto: string;
  /** A mudança em si: "Qualificação → Proposta Enviada", "42% → 67% (Morno)". */
  detalhe: string | null;
  negocio: string | null;
  contexto: string;
  quando: string;
  aprovadaPorGestor: boolean;
}

const ROTULO_BANT: Record<string, string> = { need: "Necessidade", budget: "Orçamento", timeline: "Prazo", authority: "Quem decide" };
const FAIXA: Record<string, string> = { frio: "Frio", morno: "Morno", quente: "Quente" };

export function ehAcaoRealizada(status: string): boolean {
  return status === "applied" || status === "approved";
}

function dinheiro(centavos: unknown): string {
  return new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(Number(centavos ?? 0) / 100);
}

function valorDoCampo(v: unknown): string {
  if (Array.isArray(v)) return v.join(", ");
  if (typeof v === "boolean") return v ? "Sim" : "Não";
  return String(v ?? "");
}

/**
 * `tag` é a etiqueta BCP-47 do idioma de quem LÊ (`useTagDeIdioma()` na tela):
 * a data segue o leitor, como no resto do produto.
 */
export function dataHora(iso: string, fuso: string | null, tag: string, comData = true): string {
  const d = new Date(iso);
  let tz: string | undefined = fuso ?? undefined;
  try {
    if (tz) new Intl.DateTimeFormat(tag, { timeZone: tz });
  } catch {
    tz = undefined;
  }
  const hora = new Intl.DateTimeFormat(tag, { timeZone: tz, hour: "2-digit", minute: "2-digit", hour12: false }).format(d).replace(":", "h");
  if (!comData) return hora;
  const data = new Intl.DateTimeFormat(tag, { timeZone: tz, day: "2-digit", month: "2-digit", year: "numeric" }).format(d);
  return `${data} às ${hora}`;
}

/** Uma ação pode render DUAS linhas: a ação e a atualização de score que ela causou. */
export function itensDaAcao(a: AcaoDoDiario, fuso: string | null, tag: string): ItemDoDiario[] {
  const negocio = a.crm_leads?.title ?? null;
  const d = a.after ?? {};
  const quando = a.status === "approved" && a.decided_at ? a.decided_at : a.created_at;
  const base = { negocio, contexto: a.reason, quando, aprovadaPorGestor: a.status === "approved" };
  const itens: ItemDoDiario[] = [];
  const add = (verbo: string, objeto: string, detalhe: string | null, sufixo = "") =>
    itens.push({ id: `${a.id}${sufixo}`, verbo, objeto, detalhe, ...base });

  switch (a.kind) {
    case "move_stage":
      add("Moveu o negócio", negocio ?? "", `${String(a.before?.stage_name ?? "?")} → ${String(d.stage_name ?? "?")}`);
      break;
    case "create_task":
      add("Criou uma tarefa", String(d.title ?? ""), d.due_date ? `Prazo: ${dataHora(String(d.due_date), fuso, tag)}` : "Sem prazo definido");
      break;
    case "set_field":
      add(`Preencheu o campo ${String(d.label ?? d.key ?? "")}`, negocio ?? "", valorDoCampo(d.valor));
      break;
    case "set_value":
      add("Registrou o valor do negócio", negocio ?? "", dinheiro(d.value_cents));
      break;
    case "add_tag":
      add("Adicionou a tag", String(d.tag ?? ""), null);
      break;
    case "remove_tag":
      add("Removeu a tag", String(d.tag ?? ""), null);
      break;
    case "update_qualification":
      add(
        "Atualizou a qualificação",
        negocio ?? "",
        Object.entries((d.qualification ?? {}) as Record<string, string>)
          .map(([k, v]) => `${ROTULO_BANT[k] ?? k}: ${v}`)
          .join(" · ") || null,
      );
      break;
    case "record_signals": {
      const c = ((d.commitments as string[] | undefined) ?? []).length;
      const o = ((d.objections as string[] | undefined) ?? []).length;
      const partes = [c ? `${c} ${c === 1 ? "compromisso do cliente" : "compromissos do cliente"}` : "", o ? `${o} ${o === 1 ? "objeção em aberto" : "objeções em aberto"}` : ""].filter(Boolean);
      add("Registrou os sinais da conversa", negocio ?? "", partes.join(" · ") || null);
      break;
    }
    case "start_followup":
      add("Iniciou um follow-up", negocio ?? "", null);
      break;
    case "mark_won":
      add("Registrou a venda", negocio ?? "", null);
      break;
    case "mark_lost":
      add("Registrou a perda", negocio ?? "", d.lost_reason ? `Motivo: ${String(d.lost_reason)}` : null);
      break;
    case "resolve_lead":
      // escolha humana de qual negócio é a conversa: não é ação do Supervisor
      return [];
    default:
      add("Atualizou o negócio", negocio ?? "", null);
  }

  const s = d.score as { de: number | null; para: number; faixa: string | null } | undefined;
  if (s && typeof s.para === "number") {
    itens.push({
      id: `${a.id}:score`,
      verbo: "Atualizou o score",
      objeto: negocio ?? "",
      detalhe: `${s.de === null ? "sem score" : `${s.de}%`} → ${s.para}%${s.faixa ? ` (${FAIXA[s.faixa] ?? s.faixa})` : ""}`,
      ...base,
      contexto: "A conversa trouxe novos sinais de compromisso, objeção ou qualificação.",
    });
  }
  return itens;
}

export interface DiaDoDiario<A extends AcaoDoDiario = AcaoDoDiario> {
  /** "2026-11-16" no fuso da organização — a chave do agrupamento. */
  dia: string;
  rotulo: string;
  itens: Array<ItemDoDiario & { acao: A }>;
}

/** Ações realizadas, mais recentes primeiro, agrupadas pelo dia LOCAL da organização. */
export function montaDiario<A extends AcaoDoDiario>(
  acoes: readonly A[],
  fuso: string | null,
  tag: string,
  agora = new Date(),
): DiaDoDiario<A>[] {
  let tz: string | undefined = fuso ?? undefined;
  try {
    if (tz) new Intl.DateTimeFormat(tag, { timeZone: tz });
  } catch {
    tz = undefined;
  }
  const chave = (iso: string) => new Intl.DateTimeFormat("sv-SE", { timeZone: tz, dateStyle: "short" }).format(new Date(iso));
  const hoje = chave(agora.toISOString());
  const ontem = chave(new Date(agora.getTime() - 24 * 3600 * 1000).toISOString());
  const todos = acoes
    .filter((a) => ehAcaoRealizada(a.status))
    .flatMap((a) => itensDaAcao(a, fuso, tag).map((i) => ({ ...i, acao: a })))
    .sort((x, y) => y.quando.localeCompare(x.quando));
  const dias: DiaDoDiario<A>[] = [];
  for (const item of todos) {
    const dia = chave(item.quando);
    let g = dias[dias.length - 1];
    if (!g || g.dia !== dia) {
      const longo = new Intl.DateTimeFormat(tag, { timeZone: tz, weekday: "long", day: "numeric", month: "long" }).format(new Date(item.quando));
      g = { dia, rotulo: dia === hoje ? `Hoje — ${longo}` : dia === ontem ? `Ontem — ${longo}` : longo.charAt(0).toUpperCase() + longo.slice(1), itens: [] };
      dias.push(g);
    }
    g.itens.push(item);
  }
  return dias;
}
