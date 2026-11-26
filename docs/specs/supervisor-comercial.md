# Supervisor Comercial por IA (Feature C) — issues #2092 e #4088

O Supervisor lê as conversas **conduzidas por vendedor humano** e mantém o CRM em dia
(etapa, campos, tags, tarefas, sinais do score) dentro de uma política de autonomia por
organização; e produz o diagnóstico comercial de um período. **Nunca envia mensagem.**

Destino (DoD 18): **núcleo, desligado por padrão.** Se nenhuma organização ligar, nada muda —
nenhum cron lê conversa de organização sem `supervisor_settings.enabled = true`.

## Fluxo (Pilar A)

```
cron supervisor-comercial (5 min)            POST /api/v1/supervisor/observe ("Analisar agora")
          └── rodadaDoSupervisor ─► observaOrganizacao(org, config)
                 ├─ conversas com silêncio ≥ N min e mensagem após o cursor (supervisor_runs)
                 ├─ claim da janela (unique org+conversa+última mensagem)
                 ├─ conduzida por humano? (sent_via user/external_device/crm, ou atribuída e não ai_handling)
                 ├─ negócios abertos do contato ─ 0: pula · 1: ele · >1: modelo com confiança ALTA,
                 │                                 escolha humana anterior, ou PENDÊNCIA resolve_lead
                 ├─ 1 chamada de modelo (ponto supervisor_observe) → objeto tipado (lib/supervisor/analise.ts)
                 ├─ verificaEvidencia: todo fato cita m<N> + trecho LITERAL, senão é descartado
                 ├─ decideAcoes (lib/supervisor/politica.ts): risco × modo × prova × decisão humana mais recente
                 └─ supervisor_actions (dedup_key único) → executor (trava pelo valor anterior)
                        move_stage   → crm_leads.stage_id + atividade stage_changed + emit_event lead.stage_changed
                        set_field    → crm_leads.custom_fields (tipo validado pelo campo do funil)
                        set_value    → crm_leads.value_cents
                        add/remove_tag → crm_leads.tags (só listas permitidas)
                        create_task  → crm_tasks (prazo só se combinado; senão "sem prazo")
                        start_followup → enrollFollowupFlow (fluxo publicado e configurado; opt-out vence)
                        update_qualification → lead_state.qualification (BANT)  ┐ recalculaScoreDoLead
                        record_signals → lead_checkpoints (compromissos/objeções)┘ (fórmula existente)
                        mark_won / mark_lost → encerraDemanda (aprovação por padrão)
                     + api_audit_log (supervisor.action_applied | action_approved) com antes/depois
```

## Política padrão (lib/supervisor/config.ts)

| Ação | Risco | Padrão |
|---|---|---|
| Etapa para frente, com critério e confiança alta | baixo | automático |
| Etapa para trás / sem critério / `requires_human` / confiança média | condicional | aprovação |
| Etapa de ganho/perda como "movimento" | — | nunca (só pelo desfecho) |
| Campo vazio | baixo | automático |
| Sobrescrever campo | condicional | aprovação (knob `sobrescrever_campos`) |
| Valor do negócio | condicional | aprovação |
| Tag da lista permitida / remover da lista removível | baixo / condicional | automático |
| Tarefa (dedup por título aberto) | baixo | automático |
| Qualificação BANT e sinais do score | baixo | automático |
| Iniciar fluxo de follow-up | condicional | aprovação |
| Ganho (`venda_comprovada`; `confirmacao_verbal` só se a org aceitar) | crítico | aprovação |
| Perda (motivo do vocabulário do funil obrigatório) | crítico | aprovação |

"Vou comprar" é `intencao_de_compra` e nunca vira ganho. Decisão humana posterior à evidência
vence: o Supervisor não desfaz o que o vendedor mudou depois da mensagem que o justificaria.

## Pilar B — diagnóstico (lib/supervisor/diagnostico.ts)

Universo elegível (conversas com mensagem de vendedor no período) × analisadas (`supervisor_runs`);
agregação pura das leituras já feitas (`metricas.ts`: problemas por conversa, aderência por critério,
desfechos, objeções recorrentes); números do CRM pelas réguas existentes (`fn_attendant_metrics`,
motivos de perda, tarefas atrasadas, faixas de score). Uma chamada de modelo (ponto
`supervisor_diagnose`) só para a interpretação. Sem leitura no período → `insufficient`, sem modelo.
Sem script cadastrado, a aderência é rotulada "boas práticas", nunca conformidade.
Recorrência: `relatorio_recorrente` semanal/mensal, gerado pelo mesmo cron.

