-- 5001 — Supervisor Comercial por IA (issues #2092 e #4088).
--
-- O Supervisor lê as conversas conduzidas por VENDEDOR HUMANO e mantém o CRM
-- em dia (etapa, campos, tags, tarefas, sinais do score) dentro de uma política
-- de autonomia escolhida pela organização. Ele NÃO tem caminho de envio de
-- mensagem: nenhuma destas tabelas é lida por emissor algum.
--
-- Quatro tabelas, e nenhuma duplica o que já existe:
--   supervisor_settings  — liga/desliga + política (jsonb validado por Zod em
--                          lib/supervisor/config.ts, a fonte única da forma).
--   supervisor_runs      — uma leitura de UMA janela de UMA conversa. É o
--                          cursor incremental (última mensagem analisada) e a
--                          evidência que o diagnóstico reaproveita.
--   supervisor_actions   — cada efeito decidido: aplicado, pendente de
--                          aprovação, recusado ou pulado — com antes/depois e
--                          citação. `dedup_key` único impede efeito em dobro.
--   supervisor_reports   — diagnósticos por período.
--
-- Os efeitos de verdade continuam nas tabelas do CRM (crm_leads, crm_tasks,
-- lead_checkpoints, lead_state, crm_lead_activities, api_audit_log).
--
-- RLS: leitura para manager+ da organização; escrita só pelo servidor (service
-- role, depois de `requireRole`), por isso nenhuma policy de escrita.
-- Nenhuma função nova em `public`.

create table if not exists public.supervisor_settings (
  organization_id uuid primary key references public.organizations(id) on delete cascade,
  enabled boolean not null default false,
  config jsonb not null default '{}'::jsonb,
  updated_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.supervisor_runs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  contact_id uuid not null references public.contacts(id) on delete cascade,
  lead_id uuid references public.crm_leads(id) on delete set null,
  pipeline_id uuid references public.crm_pipelines(id) on delete set null,
  owner_user_id uuid references auth.users(id) on delete set null,
  first_message_at timestamptz,
  last_message_at timestamptz not null,
  last_message_id uuid not null,
  messages_count integer not null default 0,
  human_messages_count integer not null default 0,
  status text not null,
  skip_reason text,
  summary text not null default '',
  analysis jsonb not null default '{}'::jsonb,
  llm_call_id uuid,
  created_at timestamptz not null default now(),
  constraint supervisor_runs_status_check
    check (status in ('analyzed','skipped','failed','ambiguous')),
  constraint supervisor_runs_janela_unica unique (organization_id, conversation_id, last_message_id)
);
create index if not exists supervisor_runs_cursor_idx
  on public.supervisor_runs (organization_id, conversation_id, last_message_at desc);
create index if not exists supervisor_runs_periodo_idx
  on public.supervisor_runs (organization_id, created_at desc);

create table if not exists public.supervisor_actions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  run_id uuid not null references public.supervisor_runs(id) on delete cascade,
  conversation_id uuid references public.conversations(id) on delete cascade,
  contact_id uuid references public.contacts(id) on delete cascade,
  lead_id uuid references public.crm_leads(id) on delete cascade,
  kind text not null,
  risk text not null,
  status text not null,
  before jsonb,
  after jsonb not null default '{}'::jsonb,
  reason text not null,
  evidence jsonb not null default '[]'::jsonb,
  dedup_key text not null,
  decided_by uuid references auth.users(id) on delete set null,
  decided_at timestamptz,
  result_detail text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint supervisor_actions_kind_check check (kind in (
    'move_stage','set_field','set_value','add_tag','remove_tag','create_task',
    'start_followup','update_qualification','record_signals','mark_won','mark_lost','resolve_lead')),
  constraint supervisor_actions_risk_check check (risk in ('baixo','condicional','critico')),
  constraint supervisor_actions_status_check check (status in (
    'applied','pending_approval','approved','rejected','skipped','failed','superseded')),
  constraint supervisor_actions_dedup unique (organization_id, dedup_key)
);
create index if not exists supervisor_actions_fila_idx
  on public.supervisor_actions (organization_id, status, created_at desc);
create index if not exists supervisor_actions_lead_idx
  on public.supervisor_actions (lead_id) where lead_id is not null;

create table if not exists public.supervisor_reports (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  period_from timestamptz not null,
  period_to timestamptz not null,
  scope jsonb not null default '{}'::jsonb,
  status text not null default 'done',
  conversations_eligible integer not null default 0,
  conversations_analyzed integer not null default 0,
  metrics jsonb not null default '{}'::jsonb,
  diagnosis jsonb not null default '{}'::jsonb,
  error text,
  recurring boolean not null default false,
  requested_by uuid references auth.users(id) on delete set null,
  llm_call_id uuid,
  created_at timestamptz not null default now(),
  constraint supervisor_reports_status_check check (status in ('done','failed','insufficient')),
  constraint supervisor_reports_periodo check (period_to > period_from)
);
create index if not exists supervisor_reports_org_idx
  on public.supervisor_reports (organization_id, created_at desc);

alter table public.supervisor_settings enable row level security;
alter table public.supervisor_runs enable row level security;
alter table public.supervisor_actions enable row level security;
alter table public.supervisor_reports enable row level security;

drop policy if exists tenant_isolation_supervisor_settings_select on public.supervisor_settings;
create policy tenant_isolation_supervisor_settings_select on public.supervisor_settings
  for select using (public.fn_role_at_least(organization_id, 'manager'));
drop policy if exists tenant_isolation_supervisor_runs_select on public.supervisor_runs;
create policy tenant_isolation_supervisor_runs_select on public.supervisor_runs
  for select using (public.fn_role_at_least(organization_id, 'manager'));
drop policy if exists tenant_isolation_supervisor_actions_select on public.supervisor_actions;
create policy tenant_isolation_supervisor_actions_select on public.supervisor_actions
  for select using (public.fn_role_at_least(organization_id, 'manager'));
drop policy if exists tenant_isolation_supervisor_reports_select on public.supervisor_reports;
create policy tenant_isolation_supervisor_reports_select on public.supervisor_reports
  for select using (public.fn_role_at_least(organization_id, 'manager'));

-- O default ACL do Supabase concede tudo a anon/authenticated em tabela nova
-- de `public`: tira-se tudo e devolve-se só a leitura (que a RLS ainda filtra).
revoke all on public.supervisor_settings, public.supervisor_runs,
  public.supervisor_actions, public.supervisor_reports from anon, authenticated;
grant select on public.supervisor_settings, public.supervisor_runs,
  public.supervisor_actions, public.supervisor_reports to authenticated;
