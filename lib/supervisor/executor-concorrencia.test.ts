/**
 * Concorrência e retomada do executor (achados B e D da auditoria de 2026-11-25).
 *
 * O instante crítico é entre "conferi o estado" e "gravei": o gancho
 * `antesDeAtualizar` do banco em memória faz o vendedor mexer no negócio
 * exatamente ali. O banco também espelha o trigger `trg_crm_leads_updated_at`
 * (todo UPDATE avança a versão), que é o que a trava usa no Postgres real.
 *
 * Reprodução: os casos de campo, tag e valor, rodados contra o código anterior
 * (724347ae5), sobrescreviam a mudança do vendedor ou devolviam "aplicado" com
 * zero linhas alteradas.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/leads/score-writer", () => ({ recalculaScoreDoLead: vi.fn(async () => ({ leadId: "x", gravou: true })) }));
vi.mock("@/lib/followup/enroll", () => ({ enrollFollowupFlow: vi.fn(async () => ({ ok: true, enrollment: {} })) }));

import { audit } from "@/lib/audit";

import { concluiAcao, executaAcao, idDoEfeito, type AcaoGravada, type QuemExecuta } from "./executor";
import { retomaAcoesInterrompidas } from "./retomada";
import { BancoEmMemoria } from "./testing/banco-em-memoria";

const ORG = "00000000-0000-4000-8000-00000000000a";
const LEAD = "00000000-0000-4000-8000-0000000000l1".replace("l", "1");
const CONTATO = "00000000-0000-4000-8000-0000000000c1";
const ST_A = "00000000-0000-4000-8000-0000000000e1";
const ST_B = "00000000-0000-4000-8000-0000000000e2";

let db: BancoEmMemoria;
const admin = () => db as unknown as SupabaseClient;
const auto: QuemExecuta = { aprovadorUserId: null, llmCallId: null, requestId: "r" };
const negocio = () => db.linhas("crm_leads").find((l) => l.id === LEAD)!;

function acao(p: Partial<AcaoGravada> & Pick<AcaoGravada, "kind" | "after">): AcaoGravada {
  const a: AcaoGravada = {
    id: `00000000-0000-4000-8000-${String(db.linhas("supervisor_actions").length + 1).padStart(12, "0")}`,
    organization_id: ORG,
    run_id: "run-1",
    conversation_id: "conv-1",
    contact_id: CONTATO,
    lead_id: LEAD,
    before: null,
    reason: "teste",
    evidence: [],
    ...p,
  };
  db.linhas("supervisor_actions").push({ ...a, status: "executing", execution_started_at: new Date().toISOString(), execution_attempts: 1 });
  return a;
}

beforeEach(() => {
  db = new BancoEmMemoria();
  vi.mocked(audit).mockClear();
  db.linhas("crm_leads").push({
    id: LEAD,
    organization_id: ORG,
    pipeline_id: "p1",
    stage_id: ST_A,
    status: "open",
    contact_id: CONTATO,
    custom_fields: { produto: null, cidade: "Recife" },
    tags: ["lead-quente"],
    value_cents: null,
    owner_user_id: null,
    updated_at: "2026-11-25T10:00:00.000Z",
  });
});

/** O vendedor mexe no negócio no instante entre a conferência e a escrita — uma vez. */
function vendedorMexeNoMeio(mudanca: (l: Record<string, unknown>) => void) {
  let feito = false;
  db.antesDeAtualizar = (t) => {
    if (t !== "crm_leads" || feito) return;
    feito = true;
    const l = negocio();
    mudanca(l);
    l.updated_at = new Date(Date.parse(String(l.updated_at)) + 5).toISOString(); // o trigger avança a versão
  };
}

