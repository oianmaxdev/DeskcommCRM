/**
 * Um cliente Supabase EM MEMÓRIA, só com o subconjunto de query builder que o
 * Supervisor usa — para dirigir observador → política → executor de ponta a
 * ponta em teste, sem rede e sem Postgres.
 *
 * Não imita RLS (o Supervisor usa o admin client, que também não tem), mas
 * imita as duas constraints que o Supervisor DEPENDE para ser idempotente:
 * a janela única de `supervisor_runs` e o `dedup_key` de `supervisor_actions`.
 * Projeção de colunas é ignorada (devolve a linha inteira), exceto embeds.
 *
 * Só para teste. Não importe isto de código de produto.
 */
import { randomUUID } from "node:crypto";

type Linha = Record<string, unknown>;
type Filtro = (l: Linha) => boolean;

const UNICAS: Record<string, string[][]> = {
  supervisor_runs: [["organization_id", "conversation_id", "last_message_id"]],
  supervisor_actions: [["organization_id", "dedup_key"]],
  supervisor_settings: [["organization_id"]],
  lead_state: [["organization_id", "contact_id"]],
};

let seq = 0;

export class BancoEmMemoria {
  tabelas: Record<string, Linha[]> = {};
  rpcs: Array<{ nome: string; args: Record<string, unknown> }> = [];

  linhas(t: string): Linha[] {
    return (this.tabelas[t] ??= []);
  }

  from(t: string) {
    return new Consulta(this, t);
  }

  async rpc(nome: string, args: Record<string, unknown>) {
    this.rpcs.push({ nome, args });
    if (nome === "fn_supervisor_conversas_pendentes") return { data: this.pendentes(args), error: null };
    return { data: null, error: null };
  }

  /**
   * Espelho de `public.fn_supervisor_conversas_pendentes` (migration 5001):
   * MESMA regra, para os testes de unidade. A prova em Postgres real é
   * `tests/invariants/supervisor-fila-justa.test.ts`.
   */
  private pendentes(a: Record<string, unknown>) {
    const org = a.p_org as string;
    const desde = a.p_desde as string;
    const ate = a.p_ate as string;
    const reclamar = a.p_reclamar_antes as string;
    const limite = Math.max(1, Math.min(Number(a.p_limite ?? 20), 1000));
    const concluida = (r: Linha) =>
      r.status === "analyzed" || r.status === "ambiguous" || (r.status === "skipped" && (r.skip_reason ?? "") !== "em_processamento");
    const runs = this.linhas("supervisor_runs").filter((r) => r.organization_id === org);
    return this.linhas("conversations")
      .filter((c) => c.organization_id === org && c.is_group !== true)
      .filter((c) => String(c.last_message_at) >= desde && String(c.last_message_at) <= ate)
      .filter(
        (c) =>
          !runs.some(
            (r) =>
              r.conversation_id === c.id &&
              String(r.last_message_at) >= String(c.last_message_at) &&
              (concluida(r) || String(r.created_at) > reclamar),
          ),
      )
      .sort((x, y) => (String(x.last_message_at) < String(y.last_message_at) ? -1 : String(x.last_message_at) > String(y.last_message_at) ? 1 : String(x.id) < String(y.id) ? -1 : 1))
      .slice(0, limite)
      .map((c) => {
        const lidas = runs.filter((r) => r.conversation_id === c.id && concluida(r)).map((r) => String(r.last_message_at));
        return {
          id: c.id,
          contact_id: c.contact_id,
          assigned_to_user_id: c.assigned_to_user_id ?? null,
          status: c.status,
          last_message_at: c.last_message_at,
          cursor: lidas.length ? lidas.sort().at(-1)! : null,
        };
      });
  }

  violaUnica(t: string, nova: Linha, ignorarId?: unknown): boolean {
    for (const cols of UNICAS[t] ?? []) {
      if (this.linhas(t).some((l) => l.id !== ignorarId && cols.every((c) => l[c] === nova[c]))) return true;
    }
    return false;
  }
}

class Consulta implements PromiseLike<{ data: unknown; error: { message: string; code?: string } | null }> {
  private filtros: Filtro[] = [];
  private op: "select" | "insert" | "update" | "upsert" | "delete" = "select";
  private payload: Linha | Linha[] | null = null;
  private upsertOpts: { onConflict?: string; ignoreDuplicates?: boolean } = {};
  private ordem: Array<{ col: string; asc: boolean; nullsFirst?: boolean }> = [];
  private limite: number | null = null;
  private modo: "many" | "single" | "maybe" = "many";
  private projeta = false;

  constructor(
    private db: BancoEmMemoria,
    private t: string,
  ) {}

