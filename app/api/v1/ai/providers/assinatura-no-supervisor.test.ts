import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { requireRole } from "@/lib/auth/require-role";
import { createClient } from "@/lib/supabase/server";

/**
 * A conta ChatGPT conectada por login (`openai-assinatura`) pode ser o modelo
 * do Supervisor — e SÓ dele: é o único consumidor que sabe usá-la
 * (`lib/supervisor/modelo.ts`). Em qualquer outro ponto o resolvedor não a
 * reconhece e cairia no padrão com aviso, então a escrita recusa.
 */
vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn(async () => null) }));

const ORG = "22222222-2222-4222-8222-222222222222";
const CRED = "33333333-3333-4333-8333-333333333333";

function banco(gravados: Array<Record<string, unknown>>) {
  return {
    from(tabela: string) {
      const q = {
        select: () => q,
        eq: () => q,
        is: () => q,
        maybeSingle: async () => {
          if (tabela === "ai_provider_credentials") return { data: { id: CRED, models_available: ["gpt-5.6-luna", "gpt-5.6-sol"] }, error: null };
          return { data: null, error: null };
        },
        upsert: (linha: Record<string, unknown>) => {
          gravados.push(linha);
          const r = async () => ({ data: { id: "44444444-4444-4444-8444-444444444444", ...linha }, error: null });
          return { select: () => ({ single: r, maybeSingle: r }) };
        },
      };
      return q;
    },
  };
}

function put(corpo: unknown) {
  return new NextRequest("http://localhost/api/v1/ai/providers", {
    method: "PUT",
    body: JSON.stringify(corpo),
    headers: { "content-type": "application/json" },
  });
}

describe("PUT /api/v1/ai/providers — assinatura do ChatGPT no Supervisor", () => {
  let gravados: Array<Record<string, unknown>>;
  beforeEach(() => {
    gravados = [];
    vi.mocked(requireRole).mockResolvedValue({
      ok: true,
      user: { id: "11111111-1111-4111-8111-111111111111", idioma: "pt-BR" },
      org: { orgId: ORG, role: "admin" },
    } as unknown as Awaited<ReturnType<typeof requireRole>>);
    vi.mocked(createClient).mockResolvedValue(banco(gravados) as never);
  });

  it("aceita nos pontos do Supervisor, com modelo que a conta tem", async () => {
    const { PUT } = await import("./route");
    for (const purpose of ["supervisor_observe", "supervisor_diagnose"]) {
      const r = await PUT(put({ purpose, provider: "openai-assinatura", model_id: "gpt-5.6-luna", credential_id: CRED }));
      expect(r.status).toBe(200);
    }
    expect(gravados.map((g) => [g.purpose, g.provider, g.model_id])).toEqual([
      ["supervisor_observe", "openai-assinatura", "gpt-5.6-luna"],
      ["supervisor_diagnose", "openai-assinatura", "gpt-5.6-luna"],
    ]);
  });

  it("recusa em ponto que não é do Supervisor", async () => {
    const { PUT } = await import("./route");
    const r = await PUT(put({ purpose: "stage_classifier", provider: "openai-assinatura", model_id: "gpt-5.6-luna" }));
    expect(r.status).toBe(422);
    expect(gravados).toHaveLength(0);
  });

  it("recusa modelo que a conta conectada não tem", async () => {
    const { PUT } = await import("./route");
    const r = await PUT(put({ purpose: "supervisor_observe", provider: "openai-assinatura", model_id: "gpt-6-astra" }));
    expect(r.status).toBe(422);
    expect(gravados).toHaveLength(0);
  });
});
