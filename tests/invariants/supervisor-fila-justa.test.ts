import { execFileSync } from "node:child_process";
import { beforeAll, describe, expect, it } from "vitest";

/**
 * A fila do Supervisor no Postgres real (achado A da auditoria de 2026-11-25):
 * `public.fn_supervisor_conversas_pendentes` (migration 5001).
 *
 * O espelho em memória (lib/supervisor/testing/banco-em-memoria.ts) prova o
 * comportamento do observador; este arquivo prova que a FUNÇÃO faz a mesma
 * coisa no banco que o cliente instala: anti-join contra leituras concluídas,
 * reivindicação recente fora, reivindicação presa de volta, limite, isolamento
 * por organização e EXECUTE só para service_role.
 */
const container = process.env.TEST_DB_CONTAINER;
if (!container) {
  throw new Error("TEST_DB_CONTAINER not set — rode esta suíte via `pnpm test:db` (scripts/test-db.sh)");
}
const containerName: string = container;

function sql(script: string): string {
  return execFileSync(
    "docker",
    ["exec", "-i", containerName, "psql", "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-tA", "-f", "-"],
    { input: script, encoding: "utf8", stdio: ["pipe", "pipe", "ignore"] },
  ).trim();
}
const numero = (out: string) => Number(out.split("\n").pop());

const ORG_A = "5f5f5f5f-0000-4000-8000-00000000000a";
const ORG_B = "5f5f5f5f-0000-4000-8000-00000000000b";

/** Chama a função como o cron chama: service_role, horizonte de 14 dias, silêncio de 20 min. */
const pendentes = (org: string, limite: number, reclamarAntes = "now() - interval '15 minutes'") =>
  `select id from public.fn_supervisor_conversas_pendentes('${org}', now() - interval '14 days', now() - interval '20 minutes', ${reclamarAntes}, ${limite})`;

beforeAll(() => {
  sql(`
    insert into public.organizations (id, slug, legal_name, display_name) values
      ('${ORG_A}', 'fila-inv-a', 'Fila Invariant A', 'Fila A'),
      ('${ORG_B}', 'fila-inv-b', 'Fila Invariant B', 'Fila B')
      on conflict (id) do nothing;

    do $$
    declare o uuid; i int; v_contact uuid; v_session uuid; v_conv uuid; v_n int;
    begin
      foreach o in array array['${ORG_A}'::uuid, '${ORG_B}'::uuid] loop
        if exists (select 1 from public.conversations where organization_id = o) then continue; end if;
        insert into public.channel_sessions (organization_id, waha_session_name, webhook_secret_encrypted)
          values (o, 'fila-inv-' || right(o::text, 1), '\\x00'::bytea) returning id into v_session;
        v_n := case when o = '${ORG_A}'::uuid then 150 else 10 end;
        for i in 1..v_n loop
          insert into public.contacts (organization_id, name) values (o, 'Contato ' || i) returning id into v_contact;
          insert into public.conversations (organization_id, contact_id, channel_session_id, last_message_at)
            values (o, v_contact, v_session,
                    -- A: as 100 primeiras ficam há ~3 dias, as 50 seguintes há ~2 h
                    case when i <= 100 then now() - interval '3 days' + (i || ' minutes')::interval
                         else now() - interval '2 hours' + (i || ' seconds')::interval end)
            returning id into v_conv;
          -- A: as 100 antigas já foram lidas até a última mensagem
          if o = '${ORG_A}'::uuid and i <= 100 then
            insert into public.supervisor_runs (organization_id, conversation_id, contact_id, last_message_at, last_message_id, status)
              select o, v_conv, v_contact, c.last_message_at, gen_random_uuid(), 'analyzed'
                from public.conversations c where c.id = v_conv;
          end if;
        end loop;
      end loop;
    end $$;
  `);
});

describe("fn_supervisor_conversas_pendentes", () => {
  it("devolve só as 50 pendentes, mesmo com as 100 mais antigas já lidas", () => {
    expect(numero(sql(`select count(*) from (${pendentes(ORG_A, 1000)}) x;`))).toBe(50);
  });

  it("respeita o limite e começa pela mais antiga pendente", () => {
    expect(numero(sql(`select count(*) from (${pendentes(ORG_A, 20)}) x;`))).toBe(20);
    const primeira = sql(`select id from (${pendentes(ORG_A, 1)}) x;`);
    const maisAntigaPendente = sql(`
      select c.id from public.conversations c
       where c.organization_id = '${ORG_A}'
         and not exists (select 1 from public.supervisor_runs r where r.conversation_id = c.id)
       order by c.last_message_at, c.id limit 1;`);
    expect(primeira).toBe(maisAntigaPendente);
  });

  it("nunca devolve conversa de outra organização", () => {
    const deB = numero(
      sql(`select count(*) from (${pendentes(ORG_A, 1000)}) x join public.conversations c on c.id = x.id where c.organization_id <> '${ORG_A}';`),
    );
    expect(deB).toBe(0);
    expect(numero(sql(`select count(*) from (${pendentes(ORG_B, 1000)}) x;`))).toBe(10);
  });

  it("reivindicação recente sai da fila; presa (em_processamento antiga) volta; falha antiga volta", () => {
    const alvo = sql(`select id from (${pendentes(ORG_A, 1)}) x;`);
    // recente: em andamento agora
    sql(`
      insert into public.supervisor_runs (organization_id, conversation_id, contact_id, last_message_at, last_message_id, status, skip_reason)
        select organization_id, id, contact_id, last_message_at, gen_random_uuid(), 'skipped', 'em_processamento'
          from public.conversations where id = '${alvo}';`);
    expect(sql(`select count(*) from (${pendentes(ORG_A, 1000)}) x where id = '${alvo}';`)).toBe("0");
    // a mesma reivindicação vista 16 min depois: processo morto, volta para a fila
    expect(
      sql(`select count(*) from (${pendentes(ORG_A, 1000, "now() + interval '1 minute'")}) x where id = '${alvo}';`),
    ).toBe("1");
  });

  it("EXECUTE só para service_role (anon e authenticated recusados)", () => {
    const assinatura = "public.fn_supervisor_conversas_pendentes(uuid, timestamptz, timestamptz, timestamptz, integer)";
    expect(sql(`select has_function_privilege('anon', '${assinatura}', 'execute');`)).toBe("f");
    expect(sql(`select has_function_privilege('authenticated', '${assinatura}', 'execute');`)).toBe("f");
    expect(sql(`select has_function_privilege('service_role', '${assinatura}', 'execute');`)).toBe("t");
  });
});
