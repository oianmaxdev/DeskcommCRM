import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";

import { garantirLeadDaConversa } from "@/lib/leads/nascimento-do-lead";

import { pgComoSupabase } from "../pg-como-supabase";

/**
 * A PROVA DO LEAD É A MENSAGEM QUE O FEZ NASCER — não o first-touch do contato.
 *
 * Este arquivo usa a RPC real do baseline. O que ele congela não cabe num mock:
 * advisory lock, conferência da mensagem causal, INSERT do snapshot e emissão
 * de `lead.created` precisam pertencer à mesma transação no Postgres.
 */
const container = process.env.TEST_DB_CONTAINER;
if (!container) {
  throw new Error("TEST_DB_CONTAINER not set — rode via `pnpm test:db` (scripts/test-db.sh)");
}

const PORT = Number(process.env.TEST_DB_PORT ?? 54329);
const pool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${PORT}/postgres`,
  max: 3,
});
const db = pgComoSupabase(pool);

const ORG = "ca910000-0000-4000-8000-000000000001";
const ORG_VIZINHA = "ca910000-0000-4000-8000-000000000002";
const SESSION = "ca910000-0000-4000-8000-000000000101";

async function criarContato(nome: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `insert into contacts (organization_id, display_name, source, source_metadata)
     values ($1, $2, 'meta_ads',
             '{"ad_source_id":"CLICK_ANTIGO","source_id":"AMBIGUO","ad_id":"ANUNCIO"}'::jsonb)
     returning id`,
    [ORG, nome],
  );
  return rows[0]!.id;
}

async function criarEntrada(
  contato: string,
  sufixo: string,
  conversaExistente?: string,
): Promise<{ conversa: string; mensagem: string }> {
  const conversa =
    conversaExistente ??
    (
      await pool.query<{ id: string }>(
        `insert into conversations (organization_id, contact_id, channel_session_id, status, is_group)
         values ($1, $2, $3, 'open', false) returning id`,
        [ORG, contato, SESSION],
      )
    ).rows[0]!.id;
  const { rows: mensagens } = await pool.query<{ id: string }>(
    `insert into messages
       (organization_id, conversation_id, channel_session_id, contact_id,
        external_id, type, direction, status, body, sent_via, sent_at)
     values ($1, $2, $3, $4, $5, 'text', 'inbound', 'received', 'oi', 'external_device', now())
     returning id`,
    [ORG, conversa, SESSION, contato, `meta-capi-${sufixo}`],
  );
  return { conversa, mensagem: mensagens[0]!.id };
}

function dadosDoNascimento(
  contato: string,
  entrada: { conversa: string; mensagem: string },
  ctwaClid: string | null,
) {
  return {
    organizationId: ORG,
    contactId: contato,
    conversationId: entrada.conversa,
    messageId: entrada.mensagem,
    nomeDoContato: "Lead CAPI",
    atribuicaoDeAnuncioAtual: {
      plataforma: "meta_ads" as const,
      ctwaClid,
      adId: "ID_DO_ANUNCIO",
      titulo: null,
      corpo: null,
      sourceUrl: null,
      bruto: {},
    },
  };
}

beforeAll(async () => {
  await pool.query(
    `insert into organizations (id, slug, legal_name, display_name) values
       ($1, 'meta-capi-nascimento', 'Meta CAPI LTDA', 'Meta CAPI'),
       ($2, 'meta-capi-vizinha', 'Vizinha LTDA', 'Vizinha')`,
    [ORG, ORG_VIZINHA],
  );
  await pool.query(
    `insert into channel_sessions
       (id, organization_id, waha_session_name, status, webhook_secret_encrypted)
     values ($1, $2, 'meta-capi-session', 'WORKING', '\\x00'::bytea)`,
    [SESSION, ORG],
  );
});

afterAll(async () => {
  await pool.query("delete from organizations where id = any($1)", [[ORG, ORG_VIZINHA]]);
  await pool.end();
});

describe("Meta CAPI Lead — nascimento causal", () => {
  it("first-touch e UTM da v1.42 não viram prova causal sem referral atual", async () => {
    const contato = await criarContato("Landing sem CTWA");
    const entrada = await criarEntrada(contato, "utm-sem-ctwa");
    const { rows: atualizadas } = await pool.query(
      `update contacts
          set source_metadata = source_metadata || $2::jsonb
        where id = $1 returning id`,
      [contato, JSON.stringify({ utm_source: "meta", utm_campaign: "outono", fbclid: "FB_CLICK" })],
    );
    expect(atualizadas).toHaveLength(1);

    const resultado = await garantirLeadDaConversa(db, {
      ...dadosDoNascimento(contato, entrada, null),
      atribuicaoDeAnuncioAtual: null,
    });
    expect(resultado.criado).toBe(true);
    if (!resultado.criado) return;

    const { rows } = await pool.query<{ source_metadata: Record<string, unknown> }>(
      "select source_metadata from crm_leads where id = $1",
      [resultado.leadId],
    );
    expect(rows[0]!.source_metadata).toMatchObject({
      ad_source_id: "CLICK_ANTIGO",
      ad_id: "ANUNCIO",
      utm_campaign: "outono",
    });
    expect(rows[0]!.source_metadata).not.toHaveProperty("meta_capi_lead_birth_v1");
  });

  it("referral atual com apenas ad_id não cria prova de clique", async () => {
    const contato = await criarContato("Anúncio sem clique");
    const entrada = await criarEntrada(contato, "ad-sem-clique");
    const resultado = await garantirLeadDaConversa(db, dadosDoNascimento(contato, entrada, null));
    expect(resultado.criado).toBe(true);
    if (!resultado.criado) return;

    const { rows } = await pool.query<{ source_metadata: Record<string, unknown> }>(
      "select source_metadata from crm_leads where id = $1",
      [resultado.leadId],
    );
    expect(rows[0]!.source_metadata).not.toHaveProperty("meta_capi_lead_birth_v1");
  });

  it("metadata forjado na chamada da RPC é removido antes do insert", async () => {
    const contato = await criarContato("Prova forjada");
    const entrada = await criarEntrada(contato, "forjada");
    const { rows: destino } = await pool.query<{ pipeline_id: string; stage_id: string }>(
      `select p.id as pipeline_id, s.id as stage_id
         from crm_pipelines p join crm_stages s on s.pipeline_id = p.id
        where p.organization_id = $1 and p.is_default = true
          and s.is_won = false and s.is_lost = false and s.is_archived = false
        order by p.position, s.position limit 1`,
      [ORG],
    );
    const { rows } = await pool.query<{ id: string }>(
      `select fn_nascer_lead_da_conversa(
        $1, $2, $3, $4, 'Forjado', 'meta_ads',
        $5::jsonb, '{}'::text[], $6, $7, null
      ) as id`,
      [ORG, contato, destino[0]!.pipeline_id, destino[0]!.stage_id,
        JSON.stringify({ meta_capi_lead_birth_v1: { ctwa_clid: "FAKE" } }),
        entrada.mensagem, entrada.conversa],
    );
    const { rows: nascidos } = await pool.query<{ source_metadata: Record<string, unknown> }>(
      "select source_metadata from crm_leads where id = $1",
      [rows[0]!.id],
    );
    expect(nascidos[0]!.source_metadata).not.toHaveProperty("meta_capi_lead_birth_v1");
  });

  it("grava apenas o ctwa_clid da mensagem atual e emite lead.created canônico", async () => {
    const contato = await criarContato("Causal");
    const entrada = await criarEntrada(contato, "causal");
    const resultado = await garantirLeadDaConversa(
      db,
      dadosDoNascimento(contato, entrada, "CTWA_DA_MENSAGEM_ATUAL"),
    );

    expect(resultado.criado).toBe(true);
    if (!resultado.criado) return;

    const { rows } = await pool.query<{
      created_at: string;
      source_metadata: Record<string, unknown>;
    }>("select created_at, source_metadata from crm_leads where id = $1", [resultado.leadId]);
    const prova = rows[0]!.source_metadata.meta_capi_lead_birth_v1 as Record<string, unknown>;
    expect(prova).toMatchObject({
      platform: "meta_ads",
      source_type: "ad",
      ctwa_clid: "CTWA_DA_MENSAGEM_ATUAL",
      message_id: entrada.mensagem,
      conversation_id: entrada.conversa,
    });
    expect(Number.isFinite(Date.parse(String(prova.captured_at)))).toBe(true);

    // Os campos antigos podem continuar no snapshot de UI/Purchase, mas não
    // substituem nem reescrevem a prova causal reservada.
    expect(rows[0]!.source_metadata).toMatchObject({
      ad_source_id: "CLICK_ANTIGO",
      source_id: "AMBIGUO",
      ad_id: "ANUNCIO",
    });

    const eventos = await pool.query<{
      entity_kind: string;
      entity_id: string;
      organization_id: string;
    }>(
      `select entity_kind, entity_id, organization_id
         from event_log
        where event_type = 'lead.created' and entity_id = $1`,
      [resultado.leadId],
    );
    expect(eventos.rows).toEqual([
      { entity_kind: "crm_lead", entity_id: resultado.leadId, organization_id: ORG },
    ]);
  });

  it("uma segunda entrada não regrava snapshot nem emite outro evento", async () => {
    const contato = await criarContato("Imutável");
    const primeiraEntrada = await criarEntrada(contato, "primeira");
    const segundaEntrada = await criarEntrada(contato, "segunda", primeiraEntrada.conversa);

    const primeiro = await garantirLeadDaConversa(
      db,
      dadosDoNascimento(contato, primeiraEntrada, "CTWA_PRIMEIRO"),
    );
    expect(primeiro.criado).toBe(true);
    if (!primeiro.criado) return;

    const segundo = await garantirLeadDaConversa(
      db,
      dadosDoNascimento(contato, segundaEntrada, "CTWA_SEGUNDO"),
    );
    expect(segundo).toMatchObject({ criado: false, motivo: "ja_existe" });

    const { rows } = await pool.query<{
      source_metadata: { meta_capi_lead_birth_v1: Record<string, unknown> };
      eventos: number;
    }>(
      `select l.source_metadata,
              (select count(*)::int from event_log e
                where e.event_type = 'lead.created' and e.entity_kind = 'crm_lead'
                  and e.entity_id = l.id) as eventos
         from crm_leads l where l.id = $1`,
      [primeiro.leadId],
    );
    expect(rows[0]!.source_metadata.meta_capi_lead_birth_v1).toMatchObject({
      ctwa_clid: "CTWA_PRIMEIRO",
      message_id: primeiraEntrada.mensagem,
    });
    expect(rows[0]!.eventos).toBe(1);
  });

  it("três workers concorrentes criam um lead e um evento", async () => {
    const contato = await criarContato("Concorrente");
    const entrada = await criarEntrada(contato, "concorrente");
    await Promise.all(Array.from({ length: 3 }, () => pool.query("select pg_sleep(0.05)")));

    const resultados = await Promise.all(
      Array.from({ length: 3 }, () =>
        garantirLeadDaConversa(db, dadosDoNascimento(contato, entrada, "CTWA_CONCORRENTE")),
      ),
    );
    expect(resultados.filter((r) => r.criado)).toHaveLength(1);

    const { rows } = await pool.query<{ leads: number; eventos: number }>(
      `select count(distinct l.id)::int as leads,
              count(distinct e.id)::int as eventos
         from crm_leads l
         left join event_log e on e.entity_id = l.id
          and e.event_type = 'lead.created' and e.entity_kind = 'crm_lead'
        where l.organization_id = $1 and l.contact_id = $2`,
      [ORG, contato],
    );
    expect(rows[0]).toEqual({ leads: 1, eventos: 1 });
  });

  it("mensagem de outro contato não autoriza o snapshot reservado", async () => {
    const contatoCausal = await criarContato("Dono da mensagem");
    const contatoDoLead = await criarContato("Outro contato");
    const entrada = await criarEntrada(contatoCausal, "cruzada");

    const resultado = await garantirLeadDaConversa(
      db,
      dadosDoNascimento(contatoDoLead, entrada, "CTWA_NAO_AUTORIZADO"),
    );
    expect(resultado.criado).toBe(true);
    if (!resultado.criado) return;

    const { rows } = await pool.query<{ source_metadata: Record<string, unknown> }>(
      "select source_metadata from crm_leads where id = $1",
      [resultado.leadId],
    );
    expect(rows[0]!.source_metadata).not.toHaveProperty("meta_capi_lead_birth_v1");
  });
});
