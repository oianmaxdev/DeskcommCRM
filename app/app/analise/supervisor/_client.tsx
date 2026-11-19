"use client";

import Link from "next/link";
import { useTagDeIdioma } from "@/hooks/i18n/useLocaleDeData";
import type { ModeloDoSupervisor } from "@/lib/supervisor/escolha-de-modelo";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { useT } from "@/hooks/i18n/useT";
import { useTeamMembers } from "@/hooks/team/useTeamMembers";
import { apiClient } from "@/lib/api/client";
import type { Autonomia, Modo, SupervisorConfig } from "@/lib/supervisor/config";
import { rotuloDoCriterio } from "@/lib/supervisor/config";
import { dataHora, montaDiario } from "@/lib/supervisor/diario";
import { ROTULO_DO_PROBLEMA } from "@/lib/supervisor/metricas";
import {
  AUTOR_DA_MENSAGEM,
  avisoDeIncompleto,
  BASE_DA_AVALIACAO,
  falhasPorCategoria,
  limparDiagnostico,
  notaDosDenominadores,
  type CasoDoRelatorio,
  type RelatorioGravado,
} from "@/lib/supervisor/relatorio-tipos";

interface Funil {
  id: string;
  name: string;
  motivos: string[];
}
interface Etapa {
  id: string;
  pipeline_id: string;
  name: string;
  position: number;
  is_won: boolean;
  is_lost: boolean;
  requires_human: boolean;
}
interface Evidencia {
  ref: string;
  quem: string;
  trecho: string;
}
interface Acao {
  id: string;
  lead_id: string | null;
  conversation_id: string | null;
  kind: string;
  risk: "baixo" | "condicional" | "critico";
  status: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown>;
  reason: string;
  evidence: Evidencia[];
  result_detail: string | null;
  decided_at?: string | null;
  created_at: string;
  crm_leads: { title: string; pipeline_id: string } | null;
}

const ROTULO_DA_ACAO: Record<string, string> = {
  move_stage: "Etapa",
  set_field: "Campo",
  set_value: "Valor do negócio",
  add_tag: "Tag adicionada",
  remove_tag: "Tag removida",
  create_task: "Tarefa",
  start_followup: "Follow-up",
  update_qualification: "Qualificação",
  record_signals: "Sinais do score",
  mark_won: "Ganho",
  mark_lost: "Perda",
  resolve_lead: "Qual negócio?",
};
const ROTULO_DO_STATUS: Record<string, string> = {
  applied: "Aplicada",
  approved: "Aprovada",
  pending_approval: "Aguardando aprovação",
  rejected: "Recusada",
  skipped: "Não aplicada",
  failed: "Falhou",
  superseded: "Substituída",
};
const ROTULO_DO_RISCO: Record<string, string> = { baixo: "Baixo risco", condicional: "Condicional", critico: "Crítica" };

function quando(iso: string): string {
  return new Date(iso).toLocaleString();
}

function descricao(a: Acao): string {
  const d = a.after;
  switch (a.kind) {
    case "move_stage":
      return `${String(a.before?.stage_name ?? "?")} → ${String(d.stage_name ?? "?")}`;
    case "set_field":
      return `${String(d.label ?? d.key)}: ${JSON.stringify(d.valor)}`;
    case "set_value":
      return `${(Number(d.value_cents ?? 0) / 100).toFixed(2)}`;
    case "add_tag":
    case "remove_tag":
      return String(d.tag ?? "");
    case "create_task":
      return `${String(d.title ?? "")}${d.due_date ? ` — ${quando(String(d.due_date))}` : ""}`;
    case "update_qualification":
      return Object.entries((d.qualification ?? {}) as Record<string, string>)
        .map(([k, v]) => `${k}: ${v}`)
        .join(" · ");
    case "record_signals":
      return `${((d.commitments as string[]) ?? []).length} compromisso(s), ${((d.objections as string[]) ?? []).length} objeção(ões)`;
    default:
      return "";
  }
}

function LinhaDeAcao({ a, extra }: { a: Acao; extra?: React.ReactNode }) {
  const t = useT();
  return (
    <li className="rounded-md border p-3 text-sm" data-testid="supervisor-acao">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="secondary">{t(ROTULO_DA_ACAO[a.kind] ?? a.kind)}</Badge>
        <Badge variant={a.risk === "critico" ? "destructive" : "outline"}>{t(ROTULO_DO_RISCO[a.risk] ?? a.risk)}</Badge>
        <span className="font-medium">{a.crm_leads?.title ?? "—"}</span>
        <span className="text-muted-foreground">{descricao(a)}</span>
        <span className="ml-auto text-xs text-muted-foreground">
          {t(ROTULO_DO_STATUS[a.status] ?? a.status)}
          {a.result_detail && a.status !== "applied" ? ` (${a.result_detail})` : ""} · {quando(a.created_at)}
        </span>
      </div>
      <p className="mt-1 text-muted-foreground">{a.reason}</p>
      {a.evidence.length > 0 && (
        <ul className="mt-1 space-y-0.5">
          {a.evidence.map((e, i) => (
            <li key={i} className="text-xs italic text-muted-foreground">
              {e.quem === "cliente" ? t("Cliente") : t("Vendedor")}: “{e.trecho}”
            </li>
          ))}
        </ul>
      )}
      {extra}
    </li>
  );
}

function useAcoes(status?: string) {
  return useQuery({
    queryKey: ["supervisor", "acoes", status ?? "todas"],
    queryFn: () =>
      apiClient.get<{ data: { actions: Acao[] } }>(`/api/v1/supervisor/actions${status ? `?status=${status}` : ""}`),
  });
}

