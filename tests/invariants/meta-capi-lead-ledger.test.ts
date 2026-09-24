import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";

/**
 * O LIVRO-RAZÃO É A PRIMEIRA BARREIRA CONTRA DUPLICAÇÃO.
 *
 * O `event_id` determinístico segue para a plataforma como segunda barreira,
 * mas só o claim atômico impede dois workers locais de fazerem HTTP juntos.
 */
const container = process.env.TEST_DB_CONTAINER;
if (!container) {
  throw new Error("TEST_DB_CONTAINER not set — rode via `pnpm test:db` (scripts/test-db.sh)");
}

const PORT = Number(process.env.TEST_DB_PORT ?? 54329);
const pool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${PORT}/postgres`,
  max: 2,
});

const ORG = "ca920000-0000-4000-8000-000000000001";
const ORG_VIZINHA = "ca920000-0000-4000-8000-000000000002";
let lead = "";
let leadLease = "";

interface Claim {
  acquired: boolean;
  token: string | null;
  current_status: string;
}

async function criarLead(titulo: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `insert into crm_leads (organization_id, pipeline_id, stage_id, title)
     select $1, p.id, s.id, $2
       from crm_pipelines p
       join lateral (
         select id from crm_stages
          where pipeline_id = p.id and is_archived = false and is_won = false and is_lost = false
          order by position limit 1
       ) s on true
      where p.organization_id = $1 and p.is_default = true
      order by p.position limit 1
     returning id`,
    [ORG, titulo],
  );
  return rows[0]!.id;
}

async function claim(leadId: string, evento: string, leaseSeconds = 60): Promise<Claim> {
  const { rows } = await pool.query<Claim>(
    `select * from fn_claim_ad_conversion_dispatch($1, $2, 'meta_ads', $3, $4, $5)`,
    [ORG, leadId, evento, `${leadId}:${evento}`, leaseSeconds],
  );
  return rows[0]!;
}

async function settle(leadId: string, evento: string, token: string, status = "sent") {
  const { rows } = await pool.query<{ ok: boolean }>(
    `select fn_settle_ad_conversion_dispatch(
       $1, $2, $3, $4, $5, null, null,
       case when $3 = 'Purchase' then 10000 else null end,
       case when $3 = 'Purchase' then 'BRL' else null end
     ) as ok`,
    [ORG, leadId, evento, token, status],
  );
  return rows[0]!.ok;
}

beforeAll(async () => {
  await pool.query(
    `insert into organizations (id, slug, legal_name, display_name) values
       ($1, 'meta-capi-ledger', 'Ledger LTDA', 'Ledger'),
       ($2, 'meta-capi-ledger-vizinha', 'Vizinha LTDA', 'Vizinha')`,
    [ORG, ORG_VIZINHA],
  );
  lead = await criarLead("Lead e Purchase");
  leadLease = await criarLead("Lease retomável");
});

afterAll(async () => {
  await pool.query("delete from organizations where id = any($1)", [[ORG, ORG_VIZINHA]]);
  await pool.end();
});

describe("Meta CAPI Lead — claim/lease do ledger", () => {
  it("dois workers concorrem e exatamente um adquire o Lead", async () => {
    await Promise.all([pool.query("select pg_sleep(0.05)"), pool.query("select pg_sleep(0.05)")]);
    const claims = await Promise.all([claim(lead, "Lead"), claim(lead, "Lead")]);
    expect(claims.filter((c) => c.acquired)).toHaveLength(1);
    expect(claims.filter((c) => !c.acquired)[0]).toMatchObject({ current_status: "processing" });

    const vencedor = claims.find((c) => c.acquired)!;
    expect(await settle(lead, "Lead", "00000000-0000-4000-8000-000000000099")).toBe(false);
    expect(await settle(lead, "Lead", vencedor.token!)).toBe(true);

    const depoisDeSent = await claim(lead, "Lead");
    expect(depoisDeSent).toMatchObject({ acquired: false, token: null, current_status: "sent" });
  });

  it("o mesmo lead mantém Lead e Purchase como linhas independentes", async () => {
    const purchase = await claim(lead, "Purchase");
    expect(purchase.acquired).toBe(true);
    expect(await settle(lead, "Purchase", purchase.token!)).toBe(true);

    const { rows } = await pool.query<{
      event_name: string;
      event_id: string;
      status: string;
      value_cents: string | null;
      currency: string | null;
    }>(
      `select event_name, event_id, status, value_cents, currency
         from ad_conversion_dispatches
        where organization_id = $1 and lead_id = $2
        order by event_name`,
      [ORG, lead],
    );
    expect(rows).toEqual([
      {
        event_name: "Lead",
        event_id: `${lead}:Lead`,
        status: "sent",
        value_cents: null,
        currency: null,
      },
      {
        event_name: "Purchase",
        event_id: `${lead}:Purchase`,
        status: "sent",
        value_cents: "10000",
        currency: "BRL",
      },
    ]);
  });

  it("lease vencido é retomável e o token antigo não pode concluir", async () => {
    const primeiro = await claim(leadLease, "Lead", 1);
    expect(primeiro.acquired).toBe(true);
    await pool.query(
      `update ad_conversion_dispatches set claimed_until = now() - interval '1 second'
        where organization_id = $1 and lead_id = $2 and event_name = 'Lead'`,
      [ORG, leadLease],
    );

    const retomado = await claim(leadLease, "Lead", 60);
    expect(retomado.acquired).toBe(true);
    expect(retomado.token).not.toBe(primeiro.token);
    expect(await settle(leadLease, "Lead", primeiro.token!)).toBe(false);
    expect(await settle(leadLease, "Lead", retomado.token!)).toBe(true);

    const { rows } = await pool.query<{ attempt_count: number; status: string }>(
      `select attempt_count, status from ad_conversion_dispatches
        where organization_id = $1 and lead_id = $2 and event_name = 'Lead'`,
      [ORG, leadLease],
    );
    expect(rows[0]).toEqual({ attempt_count: 2, status: "sent" });
  });

  it("organization_id não pode reivindicar lead do tenant vizinho", async () => {
    const { rows } = await pool.query<Claim>(
      `select * from fn_claim_ad_conversion_dispatch($1, $2, 'meta_ads', 'Lead', $3, 60)`,
      [ORG_VIZINHA, lead, `${lead}:Lead`],
    );
    expect(rows[0]).toMatchObject({
      acquired: false,
      token: null,
      current_status: "lead_inexistente",
    });

    const contagem = await pool.query<{ n: number }>(
      `select count(*)::int as n from ad_conversion_dispatches
        where organization_id = $1 and lead_id = $2`,
      [ORG_VIZINHA, lead],
    );
    expect(contagem.rows[0]!.n).toBe(0);
  });

  it("as quatro RPCs são exclusivas do service_role", async () => {
    const assinaturas = [
      "fn_claim_ad_conversion_dispatch(uuid,uuid,text,text,text,integer)",
      "fn_settle_ad_conversion_dispatch(uuid,uuid,text,uuid,text,text,text,bigint,text)",
      "fn_release_ad_conversion_dispatch(uuid,uuid,text,uuid,text)",
      "fn_record_ad_conversion_outcome(uuid,uuid,text,text,text,text,text,text,bigint,text)",
    ];

    for (const assinatura of assinaturas) {
      const { rows } = await pool.query<{ anon: boolean; autenticado: boolean; servico: boolean }>(
        `select has_function_privilege('anon', $1, 'EXECUTE') as anon,
                has_function_privilege('authenticated', $1, 'EXECUTE') as autenticado,
                has_function_privilege('service_role', $1, 'EXECUTE') as servico`,
        [assinatura],
      );
      expect(rows[0], assinatura).toEqual({ anon: false, autenticado: false, servico: true });
    }
  });
});
