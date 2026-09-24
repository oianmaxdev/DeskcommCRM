import { describe, expect, it } from "vitest";

import { lerPendencias } from "@/lib/conversoes/estado-da-conexao";

describe("superfície do ledger de conversões", () => {
  it("mostra Lead e Purchase, mas não transforma processing/retry em pendência humana", async () => {
    const filtros: Array<{ coluna: string; valores: unknown[] }> = [];
    const linhas = [
      {
        lead_id: "11111111-1111-4111-8111-111111111111",
        event_name: "Lead",
        status: "error",
        reason: "recusado_pela_plataforma",
        detail: "evento recusado",
        value_cents: null,
        attempted_at: "2026-09-21T12:00:00.000Z",
        crm_leads: { title: "Novo contato" },
      },
      {
        lead_id: "22222222-2222-4222-8222-222222222222",
        event_name: "Purchase",
        status: "skipped",
        reason: "sem_valor",
        detail: null,
        value_cents: null,
        attempted_at: "2026-09-21T13:00:00.000Z",
        crm_leads: [{ title: "Venda" }],
      },
    ];

    const consulta = {
      select: () => consulta,
      eq: () => consulta,
      in: (coluna: string, valores: unknown[]) => {
        filtros.push({ coluna, valores });
        return consulta;
      },
      order: () => consulta,
      limit: () => consulta,
      then: <T>(resolve: (valor: { data: typeof linhas; error: null }) => T) =>
        Promise.resolve({ data: linhas, error: null }).then(resolve),
    };
    const admin = { from: () => consulta };

    const pendencias = await lerPendencias(admin as never, "33333333-3333-4333-8333-333333333333");

    expect(filtros).toEqual([{ coluna: "status", valores: ["skipped", "error"] }]);
    expect(pendencias).toEqual([
      expect.objectContaining({ evento: "Lead", tituloDoLead: "Novo contato" }),
      expect.objectContaining({ evento: "Purchase", tituloDoLead: "Venda" }),
    ]);
  });
});