function Atividade({ fuso }: { fuso: string | null }) {
  const tag = useTagDeIdioma();
  const t = useT();
  const q = useAcoes();
  const dias = montaDiario(q.data?.data.actions ?? [], fuso, tag);
  if (q.isLoading) return <p className="text-sm text-muted-foreground">{t("Carregando…")}</p>;
  if (dias.length === 0)
    return <p className="text-sm text-muted-foreground">{t("O Supervisor ainda não fez nada. Ligue-o e escolha os funis na aba Configuração.")}</p>;
  return (
    <div className="max-w-3xl space-y-6" data-testid="supervisor-diario">
      {dias.map((dia) => (
        <section key={dia.dia} aria-label={dia.rotulo}>
          <h2 className="mb-2 text-sm font-semibold text-muted-foreground" data-testid="supervisor-dia">
            {dia.rotulo}
          </h2>
          <ol className="space-y-0 border-l pl-4">
            {dia.itens.map((item) => (
              <li key={item.id} className="relative pb-5 last:pb-0" data-testid="supervisor-acao">
                <span aria-hidden className="absolute -left-[21px] top-1.5 h-2.5 w-2.5 rounded-full border bg-background" />
                <p className="text-sm">
                  <span className="font-semibold">
                    {t(item.verbo)}
                    {item.objeto ? `: ${item.objeto}` : ""}
                  </span>{" "}
                  <span className="text-muted-foreground">— {dataHora(item.quando, fuso, tag)}</span>
                  {item.aprovadaPorGestor && (
                    <Badge variant="outline" className="ml-2 align-middle">
                      {t("aprovada por um gestor")}
                    </Badge>
                  )}
                </p>
                {item.negocio && item.negocio !== item.objeto && (
                  <p className="text-sm text-muted-foreground">
                    {t("Negócio")}: {item.negocio}
                  </p>
                )}
                {item.detalhe && <p className="text-sm">{item.detalhe}</p>}
                <p className="text-sm text-muted-foreground">
                  {t("Contexto")}: {item.contexto}
                </p>
                {(item.acao.lead_id || item.acao.conversation_id) && (
                  <p className="mt-1 flex flex-wrap gap-x-4 text-sm" data-testid="supervisor-acao-links">
                    {item.acao.lead_id && item.acao.crm_leads?.pipeline_id && (
                      <Link
                        className="underline underline-offset-2"
                        href={`/app/pipelines/${item.acao.crm_leads.pipeline_id}?lead=${item.acao.lead_id}`}
                      >
                        {t("Abrir o card do negócio")}
                      </Link>
                    )}
                    {item.acao.conversation_id && (
                      <Link className="underline underline-offset-2" href={`/app/inbox?id=${item.acao.conversation_id}`}>
                        {t("Abrir a conversa no Inbox")}
                      </Link>
                    )}
                  </p>
                )}
                <details className="mt-1 text-xs text-muted-foreground">
                  <summary className="cursor-pointer select-none">{t("Ver evidências e detalhes")}</summary>
                  <div className="mt-1 space-y-0.5 rounded-md bg-muted/50 p-2">
                    {item.acao.evidence.length === 0 && <p>{t("Sem trecho de conversa associado a esta ação.")}</p>}
                    {item.acao.evidence.map((e, k) => (
                      <p key={k} className="italic">
                        {e.quem === "cliente" ? t("Cliente") : t("Vendedor")}: “{e.trecho}”
                      </p>
                    ))}
                    <p>
                      {t(ROTULO_DA_ACAO[item.acao.kind] ?? item.acao.kind)} · {t(ROTULO_DO_RISCO[item.acao.risk] ?? item.acao.risk)} ·{" "}
                      {t(ROTULO_DO_STATUS[item.acao.status] ?? item.acao.status)}
                    </p>
                  </div>
                </details>
              </li>
            ))}
          </ol>
        </section>
      ))}
    </div>
  );
}

function Pendencias({ funis }: { funis: Funil[] }) {
  const t = useT();
  const qc = useQueryClient();
  const q = useAcoes("pending_approval");
  const [erro, setErro] = useState<string | null>(null);
  const [motivo, setMotivo] = useState<Record<string, string>>({});
  const [lead, setLead] = useState<Record<string, string>>({});

  async function decidir(a: Acao, decisao: "aprovar" | "recusar") {
    setErro(null);
    try {
      const r = await apiClient.post<{ data: { status: string; detalhe?: string | null } }>(
        `/api/v1/supervisor/actions/${a.id}`,
        { decisao, lost_reason: motivo[a.id] || undefined, lead_id: lead[a.id] || undefined },
      );
      if (r.data.detalhe) setErro(`${t("A ação não foi aplicada")}: ${r.data.detalhe}`);
    } catch (e) {
      setErro(e instanceof Error ? e.message : String(e));
    }
    await qc.invalidateQueries({ queryKey: ["supervisor"] });
  }

  const acoes = q.data?.data.actions ?? [];
  if (q.isLoading) return <p className="text-sm text-muted-foreground">{t("Carregando…")}</p>;
  return (
    <div className="space-y-2">
      {erro && <p className="text-sm text-destructive">{erro}</p>}
      {acoes.length === 0 && <p className="text-sm text-muted-foreground">{t("Nada aguardando aprovação.")}</p>}
      <ul className="space-y-2">
        {acoes.map((a) => {
          const motivos = funis.find((f) => f.id === a.crm_leads?.pipeline_id)?.motivos ?? [];
          const candidatos = (a.after.candidatos as Array<{ lead_id: string; titulo: string; funil: string }> | undefined) ?? [];
          return (
            <LinhaDeAcao
              key={a.id}
              a={a}
              extra={
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  {a.kind === "mark_lost" && (
                    <select
                      aria-label={t("Motivo da perda")}
                      className="h-8 rounded-md border bg-background px-2 text-sm"
                      value={motivo[a.id] ?? String(a.after.lost_reason ?? "")}
                      onChange={(e) => setMotivo({ ...motivo, [a.id]: e.target.value })}
                    >
                      <option value="">{t("Motivo da perda…")}</option>
                      {motivos.map((m) => (
                        <option key={m} value={m}>
                          {m}
                        </option>
                      ))}
                    </select>
                  )}
                  {a.kind === "resolve_lead" && (
                    <select
                      aria-label={t("Negócio")}
                      className="h-8 rounded-md border bg-background px-2 text-sm"
                      value={lead[a.id] ?? ""}
                      onChange={(e) => setLead({ ...lead, [a.id]: e.target.value })}
                    >
                      <option value="">{t("Qual negócio é esta conversa?")}</option>
                      {candidatos.map((c) => (
                        <option key={c.lead_id} value={c.lead_id}>
                          {c.titulo} ({c.funil})
                        </option>
                      ))}
                    </select>
                  )}
                  <Button size="sm" onClick={() => decidir(a, "aprovar")}>
                    {t("Aprovar")}
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => decidir(a, "recusar")}>
                    {t("Recusar")}
                  </Button>
                </div>
              }
            />
          );
        })}
      </ul>
    </div>
  );
}