## Demonstração reproduzível (ambiente local, dados sintéticos)

1. Funil "Vendas" com etapas Novo Lead → Qualificação → Proposta Enviada → Venda Ganha; campo
   personalizado `produto` (texto). Um contato com UM negócio em Qualificação.
2. Análise › Supervisor Comercial › Configuração: ligar, marcar o funil, critério em "Proposta
   Enviada" ("o vendedor enviou proposta com valor"), tag permitida "Proposta enviada". Salvar.
3. Conversa sintética (WhatsApp de teste, ou INSERT em `messages` com `sent_via='user'` para o
   vendedor e `direction='inbound'` para o cliente): necessidade → orçamento → proposta com valor →
   "me liga amanhã às 10h".
4. "Analisar agora" (ignora o silêncio) ou aguardar o cron.
5. Conferir: card em Proposta Enviada; `produto` preenchido; tarefa "Ligar…" com prazo; nota do
   negócio (score) com fatores; aba Atividade com as citações; aba Pendências com o que é crítico.
6. Auditoria: `/app/audit`, filtro `supervisor.action_applied`.
7. Diagnóstico: aba Diagnóstico › Últimos 7 dias › Gerar.
8. Nenhuma mensagem nova em `messages` com `sent_via` diferente do que o teste inseriu.

O mesmo roteiro roda automatizado, sem rede, em `lib/supervisor/observador.test.ts`.

## Limitações conhecidas

- Transcrição de áudio entra quando `messages.media_derived_text` existe; sem ela, a mensagem vira `[audio]`.
- A trava de `set_field`/tags é por releitura + comparação (janela pequena de corrida), não por
  UPDATE condicional em jsonb; `move_stage` e `set_value` são condicionais no próprio UPDATE.
- Funis com etapas sem critério cadastrado: o Supervisor só PROPÕE movimentos para elas.
- Grupos ficam de fora (`is_group`), como no resto do CRM.

## Efeitos indiretos (medidos na homologação de 2026-11-15)

O movimento de etapa e a tag aplicados SOZINHOS pelo Supervisor continuam emitindo
`lead.stage_changed` / `lead.tag_added` (timeline, métricas e conversões dependem do evento), mas
levam `metadata.sem_disparo_automatico = true` (`lib/event-log/sem-disparo.ts`). Os dois
consumidores que podem terminar em mensagem — o motor de regras (`lib/automation/engine.ts`) e o
gatilho de follow-up por etapa (`lib/followup/gatilho-etapa.handler.ts`) — pulam o evento marcado e
registram o motivo. Não leva a marca: ação aprovada por um gestor (decisão humana) e organização
que ligou `movimento_dispara_automacoes`. Ganho/perda passam por `encerraDemanda`, cujo `lead.won`
alimenta a medição de conversões — só acontece com aprovação, no padrão.

## Rodar a demonstração local (stack isolada, sem credencial real)

Os artefatos ficam FORA do repositório, em `~/feature-c-demo` (config do Supabase com
`project_id = deskcomm-feature-c-demo` e portas 563xx, `seed.sql`, `modelo-de-teste.mjs`, `demo.mjs`):

```bash
cd ~/feature-c-demo && npx supabase@2 start            # stack isolada
psql "$DB" -v ON_ERROR_STOP=1 -f supabase/baseline.sql   # do repo; DB=postgresql://postgres:postgres@127.0.0.1:56322/postgres
#   + extensões e chave de cifra como em .github/workflows/e2e.yml; bootstrap-owner.ts; seed.sql
node modelo-de-teste.mjs &                               # dublê determinístico do provedor (:56399)
pnpm e2e:build && pnpm exec next start -p 3111           # com o .env.e2e apontando para 56321
node demo.mjs                                            # 35 verificações pela tela + banco
```

⚠️ Não use `pnpm e2e:env` aqui: ele lê o `supabase status` do projeto do repositório
(`deskcomm-crm`, porta 54321) e apontaria a demo para a stack errada.
O modelo de teste valida o caminho do produto, não a qualidade de leitura de um modelo real.
