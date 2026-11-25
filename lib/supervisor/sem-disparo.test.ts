/**
 * Uma decisão administrativa AUTOMÁTICA do Supervisor não vira mensagem por
 * tabela — mas o evento continua existindo. Mede os dois consumidores que podem
 * terminar em envio (motor de regras e follow-up por etapa) e o carimbo do
 * executor, nos dois sentidos.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => {
    throw new Error("não deveria tocar o banco");
  },
}));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));

import type { EventRow } from "@/lib/event-log/dispatcher";
import { SEM_DISPARO_AUTOMATICO } from "@/lib/event-log/sem-disparo";
import { runAutomationForEvent } from "@/lib/automation/engine";
import { followupGatilhoEtapaHandler } from "@/lib/followup/gatilho-etapa.handler";

import { metadataDoEvento } from "./executor";

function linha(metadata: Record<string, unknown>): EventRow {
  return {
    id: "e1",
    organization_id: "00000000-0000-4000-8000-00000000000a",
    event_type: "lead.stage_changed",
    entity_kind: "crm_lead",
    entity_id: "00000000-0000-4000-8000-0000000000l1",
    payload: {},
    metadata,
    attempts: 0,
    created_at: new Date().toISOString(),
  } as unknown as EventRow;
}

describe("evento marcado 'sem disparo'", () => {
  const marcado = linha({ source: "supervisor-comercial", [SEM_DISPARO_AUTOMATICO]: true });
  // Um cliente que EXPLODE se for usado: pular tem de acontecer antes de ler regra.
  const bancoQueExplode = new Proxy({}, { get: () => { throw new Error("leu o banco"); } }) as SupabaseClient;

  it("o motor de regras de automação pula, com o motivo", async () => {
    await expect(runAutomationForEvent(bancoQueExplode, marcado)).resolves.toEqual({
      consumer_key: "automation-rules",
      status: "skipped",
      detail: "sem_disparo_automatico",
    });
  });

  it("o gatilho de follow-up por etapa pula, com o motivo", async () => {
    await expect(followupGatilhoEtapaHandler.handle(marcado)).resolves.toMatchObject({
      status: "skipped",
      detail: "sem_disparo_automatico",
    });
  });

  it("CONTROLE: sem a marca, o motor segue e chega ao banco (não pula pelo motivo novo)", async () => {
    await expect(runAutomationForEvent(bancoQueExplode, linha({ source: "supervisor-comercial" }))).rejects.toThrow("leu o banco");
  });
});

describe("o carimbo do executor", () => {
  it("automático, sem autorização da organização → marca", () => {
    expect(metadataDoEvento({ aprovadorUserId: null, llmCallId: null, requestId: "r" })).toMatchObject({
      actor_kind: "ai",
      [SEM_DISPARO_AUTOMATICO]: true,
    });
  });
  it("automático, com a organização optando por disparar → sem marca", () => {
    expect(metadataDoEvento({ aprovadorUserId: null, llmCallId: null, requestId: "r", dispararAutomacoes: true })).not.toHaveProperty(
      SEM_DISPARO_AUTOMATICO,
    );
  });
  it("aprovado por um gestor → decisão humana, sem marca", () => {
    const m = metadataDoEvento({ aprovadorUserId: "u1", llmCallId: null, requestId: "r" });
    expect(m).toMatchObject({ actor_kind: "user", actor_user_id: "u1" });
    expect(m).not.toHaveProperty(SEM_DISPARO_AUTOMATICO);
  });
});