type Relatorio = RelatorioGravado;

function BalaoDeConversa({ m, fuso }: { m: CasoDoRelatorio["evidencias"][number]; fuso: string | null }) {
  const tag = useTagDeIdioma();
  const t = useT();
  const doCliente = m.quem === "cliente";
  return (
    <div className={`flex ${doCliente ? "justify-start" : "justify-end"}`}>
      <div className={`max-w-[80%] rounded-lg px-3 py-1.5 text-sm ${doCliente ? "bg-muted" : "bg-primary/10"}`}>
        <p className="text-[11px] text-muted-foreground">
          {t(AUTOR_DA_MENSAGEM[m.quem])} · {dataHora(m.em, fuso, tag)}
          {m.transcricao ? ` · ${t("áudio transcrito")}` : ""}
        </p>
        <p className="whitespace-pre-line">{m.texto}</p>
      </div>
    </div>
  );
}

function Sugestao({ rotulo, texto }: { rotulo: string; texto: string }) {
  return (
    <div className="rounded-md border-l-4 border-primary/60 bg-muted/60 px-3 py-2 text-sm">
      <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{rotulo}</p>
      <p>“{texto}”</p>
    </div>
  );
}

function EstudoDeCaso({ caso, n, fuso }: { caso: CasoDoRelatorio; n: number; fuso: string | null }) {
  const t = useT();
  return (
    <Card data-testid="supervisor-caso">
      <CardHeader>
        <p className="text-xs uppercase tracking-wide text-muted-foreground">
          {t("Estudo de caso")} {n} · {caso.tipo === "boa_pratica" ? t("Boa condução") : t("Oportunidade de melhoria")}
        </p>
        <CardTitle className="text-lg">{caso.titulo}</CardTitle>
        {caso.situacao && (
          <p className="text-sm text-muted-foreground">
            {caso.situacao}
            {caso.estagio && !caso.situacao.includes(caso.estagio) ? ` — ${caso.estagio}` : ""}
          </p>
        )}
      </CardHeader>
      <CardContent className="space-y-4 text-sm">
        <p>{caso.contexto}</p>
        {caso.evidencias.length > 0 && (
          <section>
            <h4 className="mb-1 font-semibold">{t("Evidências do atendimento")}</h4>
            <div className="space-y-1.5 rounded-md border p-3">
              {caso.evidencias.map((m, i) => (
                <BalaoDeConversa key={i} m={m} fuso={fuso} />
              ))}
            </div>
          </section>
        )}
        {caso.positivos.length > 0 && (
          <section>
            <h4 className="mb-1 font-semibold">{t("O que foi positivo")}</h4>
            <ul className="list-disc space-y-0.5 pl-5">
              {caso.positivos.map((p, i) => (
                <li key={i}>{p}</li>
              ))}
            </ul>
          </section>
        )}
        {caso.faltou.length > 0 && (
          <section>
            <h4 className="mb-1 font-semibold">{t("O que faltou no atendimento")}</h4>
            <ul className="list-disc space-y-0.5 pl-5">
              {caso.faltou.map((f, i) => (
                <li key={i}>
                  <b>{f.titulo}:</b> {f.explicacao}
                </li>
              ))}
            </ul>
          </section>
        )}
        {(caso.como_melhorar.length > 0 || caso.follow_up_sugerido) && (
          <section className="space-y-2">
            <h4 className="font-semibold">{t("Como poderia ter sido melhor")}</h4>
            {caso.como_melhorar.map((m, i) => (
              <div key={i} className="space-y-1">
                <p>{m.quando}</p>
                <Sugestao rotulo={t("Sugestão de abordagem — não foi enviada")} texto={m.exemplo_de_mensagem} />
              </div>
            ))}
            {caso.follow_up_sugerido && (
              <div className="space-y-1">
                <p>{t("Sugestão de follow-up, caso o cliente não responda:")}</p>
                <Sugestao rotulo={t("Sugestão de follow-up — não foi enviada")} texto={caso.follow_up_sugerido} />
              </div>
            )}
          </section>
        )}
        <section>
          <h4 className="mb-1 font-semibold">{t("Resumo da análise")}</h4>
          <p>{caso.resumo}</p>
          {caso.outros_achados.length > 0 && (
            <p className="mt-1 text-muted-foreground">
              {t("Outros achados neste atendimento")}: {caso.outros_achados.join("; ")}.
            </p>
          )}
          {caso.limitacao && (
            <p className="mt-1 text-muted-foreground">
              {t("Limitação")}: {caso.limitacao}
            </p>
          )}
        </section>
        {caso.recorrencia?.frase && (
          <p className="rounded-md bg-amber-100 px-3 py-2 font-medium text-amber-900" data-testid="supervisor-recorrencia">
            {t("Recorrência identificada")}: {caso.recorrencia.frase}
          </p>
        )}
      </CardContent>
    </Card>
  );
}

