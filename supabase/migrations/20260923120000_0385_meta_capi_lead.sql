-- 0385 · Meta CAPI Lead: prova causal no nascimento e claim atômico no livro-razão.
--
-- O snapshot reservado só nasce aqui. A função confere que a mensagem inbound
-- pertence à mesma organização, contato e conversa antes de guardar ctwa_clid.
-- O evento canônico é emitido na mesma transação do INSERT; se o advisory lock
-- encontrar um lead aberto, retorna NULL antes de snapshot e evento.

drop function if exists public.fn_nascer_lead_da_conversa(
  uuid, uuid, uuid, uuid, text, text, jsonb, text[]
);

create or replace function public.fn_nascer_lead_da_conversa(
  p_org uuid,
  p_contact uuid,
  p_pipeline uuid,
  p_stage uuid,
  p_title text,
  p_source text,
  p_source_metadata jsonb default '{}'::jsonb,
  p_tags text[] default '{}'::text[],
  p_message uuid default null,
  p_conversation uuid default null,
  p_meta_ctwa_clid text default null
)
returns uuid
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_id uuid;
  v_metadata jsonb;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_org::text || ':' || p_contact::text, 0));

  select id into v_id
    from public.crm_leads
   where organization_id = p_org
     and contact_id = p_contact
     and status = 'open'
   limit 1;

  if v_id is not null then
    return null;
  end if;

  -- A chave reservada nunca é aceita do chamador. Ela é reconstruída somente
  -- depois de provar a mensagem causal desta entrada.
  v_metadata := coalesce(p_source_metadata, '{}'::jsonb) - 'meta_capi_lead_birth_v1';
  if nullif(btrim(p_meta_ctwa_clid), '') is not null
     and p_message is not null
     and p_conversation is not null
     and exists (
       select 1
         from public.messages m
        where m.id = p_message
          and m.organization_id = p_org
          and m.contact_id = p_contact
          and m.conversation_id = p_conversation
          and m.direction = 'inbound'
     ) then
    v_metadata := v_metadata || jsonb_build_object(
      'meta_capi_lead_birth_v1', jsonb_build_object(
        'platform', 'meta_ads',
        'source_type', 'ad',
        'ctwa_clid', btrim(p_meta_ctwa_clid),
        'message_id', p_message,
        'conversation_id', p_conversation,
        'captured_at', transaction_timestamp()
      )
    );
  end if;

  insert into public.crm_leads
    (organization_id, pipeline_id, stage_id, contact_id, title, source, source_metadata, tags)
  values
    (p_org, p_pipeline, p_stage, p_contact, p_title, p_source, v_metadata,
     coalesce(p_tags, '{}'::text[]))
  returning id into v_id;

  perform public.emit_event(
    'lead.created',
    'crm_lead',
    v_id,
    jsonb_build_object('pipeline_id', p_pipeline, 'stage_id', p_stage, 'title', p_title),
    jsonb_build_object('source', 'canal.ingest'),
    p_org
  );

  return v_id;
end;
$$;

revoke execute on function public.fn_nascer_lead_da_conversa(
  uuid, uuid, uuid, uuid, text, text, jsonb, text[], uuid, uuid, text
) from public, anon, authenticated;
grant execute on function public.fn_nascer_lead_da_conversa(
  uuid, uuid, uuid, uuid, text, text, jsonb, text[], uuid, uuid, text
) to service_role;

comment on function public.fn_nascer_lead_da_conversa(
  uuid, uuid, uuid, uuid, text, text, jsonb, text[], uuid, uuid, text
) is
  'Cria atomicamente o lead do ingest, o snapshot causal Meta CAPI Lead e o evento lead.created. Só aceita ctwa_clid quando a mensagem inbound pertence à mesma organização, contato e conversa; retorna NULL sem emitir quando já existe lead aberto.';

-- O ledger existente continua sendo a única fonte de idempotência. As colunas
-- são aditivas e compatíveis com todas as linhas Purchase já gravadas.
alter table public.ad_conversion_dispatches
  add column if not exists claim_token uuid,
  add column if not exists claimed_until timestamptz,
  add column if not exists attempt_count integer not null default 0;

comment on column public.ad_conversion_dispatches.claim_token is
  'Token opaco do worker que possui o envio. Settlement com token diferente não altera a linha.';
comment on column public.ad_conversion_dispatches.claimed_until is
  'Lease do envio. Expirada, outro worker pode retomar sem criar outra linha/evento.';

create or replace function public.fn_claim_ad_conversion_dispatch(
  p_org uuid,
  p_lead uuid,
  p_platform text,
  p_event_name text,
  p_event_id text,
  p_lease_seconds integer default 60
)
returns table(acquired boolean, token uuid, current_status text)
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_token uuid := gen_random_uuid();
  v_status text;