  select(_cols?: string) {
    if (this.op === "select") this.op = "select";
    else this.projeta = true;
    return this;
  }
  insert(p: Linha | Linha[]) {
    this.op = "insert";
    this.payload = p;
    return this;
  }
  update(p: Linha) {
    this.op = "update";
    this.payload = p;
    return this;
  }
  upsert(p: Linha | Linha[], o: { onConflict?: string; ignoreDuplicates?: boolean } = {}) {
    this.op = "upsert";
    this.payload = p;
    this.upsertOpts = o;
    return this;
  }
  delete() {
    this.op = "delete";
    return this;
  }
  eq(c: string, v: unknown) {
    this.filtros.push((l) => l[c] === v);
    return this;
  }
  neq(c: string, v: unknown) {
    this.filtros.push((l) => l[c] !== v);
    return this;
  }
  in(c: string, vs: unknown[]) {
    this.filtros.push((l) => vs.includes(l[c]));
    return this;
  }
  is(c: string, v: unknown) {
    this.filtros.push((l) => (l[c] ?? null) === v);
    return this;
  }
  not(c: string, _op: string, v: unknown) {
    this.filtros.push((l) => (l[c] ?? null) !== v);
    return this;
  }
  gt(c: string, v: string) {
    this.filtros.push((l) => String(l[c]) > v);
    return this;
  }
  gte(c: string, v: string) {
    this.filtros.push((l) => String(l[c]) >= v);
    return this;
  }
  lt(c: string, v: string) {
    this.filtros.push((l) => String(l[c]) < v);
    return this;
  }
  lte(c: string, v: string) {
    this.filtros.push((l) => String(l[c]) <= v);
    return this;
  }
  order(col: string, o: { ascending?: boolean; nullsFirst?: boolean } = {}) {
    this.ordem.push({ col, asc: o.ascending !== false, nullsFirst: o.nullsFirst });
    return this;
  }
  limit(n: number) {
    this.limite = n;
    return this;
  }
  maybeSingle() {
    this.modo = "maybe";
    return this;
  }
  single() {
    this.modo = "single";
    return this;
  }

  private alvo(): Linha[] {
    return this.db.linhas(this.t).filter((l) => this.filtros.every((f) => f(l)));
  }

  private executa(): { data: unknown; error: { message: string; code?: string } | null } {
    const tab = this.db.linhas(this.t);
    let out: Linha[] = [];
    if (this.op === "select") {
      out = this.alvo();
      for (const o of [...this.ordem].reverse()) {
        out = [...out].sort((a, b) => {
          const x = a[o.col] as string | number | null | undefined;
          const y = b[o.col] as string | number | null | undefined;
          const xn = x === null || x === undefined;
          const yn = y === null || y === undefined;
          if (xn || yn) {
            if (xn && yn) return 0;
            // Postgres: NULLS LAST no ascendente, salvo `nullsFirst`.
            const nulosPrimeiro = o.nullsFirst ?? !o.asc;
            return (xn ? -1 : 1) * (nulosPrimeiro ? 1 : -1);
          }
          return (x < y ? -1 : x > y ? 1 : 0) * (o.asc ? 1 : -1);
        });
      }
      if (this.limite !== null) out = out.slice(0, this.limite);
    } else if (this.op === "insert" || this.op === "upsert") {
      const novas: Linha[] = (Array.isArray(this.payload) ? this.payload : [this.payload!]).map((p) => ({
        id: randomUUID(),
        created_at: new Date(Date.now() + seq++).toISOString(),
        ...p,
      }));
      for (const n of novas) {
        if (this.db.violaUnica(this.t, n)) {
          if (this.op === "upsert" && this.upsertOpts.ignoreDuplicates) continue;
          if (this.op === "upsert") {
            const cols = (this.upsertOpts.onConflict ?? "").split(",");
            const ex = tab.find((l) => cols.every((c) => l[c] === n[c]))!;
            Object.assign(ex, { ...n, id: ex.id });
            out.push(ex);
            continue;
          }
          return { data: null, error: { message: "duplicate key value violates unique constraint", code: "23505" } };
        }
        if (this.t === "lead_checkpoints") n.seq = seq++;
        tab.push(n);
        out.push(n);
      }
    } else if (this.op === "update") {
      out = this.alvo();
      for (const l of out) Object.assign(l, this.payload);
    } else {
      out = this.alvo();
      this.db.tabelas[this.t] = tab.filter((l) => !out.includes(l));
    }
    if (this.modo === "single") {
      return out.length === 1 ? { data: { ...out[0] }, error: null } : { data: null, error: { message: `esperava 1 linha, veio ${out.length}` } };
    }
    if (this.modo === "maybe") return { data: out[0] ? { ...out[0] } : null, error: null };
    return { data: out.map((l) => ({ ...l })), error: null };
  }

  then<A, B>(ok?: ((v: { data: unknown; error: { message: string; code?: string } | null }) => A | PromiseLike<A>) | null, err?: ((e: unknown) => B | PromiseLike<B>) | null) {
    return Promise.resolve(this.executa()).then(ok, err);
  }
}
