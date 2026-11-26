import { execFileSync } from "node:child_process";
import { beforeAll, describe, expect, it } from "vitest";

/**
 * Supervisor Comercial (migration 5001) — isolamento, gate de papel e as duas
 * constraints das quais a idempotência do Supervisor DEPENDE.
 *
 * As quatro tabelas guardam trechos de conversa de toda a equipe e decisões que
 * fecham negócio. A policy é só de leitura, para `manager`+ da própria
 * organização; a escrita é exclusiva do servidor (service role depois de
 * `requireRole`). Por isso ficam fora de `TABLES` (rls-isolation semeia um
 * `agent`, e o controle positivo falharia por ACERTO) e entram em
 * `PROVA_PROPRIA` apontando para cá.
 *
 * Todas as provas são por CONTAGEM depois do fato, nunca por mensagem de erro.
 */
const container = process.env.TEST_DB_CONTAINER;
if (!container) {
  throw new Error("TEST_DB_CONTAINER not set — rode esta suíte via `pnpm test:db` (scripts/test-db.sh)");
}
const containerName: string = container;

function psql(script: string, pararNoErro: boolean): string {
  return execFileSync(
    "docker",
    ["exec", "-i", containerName, "psql", "-U", "postgres", "-d", "postgres", "-v", `ON_ERROR_STOP=${pararNoErro ? 1 : 0}`, "-tA", "-f", "-"],
    { input: script, encoding: "utf8", stdio: ["pipe", "pipe", "ignore"] },
  ).trim();
}
const sql = (s: string) => psql(s, true);

function ultimoNumero(out: string): number {
  const last = out.split("\n").pop();
  if (last === undefined || !/^\d+$/.test(last)) throw new Error(`saída inesperada do psql: ${out}`);
  return Number(last);
}

function countAs(userId: string, countQuery: string): number {
  return ultimoNumero(
    sql(`
      set role authenticated;
      select set_config('request.jwt.claims', '{"sub":"${userId}"}', false);
      ${countQuery}
    `),
  );
}

const ORG_A = "5e5e5e5e-0000-4000-8000-00000000000a";
const ORG_B = "5e5e5e5e-0000-4000-8000-00000000000b";
const MANAGER_A = "5e5e5e5e-1111-4000-8000-00000000000a";
const AGENT_A = "5e5e5e5e-1111-4000-8000-00000000000c";
const VIEWER_A = "5e5e5e5e-1111-4000-8000-00000000000d";
const MANAGER_B = "5e5e5e5e-1111-4000-8000-00000000000b";
const TABELAS = ["supervisor_settings", "supervisor_runs", "supervisor_actions", "supervisor_reports"] as const;

beforeAll(() => {
  sql(`
    insert into auth.users (id, email) values
      ('${MANAGER_A}', 'sup-mgr-a@invariant.test'),
      ('${AGENT_A}',   'sup-agent-a@invariant.test'),
      ('${VIEWER_A}',  'sup-viewer-a@invariant.test'),
      ('${MANAGER_B}', 'sup-mgr-b@invariant.test')
      on conflict (id) do nothing;

    insert into public.organizations (id, slug, legal_name, display_name) values
      ('${ORG_A}', 'supervisor-inv-a', 'Supervisor Invariant A', 'Supervisor A'),
      ('${ORG_B}', 'supervisor-inv-b', 'Supervisor Invariant B', 'Supervisor B')
      on conflict (id) do nothing;

    insert into public.user_organizations (user_id, organization_id, role, accepted_at) values
      ('${MANAGER_A}', '${ORG_A}', 'manager', now()),
      ('${AGENT_A}',   '${ORG_A}', 'agent',   now()),
      ('${VIEWER_A}',  '${ORG_A}', 'viewer',  now()),
      ('${MANAGER_B}', '${ORG_B}', 'manager', now())
      on conflict do nothing;

    do $$
    declare o uuid; v_contact uuid; v_session uuid; v_conv uuid; v_run uuid;
    begin
      foreach o in array array['${ORG_A}'::uuid, '${ORG_B}'::uuid] loop
        if exists (select 1 from public.supervisor_runs where organization_id = o) then continue; end if;
        insert into public.contacts (organization_id, name) values (o, 'Contato Sintetico') returning id into v_contact;
        insert into public.channel_sessions (organization_id, waha_session_name, webhook_secret_encrypted)
          values (o, 'sup-inv-' || left(o::text, 13) || right(o::text, 1), '\\x00'::bytea) returning id into v_session;
        insert into public.conversations (organization_id, contact_id, channel_session_id)
          values (o, v_contact, v_session) returning id into v_conv;
        insert into public.supervisor_settings (organization_id, enabled) values (o, true)
          on conflict (organization_id) do nothing;
        insert into public.supervisor_runs
          (organization_id, conversation_id, contact_id, last_message_at, last_message_id, status, summary)
          values (o, v_conv, v_contact, now(), gen_random_uuid(), 'analyzed', 'cliente pediu proposta')
          returning id into v_run;
        insert into public.supervisor_actions
          (organization_id, run_id, conversation_id, contact_id, kind, risk, status, reason, dedup_key, evidence)
          values (o, v_run, v_conv, v_contact, 'create_task', 'baixo', 'applied', 'compromisso', 'inv:k1',
                  '[{"trecho":"me liga amanha"}]'::jsonb);
        insert into public.supervisor_reports (organization_id, period_from, period_to)
          values (o, now() - interval '7 days', now());
      end loop;
    end $$;
  `);
});