begin
  if not exists (
    select 1 from public.crm_leads
     where id = p_lead and organization_id = p_org
  ) then
    return query select false, null::uuid, 'lead_inexistente'::text;
    return;
  end if;

  insert into public.ad_conversion_dispatches (
    organization_id, lead_id, platform, event_name, status, reason, event_id,
    claim_token, claimed_until, attempt_count, attempted_at
  ) values (
    p_org, p_lead, p_platform, p_event_name, 'processing', null, p_event_id,
    v_token, clock_timestamp() + make_interval(secs => greatest(p_lease_seconds, 1)), 1, now()
  )
  on conflict (organization_id, lead_id, event_name) do update
    set platform = excluded.platform,
        event_id = excluded.event_id,
        status = 'processing',
        reason = null,
        detail = null,
        claim_token = v_token,
        claimed_until = clock_timestamp() + make_interval(secs => greatest(p_lease_seconds, 1)),
        attempt_count = public.ad_conversion_dispatches.attempt_count + 1,
        attempted_at = now()
  where public.ad_conversion_dispatches.status <> 'sent'
    and (
      public.ad_conversion_dispatches.status <> 'processing'
      or public.ad_conversion_dispatches.claimed_until is null
      or public.ad_conversion_dispatches.claimed_until <= clock_timestamp()
    )
  returning status into v_status;

  if found then
    return query select true, v_token, v_status;
    return;
  end if;

  select status into v_status
    from public.ad_conversion_dispatches
   where organization_id = p_org
     and lead_id = p_lead
     and event_name = p_event_name;
  return query select false, null::uuid, coalesce(v_status, 'indisponivel');
end;
$$;

create or replace function public.fn_settle_ad_conversion_dispatch(
  p_org uuid,
  p_lead uuid,
  p_event_name text,
  p_claim_token uuid,
  p_status text,
  p_reason text default null,
  p_detail text default null,
  p_value_cents bigint default null,
  p_currency text default null
)
returns boolean
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_updated integer;
begin
  if p_status not in ('sent', 'skipped', 'error') then
    raise exception 'invalid conversion settlement status: %', p_status;
  end if;

  update public.ad_conversion_dispatches
     set status = p_status,
         reason = p_reason,
         detail = p_detail,
         value_cents = p_value_cents,
         currency = p_currency,
         claim_token = null,
         claimed_until = null,
         attempted_at = now()
   where organization_id = p_org
     and lead_id = p_lead
     and event_name = p_event_name
     and status = 'processing'
     and claim_token = p_claim_token;
  get diagnostics v_updated = row_count;
  return v_updated = 1;
end;
$$;

create or replace function public.fn_release_ad_conversion_dispatch(
  p_org uuid,
  p_lead uuid,
  p_event_name text,
  p_claim_token uuid,
  p_detail text default null
)
returns boolean
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_updated integer;
begin
  update public.ad_conversion_dispatches
     set status = 'retry',
         reason = null,
         detail = p_detail,
         claim_token = null,
         claimed_until = null,
         attempted_at = now()
   where organization_id = p_org
     and lead_id = p_lead
     and event_name = p_event_name
     and status = 'processing'
     and claim_token = p_claim_token;
  get diagnostics v_updated = row_count;
  return v_updated = 1;
end;
$$;

create or replace function public.fn_record_ad_conversion_outcome(
  p_org uuid,
  p_lead uuid,
  p_platform text,
  p_event_name text,
  p_event_id text,
  p_status text,
  p_reason text default null,
  p_detail text default null,
  p_value_cents bigint default null,
  p_currency text default null
)
returns boolean
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_status text;
begin
  if p_status not in ('skipped', 'error') then
    raise exception 'invalid conversion outcome status: %', p_status;
  end if;

  insert into public.ad_conversion_dispatches (
    organization_id, lead_id, platform, event_name, status, reason, event_id,
    value_cents, currency, detail, attempted_at
  ) values (
    p_org, p_lead, p_platform, p_event_name, p_status, p_reason, p_event_id,
    p_value_cents, p_currency, p_detail, now()
  )
  on conflict (organization_id, lead_id, event_name) do update
    set platform = excluded.platform,
        event_id = excluded.event_id,
        status = excluded.status,
        reason = excluded.reason,
        value_cents = excluded.value_cents,
        currency = excluded.currency,
        detail = excluded.detail,
        claim_token = null,
        claimed_until = null,
        attempted_at = now()
  where public.ad_conversion_dispatches.status <> 'sent'
    and (
      public.ad_conversion_dispatches.status <> 'processing'
      or public.ad_conversion_dispatches.claimed_until is null
      or public.ad_conversion_dispatches.claimed_until <= clock_timestamp()
    )
  returning status into v_status;

  return found;
end;
$$;

revoke execute on function public.fn_claim_ad_conversion_dispatch(
  uuid, uuid, text, text, text, integer
) from public, anon, authenticated;
revoke execute on function public.fn_settle_ad_conversion_dispatch(
  uuid, uuid, text, uuid, text, text, text, bigint, text
) from public, anon, authenticated;
revoke execute on function public.fn_release_ad_conversion_dispatch(
  uuid, uuid, text, uuid, text
) from public, anon, authenticated;
revoke execute on function public.fn_record_ad_conversion_outcome(
  uuid, uuid, text, text, text, text, text, text, bigint, text
) from public, anon, authenticated;

grant execute on function public.fn_claim_ad_conversion_dispatch(
  uuid, uuid, text, text, text, integer
) to service_role;
grant execute on function public.fn_settle_ad_conversion_dispatch(
  uuid, uuid, text, uuid, text, text, text, bigint, text
) to service_role;
grant execute on function public.fn_release_ad_conversion_dispatch(
  uuid, uuid, text, uuid, text
) to service_role;
grant execute on function public.fn_record_ad_conversion_outcome(
  uuid, uuid, text, text, text, text, text, text, bigint, text
) to service_role;