function Diagnostico({ fuso }: { fuso: string | null }) {
  const tag = useTagDeIdioma();
  const t = useT();
  const qc = useQueryClient();
  const equipe = useTeamMembers();
  const [periodo, setPeriodo] = useState<"hoje" | "7d" | "15d" | "30d" | "custom">("7d");
  const [de, setDe] = useState("");
  const [ate, setAte] = useState("");
  const [vendedor, setVendedor] = useState("");
  const [gerando, setGerando] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  const [aberto, setAberto] = useState<string | null>(null);
  const [casoAberto, setCasoAberto] = useState(0);
  const [anonimo, setAnonimo] = useState(false);
  const q = useQuery({
    queryKey: ["supervisor", "relatorios"],
    queryFn: () => apiClient.get<{ data: { reports: Relatorio[] } }>("/api/v1/supervisor/reports"),
  });
  const relatorios = q.data?.data.reports ?? [];
  const atual = relatorios.find((r) => r.id === aberto) ?? relatorios[0];

  async function gerar() {
    setGerando(true);
    setErro(null);
    try {
      const r = await apiClient.post<{ data: { id: string } }>("/api/v1/supervisor/reports", {
        periodo,
        de: periodo === "custom" && de ? new Date(de).toISOString() : undefined,
        ate: periodo === "custom" && ate ? new Date(ate).toISOString() : undefined,
        owner_user_id: vendedor || null,
      });
      setAberto(r.data.id);
      setCasoAberto(0);
      await qc.invalidateQueries({ queryKey: ["supervisor", "relatorios"] });
    } catch (e) {
      setErro(e instanceof Error ? e.message : String(e));
    } finally {
      setGerando(false);
    }
  }

  const ag = atual?.metrics.agregado;
  const dg = atual?.diagnosis ? limparDiagnostico(atual.diagnosis) : atual?.diagnosis;
  const falhas = atual ? falhasPorCategoria(atual) : [];
  const casos = (dg?.casos ?? []).slice(0, 5);
  const caso = casos[Math.min(casoAberto, Math.max(casos.length - 1, 0))];
  const rotulo = (id: string) => atual?.metrics.rotulos_dos_criterios?.[id] ?? rotuloDoCriterio(id);
  const base = dg?.contexto?.base ?? (ag?.criterios_formais ? "script" : "geral");
  const pdf = (modo: "detalhado" | "resumo") => `/api/v1/supervisor/reports/${atual?.id}/pdf?modo=${modo}&anonimo=${anonimo ? 1 : 0}`;

  return (
    <div className="space-y-4">
      <Card>
        <CardContent className="flex flex-wrap items-end gap-3 pt-6">
          <div className="space-y-1">
            <Label htmlFor="sup-periodo">{t("Período")}</Label>
            <select id="sup-periodo" className="h-9 rounded-md border bg-background px-2 text-sm" value={periodo} onChange={(e) => setPeriodo(e.target.value as typeof periodo)}>
              <option value="hoje">{t("Hoje")}</option>
              <option value="7d">{t("Últimos 7 dias")}</option>
              <option value="15d">{t("Últimos 15 dias")}</option>
              <option value="30d">{t("Últimos 30 dias")}</option>
              <option value="custom">{t("Intervalo personalizado")}</option>
            </select>
          </div>
          {periodo === "custom" && (
            <>
              <div className="space-y-1">
                <Label htmlFor="sup-de">{t("De")}</Label>
                <Input id="sup-de" type="date" value={de} onChange={(e) => setDe(e.target.value)} />
              </div>
              <div className="space-y-1">
                <Label htmlFor="sup-ate">{t("Até")}</Label>
                <Input id="sup-ate" type="date" value={ate} onChange={(e) => setAte(e.target.value)} />
              </div>
            </>
          )}
          <div className="space-y-1">
            <Label htmlFor="sup-vendedor">{t("Vendedor")}</Label>
            <select id="sup-vendedor" className="h-9 rounded-md border bg-background px-2 text-sm" value={vendedor} onChange={(e) => setVendedor(e.target.value)}>
              <option value="">{t("Toda a equipe")}</option>
              {(equipe.data?.data ?? []).map((m) => (
                <option key={m.user_id} value={m.user_id}>
                  {m.full_name || m.email || m.user_id.slice(0, 8)}
                </option>
              ))}
            </select>
          </div>
          <Button onClick={gerar} disabled={gerando}>
            {gerando ? t("Analisando…") : t("Gerar diagnóstico")}
          </Button>
          {relatorios.length > 1 && (
            <select
              aria-label={t("Diagnósticos anteriores")}
              className="ml-auto h-9 rounded-md border bg-background px-2 text-sm"
              value={atual?.id ?? ""}
              onChange={(e) => {
                setAberto(e.target.value);
                setCasoAberto(0);
              }}
            >
              {relatorios.map((r) => (
                <option key={r.id} value={r.id}>
                  {dataHora(r.created_at, fuso, tag)} {r.recurring ? `(${t("recorrente")})` : ""}
                </option>
              ))}
            </select>
          )}
        </CardContent>
      </Card>
      {erro && <p className="text-sm text-destructive">{erro}</p>}
      {!atual && <p className="text-sm text-muted-foreground">{t("Nenhum diagnóstico ainda. Escolha o período e gere o primeiro.")}</p>}
      {atual && (
        <div className="space-y-4" data-testid="supervisor-diagnostico">
          <div className="flex flex-wrap items-center gap-3">
            <p className="text-sm text-muted-foreground">
              {dataHora(atual.period_from, fuso, tag)} → {dataHora(atual.period_to, fuso, tag)} · {t("Atendimentos elegíveis")}: <b>{atual.conversations_eligible}</b> ·{" "}
              {t("Analisados pelo Supervisor")}: <b>{atual.conversations_analyzed}</b>
            </p>
            <div className="ml-auto flex flex-wrap items-center gap-2">
              <label className="flex items-center gap-1 text-xs text-muted-foreground">
                <input type="checkbox" checked={anonimo} onChange={(e) => setAnonimo(e.target.checked)} />
                {t("Sem identificar os negócios")}
              </label>
              <Button asChild variant="outline" size="sm">
                <a href={pdf("resumo")} download data-testid="supervisor-pdf-resumo">
                  {t("Resumo em PDF")}
                </a>
              </Button>
              <Button asChild size="sm">
                <a href={pdf("detalhado")} download data-testid="supervisor-pdf">
                  {t("Baixar PDF")}
                </a>
              </Button>
            </div>
          </div>
          <p className="text-xs text-muted-foreground">
            {t("Base da avaliação")}: {t(BASE_DA_AVALIACAO[base])}
            {dg?.contexto?.nicho ? ` · ${t("Ramo informado")}: ${dg.contexto.nicho}` : ""}
          </p>
          {avisoDeIncompleto(atual) && (
            <div role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm" data-testid="supervisor-incompleto">
              {t(avisoDeIncompleto(atual)!)}
            </div>
          )}
          {dg?.resumo_executivo && (
            <Card>
              <CardHeader>
                <CardTitle>{t("Resumo")}</CardTitle>
              </CardHeader>
              <CardContent className="whitespace-pre-line text-sm">{dg.resumo_executivo}</CardContent>
            </Card>
          )}
          {(falhas.length > 0 || (ag?.aderencia.length ?? 0) > 0) && (
            <div className="grid gap-3 md:grid-cols-2">
              <Card>
                <CardHeader>
                  <CardTitle className="text-base">{t("Falhas recorrentes")}</CardTitle>
                </CardHeader>
                <CardContent>
                  <table className="w-full text-sm">
                    <tbody>
                      {falhas.map((p) => (
                        <tr key={p.codigo} className="border-b last:border-0">
                          <td className="py-1">{t(ROTULO_DO_PROBLEMA[p.codigo] ?? p.codigo)}</td>
                          <td className="py-1 text-right">
                            {p.atendimentos} {t("de")} {atual.conversations_analyzed}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  <p className="mt-2 text-xs text-muted-foreground">{t("Contagem de atendimentos distintos, sobre todos os analisados no período.")}</p>
                </CardContent>
              </Card>
              <Card>
                <CardHeader>
                  <CardTitle className="text-base">{ag?.criterios_formais ? t("Aderência ao script") : t("Aderência às boas práticas")}</CardTitle>
                </CardHeader>
                <CardContent>
                  <table className="w-full text-sm">
                    <tbody>
                      {(ag?.aderencia ?? []).map((a) => (
                        <tr key={a.criterio} className="border-b last:border-0">
                          <td className="py-1">{rotulo(a.criterio)}</td>
                          <td className="py-1 text-right">
                            {a.cumpridas}/{a.avaliadas} {a.pct !== null ? `(${a.pct}%)` : ""}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {notaDosDenominadores(ag?.aderencia ?? [], atual.conversations_analyzed) && (
                    <p className="mt-2 text-xs text-muted-foreground">{t(notaDosDenominadores(ag?.aderencia ?? [], atual.conversations_analyzed)!)}</p>
                  )}
                </CardContent>
              </Card>
            </div>
          )}
          {(dg?.gargalos ?? []).length > 0 && (
            <div className="grid gap-3 md:grid-cols-2">
              {dg!.gargalos!.map((g, i) => (
                <Card key={i}>
                  <CardHeader>
                    <CardTitle className="text-base">{g.titulo}</CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-1 text-sm">
                    <p className="text-muted-foreground">
                      {t("Frequência")}: {g.frequencia_observada}
                    </p>
                    <p>{g.descricao}</p>
                    <p>
                      <b>{t("Impacto")}:</b> {g.impacto}
                    </p>
                    <p>
                      <b>{t("O que fazer")}:</b> {g.acao_recomendada}
                    </p>
                    <p className="text-muted-foreground">
                      {t("Como acompanhar")}: {g.indicador}
                    </p>
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
          {(dg?.recomendacoes_priorizadas ?? []).length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle className="text-base">{t("Recomendações")}</CardTitle>
              </CardHeader>
              <CardContent>
                <ol className="list-decimal space-y-1 pl-5 text-sm">
                  {[...dg!.recomendacoes_priorizadas!]
                    .sort((a, b) => a.prioridade - b.prioridade)
                    .map((r, i) => (
                      <li key={i}>
                        {r.acao} <span className="text-muted-foreground">— {r.indicador}</span>
                      </li>
                    ))}
                </ol>
              </CardContent>
            </Card>
          )}
          {[...(dg?.pontos_positivos ?? []), ...(dg?.riscos ?? [])].length > 0 && (
            <div className="grid gap-3 md:grid-cols-2">
              <Card>
                <CardHeader>
                  <CardTitle className="text-base">{t("Pontos positivos")}</CardTitle>
                </CardHeader>
                <CardContent className="space-y-1 text-sm">
                  {(dg?.pontos_positivos ?? []).map((p, i) => (
                    <p key={i}>{p}</p>
                  ))}
                </CardContent>
              </Card>
              <Card>
                <CardHeader>
                  <CardTitle className="text-base">{t("Riscos")}</CardTitle>
                </CardHeader>
                <CardContent className="space-y-1 text-sm">
                  {(dg?.riscos ?? []).map((p, i) => (
                    <p key={i}>{p}</p>
                  ))}
                </CardContent>
              </Card>
            </div>
          )}

          {dg?.versao === 2 ? (
            <section className="space-y-3" data-testid="supervisor-casos">
              <div>
                <h3 className="text-lg font-semibold">{t("Análises individuais dos atendimentos")}</h3>
                <p className="text-sm text-muted-foreground">
                  {casos.length === 0
                    ? t("Nenhum atendimento do período teve achado relevante e bem fundamentado para virar estudo de caso.")
                    : t("Atendimentos escolhidos por representarem os achados mais relevantes do período (no máximo cinco). As mensagens são trechos reais; as sugestões são exemplos e não foram enviadas.")}
                </p>
              </div>
              {casos.length > 1 && (
                <div className="flex flex-wrap gap-2" role="tablist" aria-label={t("Estudos de caso")}>
                  {casos.map((c, i) => (
                    <Button key={c.conversation_id} role="tab" aria-selected={i === casoAberto} size="sm" variant={i === casoAberto ? "default" : "outline"} onClick={() => setCasoAberto(i)}>
                      {t("Caso")} {i + 1}
                    </Button>
                  ))}
                </div>
              )}
              {caso && <EstudoDeCaso caso={caso} n={Math.min(casoAberto, casos.length - 1) + 1} fuso={fuso} />}
            </section>
          ) : (
            <p className="text-xs text-muted-foreground">{t("Este diagnóstico foi gerado antes das análises individuais. Gere um novo para vê-las.")}</p>
          )}

          {(dg?.limitacoes ?? []).length > 0 && (
            <div className="rounded-md border border-dashed p-3 text-sm text-muted-foreground">
              <b>{t("Limitações")}:</b> {dg!.limitacoes!.join(" ")}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

const MODOS_UI: Array<{ v: Modo; r: string }> = [
  { v: "automatico", r: "Automático" },
  { v: "aprovacao", r: "Pede aprovação" },
  { v: "desligado", r: "Desligado" },
];
const KNOBS: Array<{ k: Exclude<keyof Autonomia, "sobrescrever_campos">; r: string }> = [
  { k: "mover_etapa", r: "Mover etapa" },
  { k: "campos", r: "Preencher campos" },
  { k: "tags", r: "Tags" },
  { k: "tarefas", r: "Criar tarefas" },
  { k: "qualificacao", r: "Qualificação e sinais do score" },
  { k: "valor", r: "Valor do negócio" },
  { k: "followup", r: "Iniciar follow-up" },
  { k: "ganho", r: "Registrar ganho" },
  { k: "perda", r: "Registrar perda" },
];

function Configuracao(props: { isAdmin: boolean; funis: Funil[]; etapas: Etapa[]; fluxos: Array<{ id: string; name: string }> }) {
  const t = useT();
  const q = useQuery({
    queryKey: ["supervisor", "config"],
    queryFn: () =>
      apiClient.get<{ data: { enabled: boolean; config: SupervisorConfig; updated_at: string | null; modelo: ModeloDoSupervisor } }>(
        "/api/v1/supervisor/settings",
      ),
  });
  if (!q.data) return <p className="text-sm text-muted-foreground">{t("Carregando…")}</p>;
  const modelo = q.data.data.modelo;
  // `key` remonta o formulário quando a config salva muda: o estado local nasce
  // da resposta, sem efeito copiando dado do servidor para o estado.
  return (
    <div className="space-y-4">
      <EscolhaDoModelo
        key={modelo.escolha ? `${modelo.escolha.provider}|${modelo.escolha.model_id}` : "automatico"}
        modelo={modelo}
        isAdmin={props.isAdmin}
      />
      <FormularioDeConfiguracao key={q.data.data.updated_at ?? "novo"} inicial={q.data.data} {...props} />
    </div>
  );
}

const PONTOS_DO_SUPERVISOR = ["supervisor_observe", "supervisor_diagnose"] as const;

/**
 * Qual modelo de IA o Supervisor usa — como no editor de agente: provedor e
 * modelo. A escolha vale para a leitura das conversas e para o diagnóstico, e
 * é gravada pela mesma rota da tela de Provedores (vínculo por ponto, com a
 * mesma validação e auditoria). "Automático" desliga o vínculo e volta ao
 * padrão: a conta ChatGPT conectada, senão a chave da organização.
 */
function EscolhaDoModelo({ modelo, isAdmin }: { modelo: ModeloDoSupervisor; isAdmin: boolean }) {
  const t = useT();
  const qc = useQueryClient();
  const [provider, setProvider] = useState(modelo.escolha?.provider ?? "");
  const [modelId, setModelId] = useState(modelo.escolha?.model_id ?? "");
  const [msg, setMsg] = useState<string | null>(null);
  const [salvando, setSalvando] = useState(false);
  const opcao = modelo.opcoes.find((o) => o.provider === provider) ?? null;
  const mudou = provider !== (modelo.escolha?.provider ?? "") || (provider !== "" && modelId !== modelo.escolha?.model_id);

  async function salvar() {
    setMsg(null);
    setSalvando(true);
    try {
      for (const purpose of PONTOS_DO_SUPERVISOR) {
        if (provider === "") {
          if (modelo.escolha)
            await apiClient.put("/api/v1/ai/providers", {
              purpose,
              provider: modelo.escolha.provider,
              model_id: modelo.escolha.model_id,
              credential_id: modelo.escolha.credential_id,
              is_enabled: false,
            });
        } else {
          await apiClient.put("/api/v1/ai/providers", { purpose, provider, model_id: modelId, credential_id: opcao?.credential_id ?? null });
        }
      }
      setMsg(t("Modelo do Supervisor salvo."));
      await qc.invalidateQueries({ queryKey: ["supervisor", "config"] });
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setSalvando(false);
    }
  }

  return (
    <Card data-testid="supervisor-modelo">
      <CardHeader>
        <CardTitle className="text-base">{t("Modelo de IA do Supervisor")}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <p className="text-muted-foreground">
          {t("Escolha o provedor e o modelo que o Supervisor usa para ler as conversas e gerar o diagnóstico. Só aparecem provedores com chave validada (ou a conta ChatGPT conectada) em Agente de IA › Credenciais.")}
        </p>
        <div className="flex flex-wrap items-end gap-3">
          <div className="space-y-1">
            <Label htmlFor="sup-provedor">{t("Provedor")}</Label>
            <select
              id="sup-provedor"
              className="h-9 min-w-56 rounded-md border bg-background px-2 text-sm"
              value={provider}
              disabled={!isAdmin}
              onChange={(e) => {
                const p = e.target.value;
                setProvider(p);
                const op = modelo.opcoes.find((o) => o.provider === p);
                setModelId(op?.modelos.find((m) => m.padrao)?.id ?? op?.modelos[0]?.id ?? "");
              }}
            >
              <option value="">{t("Automático (padrão da organização)")}</option>
              {modelo.opcoes.map((o) => (
                <option key={o.provider} value={o.provider}>
                  {t(o.rotulo)}
                </option>
              ))}
            </select>
          </div>
          {provider !== "" && (
            <div className="space-y-1">
              <Label htmlFor="sup-modelo">{t("Modelo")}</Label>
              <select
                id="sup-modelo"
                className="h-9 min-w-56 rounded-md border bg-background px-2 text-sm"
                value={modelId}
                disabled={!isAdmin}
                onChange={(e) => setModelId(e.target.value)}
              >
                {(opcao?.modelos ?? []).map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.nome}
                  </option>
                ))}
              </select>
            </div>
          )}
          {isAdmin && (
            <Button onClick={salvar} disabled={salvando || !mudou || (provider !== "" && modelId === "")}>
              {t("Salvar modelo")}
            </Button>
          )}
        </div>
        {modelo.opcoes.length === 0 && (
          <p className="text-muted-foreground">{t("Nenhuma credencial de IA validada nesta organização. Cadastre uma em Agente de IA › Credenciais.")}</p>
        )}
        {modelo.divergente && (
          <p className="text-muted-foreground">
            {t("Hoje a leitura e o diagnóstico usam modelos diferentes (configurados em Agente de IA › Provedores). Salvar aqui aplica o mesmo modelo aos dois.")}
          </p>
        )}
        <p className="text-muted-foreground" data-testid="supervisor-modelo-em-uso">
          {t("Em uso")}:{" "}
          {modelo.escolha
            ? `${t(modelo.opcoes.find((o) => o.provider === modelo.escolha!.provider)?.rotulo ?? modelo.escolha.provider)} · ${modelo.escolha.model_id}`
            : t("automático — a conta ChatGPT conectada, se houver; senão a chave da organização.")}
        </p>
        {msg && <p role="status">{msg}</p>}
      </CardContent>
    </Card>
  );
}

function FormularioDeConfiguracao({
  isAdmin,
  funis,
  etapas,
  fluxos,
  inicial,
}: {
  isAdmin: boolean;
  funis: Funil[];
  etapas: Etapa[];
  fluxos: Array<{ id: string; name: string }>;
  inicial: { enabled: boolean; config: SupervisorConfig };
}) {
  const t = useT();
  const qc = useQueryClient();
  const [enabled, setEnabled] = useState(inicial.enabled);
  const [cfg, setCfg] = useState<SupervisorConfig>(inicial.config);
  const [criterios, setCriterios] = useState(inicial.config.script.criterios.map((c) => `${c.id}: ${c.descricao}`).join("\n"));
  const [msg, setMsg] = useState<string | null>(null);
  const ro = !isAdmin;
  const set = (patch: Partial<SupervisorConfig>) => setCfg({ ...cfg, ...patch });

  async function salvar() {
    setMsg(null);
    const crit = criterios
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => {
        const [id, ...rest] = l.split(":");
        return { id: (id ?? "").trim().toLowerCase().replace(/[^a-z0-9_]/g, "_").slice(0, 40), descricao: rest.join(":").trim() || l };
      });
    try {
      await apiClient.put("/api/v1/supervisor/settings", { enabled, config: { ...cfg, script: { ...cfg.script, criterios: crit } } });
      setMsg(t("Configuração salva."));
      // Não recarrega a config: remontaria o formulário e apagaria a confirmação.
      await qc.invalidateQueries({ queryKey: ["supervisor", "acoes"] });
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    }
  }
  async function analisarAgora() {
    setMsg(null);
    try {
      const r = await apiClient.post<{ data: Record<string, number> }>("/api/v1/supervisor/observe", {});
      setMsg(
        (r.data.sem_modelo ?? 0) > 0
          ? t("Nenhum modelo de IA disponível para o Supervisor. Confira a credencial e o provedor escolhido em Agente de IA › Provedores.")
          : `${t("Conversas lidas")}: ${r.data.conversas_lidas} · ${t("Ações aplicadas")}: ${r.data.acoes_aplicadas} · ${t("Pendências")}: ${r.data.acoes_pendentes}`,
      );
      await qc.invalidateQueries({ queryKey: ["supervisor"] });
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <div className="space-y-4" data-testid="supervisor-config">
      {ro && <p className="text-sm text-muted-foreground">{t("Só administradores alteram a configuração.")}</p>}
      <Card>
        <CardContent className="space-y-4 pt-6">
          <div className="flex items-center gap-3">
            <Switch id="sup-ligado" checked={enabled} disabled={ro} onCheckedChange={setEnabled} />
            <Label htmlFor="sup-ligado">{t("Supervisor ligado")}</Label>
          </div>
          <div>
            <p className="mb-1 text-sm font-medium">{t("Funis monitorados")}</p>
            <div className="flex flex-wrap gap-3">
              {funis.map((f) => (
                <label key={f.id} className="flex items-center gap-1 text-sm">
                  <input
                    type="checkbox"
                    disabled={ro}
                    checked={cfg.pipelines.includes(f.id)}
                    onChange={(e) =>
                      set({ pipelines: e.target.checked ? [...cfg.pipelines, f.id] : cfg.pipelines.filter((x) => x !== f.id) })
                    }
                  />
                  {f.name}
                </label>
              ))}
            </div>
          </div>
          <div className="grid gap-2 md:grid-cols-3">
            {KNOBS.map((k) => (
              <div key={k.k} className="space-y-1">
                <Label htmlFor={`sup-modo-${k.k}`}>{t(k.r)}</Label>
                <select
                  id={`sup-modo-${k.k}`}
                  disabled={ro}
                  className="h-9 w-full rounded-md border bg-background px-2 text-sm"
                  value={cfg.autonomia[k.k]}
                  onChange={(e) => set({ autonomia: { ...cfg.autonomia, [k.k]: e.target.value as Modo } })}
                >
                  {MODOS_UI.map((m) => (
                    <option key={m.v} value={m.v}>
                      {t(m.r)}
                    </option>
                  ))}
                </select>
              </div>
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-6">
            <label className="flex items-center gap-2 text-sm">
              <Switch
                disabled={ro}
                checked={cfg.autonomia.sobrescrever_campos}
                onCheckedChange={(v) => set({ autonomia: { ...cfg.autonomia, sobrescrever_campos: v } })}
              />
              {t("Pode trocar valor já preenchido sem aprovação")}
            </label>
            <label className="flex items-center gap-2 text-sm">
              <Switch
                disabled={ro}
                checked={cfg.movimento_dispara_automacoes}
                onCheckedChange={(v) => set({ movimento_dispara_automacoes: v })}
              />
              {t("Movimentos automáticos disparam as automações e follow-ups por etapa")}
            </label>
            <div className="space-y-1">
              <Label htmlFor="sup-ganho-exige">{t("Ganho automático exige")}</Label>
              <select
                id="sup-ganho-exige"
                disabled={ro}
                className="h-9 rounded-md border bg-background px-2 text-sm"
                value={cfg.ganho_exige}
                onChange={(e) => set({ ganho_exige: e.target.value as SupervisorConfig["ganho_exige"] })}
              >
                <option value="venda_comprovada">{t("Venda comprovada (pagamento/pedido)")}</option>
                <option value="confirmacao_verbal">{t("Confirmação verbal do cliente")}</option>
              </select>
            </div>
            <div className="space-y-1">
              <Label htmlFor="sup-silencio">{t("Minutos de silêncio antes de ler")}</Label>
              <Input
                id="sup-silencio"
                type="number"
                min={1}
                max={1440}
                disabled={ro}
                className="w-28"
                value={cfg.silencio_minutos}
                onChange={(e) => set({ silencio_minutos: Number(e.target.value) || 20 })}
              />
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t("Regras de movimentação por etapa")}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          <p className="text-xs text-muted-foreground">
            {t("Descreva o que, na conversa, justifica entrar na etapa. Etapa sem critério nunca recebe negócio sozinha; ganho e perda passam pelas regras próprias.")}
          </p>
          {etapas
            .filter((e) => cfg.pipelines.includes(e.pipeline_id) && !e.is_won && !e.is_lost)
            .map((e) => {
              const r = cfg.etapas[e.id] ?? { criterio: "", automatico: true };
              return (
                <div key={e.id} className="grid items-center gap-2 md:grid-cols-[180px_1fr_auto]">
                  <span className="text-sm font-medium">
                    {e.name}
                    {e.requires_human ? ` (${t("pede humano")})` : ""}
                  </span>
                  <Input
                    aria-label={`${t("Critério")} ${e.name}`}
                    disabled={ro}
                    value={r.criterio}
                    placeholder={t("Ex.: o vendedor enviou uma proposta com valor")}
                    onChange={(ev) => set({ etapas: { ...cfg.etapas, [e.id]: { ...r, criterio: ev.target.value } } })}
                  />
                  <label className="flex items-center gap-1 text-xs">
                    <Switch
                      disabled={ro}
                      checked={r.automatico}
                      onCheckedChange={(v) => set({ etapas: { ...cfg.etapas, [e.id]: { ...r, automatico: v } } })}
                    />
                    {t("sozinho")}
                  </label>
                </div>
              );
            })}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t("Tags, follow-up e script")}</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-3 md:grid-cols-2">
          <div className="space-y-1">
            <Label htmlFor="sup-tags">{t("Tags que pode adicionar (separadas por vírgula)")}</Label>
            <Input
              id="sup-tags"
              disabled={ro}
              value={cfg.tags_permitidas.join(", ")}
              onChange={(e) => set({ tags_permitidas: e.target.value.split(",").map((x) => x.trim()).filter(Boolean) })}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="sup-tags-rm">{t("Tags que pode remover")}</Label>
            <Input
              id="sup-tags-rm"
              disabled={ro}
              value={cfg.tags_removiveis.join(", ")}
              onChange={(e) => set({ tags_removiveis: e.target.value.split(",").map((x) => x.trim()).filter(Boolean) })}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="sup-fluxo">{t("Fluxo de follow-up que pode iniciar")}</Label>
            <select
              id="sup-fluxo"
              disabled={ro}
              className="h-9 w-full rounded-md border bg-background px-2 text-sm"
              value={cfg.followup_pointer_id ?? ""}
              onChange={(e) => set({ followup_pointer_id: e.target.value || null })}
            >
              <option value="">{t("Nenhum — cria tarefa para o vendedor")}</option>
              {fluxos.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.name}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-1">
            <Label htmlFor="sup-recorrente">{t("Diagnóstico recorrente")}</Label>
            <select
              id="sup-recorrente"
              disabled={ro}
              className="h-9 w-full rounded-md border bg-background px-2 text-sm"
              value={cfg.relatorio_recorrente}
              onChange={(e) => set({ relatorio_recorrente: e.target.value as SupervisorConfig["relatorio_recorrente"] })}
            >
              <option value="desligado">{t("Desligado")}</option>
              <option value="semanal">{t("Semanal")}</option>
              <option value="mensal">{t("Mensal")}</option>
            </select>
          </div>
          <div className="space-y-1 md:col-span-2">
            <Label htmlFor="sup-script">{t("Script comercial da empresa")}</Label>
            <Textarea
              id="sup-script"
              disabled={ro}
              rows={4}
              value={cfg.script.texto}
              onChange={(e) => set({ script: { ...cfg.script, texto: e.target.value } })}
            />
          </div>
          <div className="space-y-1 md:col-span-2">
            <Label htmlFor="sup-criterios">{t("Critérios de avaliação (um por linha, no formato id: descrição)")}</Label>
            <Textarea id="sup-criterios" disabled={ro} rows={4} value={criterios} onChange={(e) => setCriterios(e.target.value)} />
          </div>
        </CardContent>
      </Card>

      {isAdmin && (
        <div className="flex flex-wrap items-center gap-3">
          <Button onClick={salvar}>{t("Salvar configuração")}</Button>
          <Button variant="outline" onClick={analisarAgora} disabled={!enabled}>
            {t("Analisar agora")}
          </Button>
          {msg && <span className="text-sm text-muted-foreground" data-testid="supervisor-msg">{msg}</span>}
        </div>
      )}
    </div>
  );
}

export function SupervisorClient(props: { isAdmin: boolean; fuso: string | null; funis: Funil[]; etapas: Etapa[]; fluxos: Array<{ id: string; name: string }> }) {
  const t = useT();
  const pend = useAcoes("pending_approval");
  const n = pend.data?.data.actions.length ?? 0;
  return (
    <Tabs defaultValue="atividade">
      <TabsList>
        <TabsTrigger value="atividade">{t("Atividade")}</TabsTrigger>
        <TabsTrigger value="pendencias">
          {t("Pendências")}
          {n > 0 ? ` (${n})` : ""}
        </TabsTrigger>
        <TabsTrigger value="diagnostico">{t("Diagnóstico")}</TabsTrigger>
        <TabsTrigger value="config">{t("Configuração")}</TabsTrigger>
      </TabsList>
      <TabsContent value="atividade" className="pt-4">
        <Atividade fuso={props.fuso} />
      </TabsContent>
      <TabsContent value="pendencias" className="pt-4">
        <Pendencias funis={props.funis} />
      </TabsContent>
      <TabsContent value="diagnostico" className="pt-4">
        <Diagnostico fuso={props.fuso} />
      </TabsContent>
      <TabsContent value="config" className="pt-4">
        <Configuracao isAdmin={props.isAdmin} funis={props.funis} etapas={props.etapas} fluxos={props.fluxos} />
      </TabsContent>
    </Tabs>
  );
}