describe.each(TABELAS)("%s — isolamento e gate de papel", (tabela) => {
  it("manager lê as linhas da PRÓPRIA organização (controle positivo, dos dois lados)", () => {
    expect(countAs(MANAGER_A, `select count(*) from public.${tabela} where organization_id = '${ORG_A}';`)).toBeGreaterThan(0);
    expect(countAs(MANAGER_B, `select count(*) from public.${tabela} where organization_id = '${ORG_B}';`)).toBeGreaterThan(0);
  });

  it("manager lê ZERO da organização vizinha, com e sem filtro", () => {
    expect(countAs(MANAGER_A, `select count(*) from public.${tabela} where organization_id = '${ORG_B}';`)).toBe(0);
    const total = countAs(MANAGER_A, `select count(*) from public.${tabela};`);
    const proprias = countAs(MANAGER_A, `select count(*) from public.${tabela} where organization_id = '${ORG_A}';`);
    expect(total).toBe(proprias);
  });

  it("agent e viewer da própria organização não leem (trechos de conversa de toda a equipe)", () => {
    expect(countAs(AGENT_A, `select count(*) from public.${tabela};`)).toBe(0);
    expect(countAs(VIEWER_A, `select count(*) from public.${tabela};`)).toBe(0);
  });

  it("nem o manager ESCREVE direto: update e delete não alteram nada", () => {
    const antes = ultimoNumero(sql(`select count(*) from public.${tabela} where organization_id = '${ORG_A}';`));
    // Sem ON_ERROR_STOP: o `permission denied` é o resultado esperado; a prova
    // é a contagem como superusuário DEPOIS.
    psql(
      `
      set role authenticated;
      select set_config('request.jwt.claims', '{"sub":"${MANAGER_A}"}', false);
      delete from public.${tabela} where organization_id = '${ORG_A}';
      update public.${tabela} set organization_id = '${ORG_B}' where organization_id = '${ORG_A}';
    `,
      false,
    );
    const depois = ultimoNumero(sql(`select count(*) from public.${tabela} where organization_id = '${ORG_A}';`));
    expect(depois).toBe(antes);
  });

  it("anon não tem privilégio nenhum na tabela", () => {
    const n = ultimoNumero(
      sql(`select count(*) from information_schema.role_table_grants
            where table_schema = 'public' and table_name = '${tabela}' and grantee = 'anon';`),
    );
    expect(n).toBe(0);
  });

  it("authenticated só tem SELECT", () => {
    const privilegios = sql(`select coalesce(string_agg(privilege_type, ',' order by privilege_type), '')
                               from information_schema.role_table_grants
                              where table_schema = 'public' and table_name = '${tabela}' and grantee = 'authenticated';`);
    expect(privilegios).toBe("SELECT");
  });
});

describe("as constraints de que a idempotência do Supervisor depende", () => {
  it("a mesma ação (dedup_key) não entra duas vezes na mesma organização — e entra na vizinha", () => {
    const antes = ultimoNumero(sql(`select count(*) from public.supervisor_actions where dedup_key = 'inv:k1';`));
    expect(antes).toBe(2); // uma por organização: a chave é por tenant
    psql(
      `insert into public.supervisor_actions (organization_id, run_id, kind, risk, status, reason, dedup_key)
         select organization_id, id, 'create_task', 'baixo', 'applied', 'x', 'inv:k1'
           from public.supervisor_runs where organization_id = '${ORG_A}' limit 1;`,
      false,
    );
    expect(ultimoNumero(sql(`select count(*) from public.supervisor_actions where dedup_key = 'inv:k1';`))).toBe(2);
  });

  it("a mesma janela de conversa não é reivindicada duas vezes", () => {
    const antes = ultimoNumero(sql(`select count(*) from public.supervisor_runs where organization_id = '${ORG_A}';`));
    psql(
      `insert into public.supervisor_runs (organization_id, conversation_id, contact_id, last_message_at, last_message_id, status)
         select organization_id, conversation_id, contact_id, now(), last_message_id, 'analyzed'
           from public.supervisor_runs where organization_id = '${ORG_A}' limit 1;`,
      false,
    );
    expect(ultimoNumero(sql(`select count(*) from public.supervisor_runs where organization_id = '${ORG_A}';`))).toBe(antes);
  });

  it("não existe tipo de ação de ENVIO: o CHECK recusa", () => {
    psql(
      `insert into public.supervisor_actions (organization_id, run_id, kind, risk, status, reason, dedup_key)
         select organization_id, id, 'send_message', 'baixo', 'applied', 'x', 'inv:envio'
           from public.supervisor_runs where organization_id = '${ORG_A}' limit 1;`,
      false,
    );
    expect(ultimoNumero(sql(`select count(*) from public.supervisor_actions where dedup_key = 'inv:envio';`))).toBe(0);
  });
});