describe("achado B — a mudança humana no meio prevalece", () => {
  it("campo: vendedor preenche O MESMO campo entre a conferência e a escrita → Supervisor não sobrescreve", async () => {
    vendedorMexeNoMeio((l) => ((l.custom_fields as Record<string, unknown>).produto = "Escolhido pelo vendedor"));
    const a = acao({ kind: "set_field", before: { valor: null }, after: { key: "produto", valor: "Do Supervisor" } });
    const r = await executaAcao(admin(), null, a, auto);
    expect(r).toEqual({ status: "skipped", detalhe: "conflito_humano" });
    expect((negocio().custom_fields as Record<string, unknown>).produto).toBe("Escolhido pelo vendedor");
  });

  it("campo: vendedor edita OUTRO campo no meio → os dois valores sobrevivem", async () => {
    vendedorMexeNoMeio((l) => ((l.custom_fields as Record<string, unknown>).cidade = "Olinda"));
    const a = acao({ kind: "set_field", before: { valor: null }, after: { key: "produto", valor: "Site" } });
    const r = await executaAcao(admin(), null, a, auto);
    expect(r.status).toBe("applied");
    expect(negocio().custom_fields).toEqual({ produto: "Site", cidade: "Olinda" });
  });

  it("tags: vendedor adiciona uma tag no meio → a tag dele não se perde", async () => {
    vendedorMexeNoMeio((l) => (l.tags = [...(l.tags as string[]), "pediu-desconto"]));
    const a = acao({ kind: "add_tag", after: { tag: "proposta-enviada" } });
    const r = await executaAcao(admin(), null, a, auto);
    expect(r.status).toBe("applied");
    expect(negocio().tags).toEqual(["lead-quente", "pediu-desconto", "proposta-enviada"]);
  });

  it("valor: vendedor define o valor no meio → Supervisor não sobrescreve e NÃO registra aplicado", async () => {
    vendedorMexeNoMeio((l) => (l.value_cents = 900_00));
    const a = acao({ kind: "set_value", before: { value_cents: null }, after: { value_cents: 480_00 } });
    const r = await executaAcao(admin(), null, a, auto);
    expect(r).toEqual({ status: "skipped", detalhe: "conflito_humano" });
    expect(negocio().value_cents).toBe(900_00);
  });

  it("valor: sem conflito, aplica e confere a linha", async () => {
    const a = acao({ kind: "set_value", before: { value_cents: null }, after: { value_cents: 480_00 } });
    expect((await executaAcao(admin(), null, a, auto)).status).toBe("applied");
    expect(negocio().value_cents).toBe(480_00);
  });

  it("qualificação: o vendedor mudou o orçamento no meio → a chave dele vence, a outra entra", async () => {
    db.linhas("lead_state").push({ id: "ls1", organization_id: ORG, contact_id: CONTATO, qualification: { budget: "" } });
    let feito = false;
    db.antesDeAtualizar = (t) => {
      if (t !== "lead_state" || feito) return;
      feito = true;
      db.linhas("lead_state")[0]!.qualification = { budget: "R$ 10 mil (vendedor)" };
    };
    const a = acao({
      kind: "update_qualification",
      before: { qualification: { budget: "" } },
      after: { qualification: { budget: "R$ 5 mil", timeline: "dezembro" } },
    });
    const r = await executaAcao(admin(), null, a, auto);
    expect(r.status).toBe("applied");
    expect(db.linhas("lead_state")[0]!.qualification).toEqual({ budget: "R$ 10 mil (vendedor)", timeline: "dezembro" });
  });
});

describe("achado D — ação interrompida é retomada sem efeito duplicado", () => {
  const antiga = () => new Date(Date.now() - 20 * 60_000).toISOString();

  it("auto: efeito aconteceu, processo caiu antes de concluir → retomada fecha como aplicada, sem duplicar a tarefa", async () => {
    const a = acao({ kind: "create_task", after: { title: "Ligar amanhã", due_date: null } });
    await executaAcao(admin(), null, a, auto); // efeito feito…
    // …e o processo morreu antes de concluiAcao: a ação segue em executing.
    db.linhas("supervisor_actions").find((x) => x.id === a.id)!.execution_started_at = antiga();

    const res = await retomaAcoesInterrompidas(admin(), null, new Date(), "r2");
    expect(res).toEqual({ retomadas: 1, aplicadas: 1, desistidas: 0 });
    expect(db.linhas("crm_tasks").filter((t) => t.lead_id === LEAD)).toHaveLength(1);
    expect(db.linhas("crm_tasks")[0]!.id).toBe(idDoEfeito(a.id, "tarefa"));
    expect(db.linhas("supervisor_actions").find((x) => x.id === a.id)!.status).toBe("applied");
  });

  it("auto: processo caiu ANTES do efeito → retomada executa uma vez", async () => {
    const a = acao({ kind: "move_stage", before: { stage_id: ST_A }, after: { stage_id: ST_B } });
    db.linhas("supervisor_actions").find((x) => x.id === a.id)!.execution_started_at = antiga();
    const res = await retomaAcoesInterrompidas(admin(), null, new Date(), "r2");
    expect(res.aplicadas).toBe(1);
    expect(negocio().stage_id).toBe(ST_B);
  });

  it("auto: movimento feito antes da queda → retomada reconhece o destino e não reporta conflito", async () => {
    const a = acao({ kind: "move_stage", before: { stage_id: ST_A }, after: { stage_id: ST_B } });
    await executaAcao(admin(), null, a, auto);
    db.linhas("supervisor_actions").find((x) => x.id === a.id)!.execution_started_at = antiga();
    await retomaAcoesInterrompidas(admin(), null, new Date(), "r2");
    const linha = db.linhas("supervisor_actions").find((x) => x.id === a.id)!;
    expect(linha.status).toBe("applied");
    expect(linha.result_detail).toBe("ja_no_destino");
  });

  it("aprovação: gestor aprovou, processo caiu → retomada fecha como APROVADA, com o gestor como autor", async () => {
    const a = acao({ kind: "add_tag", after: { tag: "aprovada" } });
    const row = db.linhas("supervisor_actions").find((x) => x.id === a.id)!;
    row.decided_by = "gestor-1";
    row.execution_started_at = antiga();
    await retomaAcoesInterrompidas(admin(), null, new Date(), "r2");
    expect(row.status).toBe("approved");
    expect(vi.mocked(audit).mock.calls.at(-1)![0]).toMatchObject({ action: "supervisor.action_approved", actorUserId: "gestor-1" });
  });

  it("duas retomadas concorrentes: só uma executa e só uma audita", async () => {
    const a = acao({ kind: "create_task", after: { title: "Enviar contrato", due_date: null } });
    db.linhas("supervisor_actions").find((x) => x.id === a.id)!.execution_started_at = antiga();
    const [r1, r2] = await Promise.all([
      retomaAcoesInterrompidas(admin(), null, new Date(), "r1"),
      retomaAcoesInterrompidas(admin(), null, new Date(), "r2"),
    ]);
    expect(r1.retomadas + r2.retomadas).toBe(1);
    expect(db.linhas("crm_tasks")).toHaveLength(1);
    expect(vi.mocked(audit)).toHaveBeenCalledTimes(1);
  });

  it("concluir duas vezes não regrava nem audita de novo", async () => {
    const a = acao({ kind: "add_tag", after: { tag: "x" } });
    const r = await executaAcao(admin(), null, a, auto);
    expect(await concluiAcao(admin(), null, a, auto, r)).toBe(true);
    expect(await concluiAcao(admin(), null, a, auto, r)).toBe(false);
    expect(vi.mocked(audit)).toHaveBeenCalledTimes(1);
  });

  it("depois de 3 tentativas, desiste com motivo em vez de girar para sempre", async () => {
    const a = acao({ kind: "add_tag", after: { tag: "x" } });
    const row = db.linhas("supervisor_actions").find((x) => x.id === a.id)!;
    row.execution_started_at = antiga();
    row.execution_attempts = 3;
    const res = await retomaAcoesInterrompidas(admin(), null, new Date(), "r");
    expect(res.desistidas).toBe(1);
    expect(row.status).toBe("failed");
    expect(row.result_detail).toBe("interrompida_repetidamente");
    expect(negocio().tags).toEqual(["lead-quente"]);
  });

  it("ação em execução RECENTE não é retomada (pode estar rodando agora)", async () => {
    acao({ kind: "add_tag", after: { tag: "x" } });
    const res = await retomaAcoesInterrompidas(admin(), null, new Date(), "r");
    expect(res.retomadas).toBe(0);
  });
});
