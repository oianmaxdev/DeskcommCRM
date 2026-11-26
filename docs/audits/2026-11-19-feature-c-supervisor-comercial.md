# Feature C — Supervisor Comercial por IA: relatório técnico para auditoria

> Data: 2026-11-19. Branch `feat/supervisor-comercial-ia` no fork `oianmaxdev/DeskcommCRM`.
> Documento de estado, escrito para auditoria independente. Cada afirmação diz se é
> **implementado**, **testado** (com o tipo de prova) ou **não comprovado**.
> A especificação funcional está em [`docs/specs/supervisor-comercial.md`](../specs/supervisor-comercial.md).

---

## 1. Estado do projeto

| Item | Valor |
|---|---|
| Branch | `feat/supervisor-comercial-ia` |
| Base (pai do commit da feature) | `3538380b9` — "Merge pull request #1412" do upstream `melgarafael/DeskcommCRM` |
| Relação com o upstream | a base é ancestral de `upstream/main`; em 2026-11-18 o upstream estava **12.561 commits à frente** (`448d24358`). A branch **não** foi atualizada com o upstream (decisão do dono: sem sincronização nesta etapa) |
| Tamanho da mudança | 69 arquivos, ~11,1 mil linhas adicionadas, 9 removidas — um único commit |
| Remotes | `origin` = `oianmaxdev/DeskcommCRM` (fork), `upstream` = `melgarafael/DeskcommCRM` |

Para reproduzir as medidas: `git rev-list --count 3538380b9..upstream/main` e `git show --stat HEAD`.

---

## 2. O que a Feature C faz (implementado)

O Supervisor Comercial lê as conversas de WhatsApp conduzidas por **vendedores humanos** e mantém o
CRM coerente com o que foi dito, com prova textual. **Ele nunca envia mensagem a cliente** — isso é
garantido em código (ver §3.7).

### 2.1 Operação automática do CRM (Pilar A)

Para cada conversa elegível, depois de um período de silêncio, uma chamada de IA lê a janela de mensagens
e devolve uma análise estruturada. Uma política determinística transforma a análise em ações:

| Ação (`supervisor_actions.kind`) | O que faz | Mecanismo existente reutilizado |
|---|---|---|
| `move_stage` | move o negócio de etapa | lock otimista + `emitLeadActivity` + evento `lead.stage_changed` |
| `set_field` | preenche campo personalizado | `custom_fields` + schema do funil (`pipeline.settings.fields`) |
| `set_value` | valor do negócio | `crm_leads.value_cents` |
| `add_tag` / `remove_tag` | tags, só das listas permitidas | `crm_leads.tags` |
| `create_task` | tarefa com prazo no fuso da empresa | `crm_tasks` |
| `update_qualification` / `record_signals` | BANT, compromissos e objeções | `lead_state.qualification`, `lead_checkpoints` |
| score | recalculado pela fórmula do produto, nunca pela IA | `recalculaScoreDoLead` (`lib/leads/score-writer.ts`) |
| `start_followup` | inscreve em fluxo de follow-up existente | `enrollFollowupFlow` |
| `mark_won` / `mark_lost` | desfecho (crítico) | `encerraDemanda` + motivos de perda da organização |
| `resolve_lead` | pendência para o gestor escolher o negócio quando a conversa tem vários abertos | — |

Cada tipo tem um **modo** configurável — `automatico`, `aprovacao` ou `desligado` — e um **risco**
(`baixo` / `condicional` / `critico`). Ganho e perda nascem em `aprovacao` por padrão.
Política: `decideAcoes` em `lib/supervisor/politica.ts:191`.

Garantias da política:
- **Evidência literal obrigatória.** Toda ação que muda o CRM cita a mensagem (`m4`) e um trecho
  copiado dela; `verificaEvidencia` confere o trecho contra a mensagem real (`lib/supervisor/analise.ts`).
  Sem prova, a ação é descartada.
- **A decisão humana posterior vence.** Se um humano mexeu no negócio depois da mensagem analisada, o
  Supervisor não sobrescreve.
- **Deduplicação** por `supervisor_actions.dedup_key` (único por organização).
- **Ganho automático exige o nível de prova configurado** (`ganho_exige`: `venda_comprovada` — padrão —
  ou `confirmacao_verbal`). O modelo distingue intenção, promessa de pagamento, confirmação verbal e venda
  comprovada; intenção e promessa nunca bastam.
- **Movimentos automáticos não disparam automações nem follow-ups de etapa** por padrão: o evento sai com
  o marcador `sem_disparo_automatico` (`lib/event-log/sem-disparo.ts`), respeitado por
  `lib/automation/engine.ts` e `lib/followup/gatilho-etapa.handler.ts`. O evento continua sendo
  emitido (auditoria e timeline intactas); há uma chave na configuração para liberar o disparo.

### 2.2 Aprovações (aba Pendências)

Ações em modo `aprovacao` ficam com `status = pending_approval`. Um gestor (papel `manager`+) aprova ou
recusa em `POST /api/v1/supervisor/actions/[id]`; ao aprovar, a ação é executada pelo mesmo executor
(`executaAcao`, `lib/supervisor/executor.ts:119`) e auditada com o gestor como ator.
Quando a conversa tem mais de um negócio aberto e o modelo não soube dizer qual, a pendência pede ao
gestor que escolha o negócio.

### 2.3 Atividade (aba Atividade)

Diário cronológico das ações **efetivamente realizadas** (`applied` ou `approved`), agrupado por dia,
com título em linguagem natural ("Moveu o negócio: Sandália nude"), hora no fuso da empresa, contexto,
evidências recolhidas e, desde 2026-11-18, **links para o card do negócio no funil**
(`/app/pipelines/{funil}?lead={id}`) **e para a conversa no Inbox** (`/app/inbox?id={conversa}`).
Montagem: `montaDiario` em `lib/supervisor/diario.ts:150`. Sem dado novo: lê `supervisor_actions`.

### 2.4 Diagnóstico comercial (Pilar B)

Gerado sob demanda (botão "Gerar diagnóstico") ou recorrente. Período: últimos 7/30 dias ou intervalo;
filtro por vendedor. Fluxo em `geraDiagnostico` (`lib/supervisor/diagnostico.ts:347`):

1. **Métricas determinísticas** a partir das leituras já gravadas (`supervisor_runs.analysis`) —
   falhas por categoria, aderência a cada critério com o **denominador próprio** (só os atendimentos
   em que o critério se aplicava), desfechos, motivos de perda, tarefas vencidas e faixas de score
   (`agregaLeituras`, `lib/supervisor/metricas.ts:41`).
2. **Dossiês por atendimento** e **pré-agrupamento** por categoria + estágio da negociação
   (`montaDossies` e `preAgrupa`, `lib/supervisor/casos.ts`).
3. **Chamada 1 de IA — interpretação geral:** resumo executivo, gargalos, pontos positivos, riscos,
   recomendações priorizadas com indicador, limitações, refinamento contextual dos grupos e seleção
   de até 5 estudos de caso.
4. **Chamada 2 de IA — redação dos casos:** contexto, o que foi positivo, o que faltou, como melhorar
   (com exemplo de mensagem), follow-up sugerido, resumo e limitação.
5. **Validação determinística** do que o modelo devolveu (`validaGrupos`, `validaSelecao`): o modelo só
   pode reagrupar **dentro** da cerca categoria + estágio; no máximo 5 casos, um por atendimento e um
   por grupo; a recorrência é contada pelo código (membros do grupo − 1), não pelo modelo
   ("Essa situação se repetiu em mais N atendimentos analisados no período.").
6. Se qualquer chamada falha, o relatório é gravado com **reserva determinística** e marcado
   `completo: false`; a tela e o PDF mostram o aviso "Análise consultiva incompleta…"
   (`avisoDeIncompleto`, `lib/supervisor/relatorio-tipos.ts:98`).

**Contexto do nicho:** o "O que vocês fazem?" do onboarding (`organizations.onboarding_state`) entra nos
prompts; a prioridade é script da empresa > o que a empresa diz fazer > boas práticas do ramo > critérios
gerais.

**Regras de julgamento** (prompts de leitura e diagnóstico, e no código onde é mensurável):
responder preço não é falha — a falha é `preco_sem_agregar_valor`; não concluir "não investigou" sem
considerar o histórico do CRM; `sem_proximo_passo` (nada combinado) ≠ `compromisso_nao_cumprido`
(combinado e vencido); falta de follow-up antes de 24 h da última mensagem, ou com retorno já
programado, não é falha (filtro em código em `casos.ts`); agilidade só é julgada com os horários no
**fuso da empresa** (as mensagens entram no prompt em hora local com dia da semana — `horaLocal`,
`lib/supervisor/prompt.ts:63`).

**Rótulos internos** (`c1`, `c2`…) que o modelo usa para se orientar são removidos de todo texto de
leitura, na gravação e na exibição (`semReferenciaInterna` / `limparDiagnostico`,
`lib/supervisor/relatorio-tipos.ts:117` e `:131`).

### 2.5 Exportação em PDF

`GET /api/v1/supervisor/reports/[id]/pdf` renderiza o relatório **já gravado** com
`@react-pdf/renderer` (`renderizaDiagnosticoEmPdf`, `lib/supervisor/relatorio-pdf.tsx:364`).
**Não faz chamada de IA.** Há uma versão "Resumo" e a detalhada, e a opção "Sem identificar os
negócios" (anonimização dos títulos na exportação).

### 2.6 Escolha do modelo de IA

Na aba Configuração, o cartão "Modelo de IA do Supervisor" escolhe **provedor e modelo**, como no editor
de agente. Só aparecem provedores com credencial **ativa e validada** da organização, mais a conta
ChatGPT conectada. A escolha é gravada como vínculo por ponto (`ai_purpose_bindings`) nos dois pontos do
Supervisor (`supervisor_observe`, `supervisor_diagnose`) **pela rota existente** `PUT /api/v1/ai/providers`
(mesma validação e auditoria da tela de Provedores). "Automático" desliga o vínculo.
Leitura das opções: `lerModeloDoSupervisor`, `lib/supervisor/escolha-de-modelo.ts:48`.
Resolução: `resolverModeloDoSupervisor`, `lib/supervisor/modelo.ts:45` — escolha explícita vence; se
não puder ser cumprida, o Supervisor para com "sem modelo" em vez de trocar de modelo em silêncio.

### 2.7 Conta ChatGPT por assinatura (porte do upstream)

Porte **enxuto** do recurso #1639 do upstream (Sign in with ChatGPT por PKCE, com o endereço de retorno
colado na tela), feito para permitir testar o Supervisor sem chave de API. Usado **somente pelo
Supervisor**. Detalhes e diferenças em §5.2.

---

## 3. Funcionamento técnico

### 3.1 Mapa de componentes

| Camada | Arquivo | Papel |
|---|---|---|
| Cron | `app/api/v1/cron/supervisor-comercial/route.ts` | a cada 5 min (`docker/scheduler/entrypoint.sh`), autenticado por `INTERNAL_SECRET`; roda `rodadaDoSupervisor` para as organizações com o Supervisor ligado e os diagnósticos recorrentes vencidos |
| Observação | `lib/supervisor/observador.ts` | `observaOrganizacao` (`:218`): escolhe conversas, reivindica a janela, monta prompt, chama o modelo, verifica evidência, decide e executa ações |
| Prompt | `lib/supervisor/prompt.ts` | `SYSTEM_PROMPT_SUPERVISOR`, `montaPrompt` — mensagens como DADO entre delimitadores, papel de quem falou anotado pelo sistema |
| Schema da análise | `lib/supervisor/analise.ts` | `analiseSchema` (Zod), vocabulário de problemas e estágios |
| Política | `lib/supervisor/politica.ts` | `decideAcoes` — determinística, testada isoladamente |
| Executor | `lib/supervisor/executor.ts` | `executaAcao` / `concluiAcao` — escreve no CRM pelos mecanismos existentes |
| Configuração | `lib/supervisor/config.ts` | `supervisorConfigSchema` (estrito), `lerConfig`, critérios padrão |
| Diagnóstico | `lib/supervisor/{diagnostico,casos,metricas,periodo}.ts` | Pilar B |
| Relatório | `lib/supervisor/{relatorio-tipos,relatorio-pdf}.ts(x)`, `diario.ts` | tela e PDF |
| Modelo | `lib/supervisor/{modelo,escolha-de-modelo}.ts` | qual modelo usar |
| Pool Postgres | `lib/supervisor/pool.ts` | conexão `pg` para o recálculo de score |
| UI | `app/app/analise/supervisor/{page,_client}.tsx` | abas Atividade, Pendências, Diagnóstico, Configuração |

### 3.2 Processamento de uma conversa (`observaOrganizacao`)

1. Seleciona conversas **não-grupo** cuja última mensagem tem mais de `silencio_minutos` (padrão 20) e
   menos de 14 dias, até `max_conversas_por_rodada × 5` candidatas (padrão 20 por rodada).
2. Pula conversa conduzida pela IA (`status = ai_handling`) — o Supervisor só supervisiona humanos.
3. **Reivindica a janela**: insere em `supervisor_runs` com `unique (organization_id, conversation_id,
   last_message_id)`; colisão `23505` = outra rodada já leu. Reivindicação presa (`failed` ou
   `em_processamento`) é liberada após 15 min (`RECLAMAR_APOS_MS`).
4. Janela de até 80 mensagens (60 na primeira leitura), resumo e sinais anteriores do CRM, etapas com
   critérios, campos, tags permitidas, motivos de perda, critérios de atendimento, fuso e nicho.
5. Chamada de IA com `generateObject` + `analiseSchema`; a chamada é registrada em `llm_calls`
   (custo, tokens, latência). Orçamento esgotado (`getBudgetStatus`) interrompe a rodada.
6. Evidência verificada → política → executor → auditoria.

### 3.3 Chamadas de IA

| Ponto (`lib/ai/pontos/registro.ts`) | Quando | Saída |
|---|---|---|
| `supervisor_observe` | 1 por conversa elegível com mensagem nova | `analiseSchema` |
| `supervisor_diagnose` | 2 por diagnóstico (interpretação + redação dos casos) | `diagnosticoSchema`, `casosSchema` |

Limites: até 150 fichas de atendimento no prompt do diagnóstico, até 40 mensagens por caso, teto de
240 s por chamada de diagnóstico (`maxDuration = 300` na rota).

### 3.4 Banco e migration

Migration `supabase/migrations/20261113120000_0381_supervisor_comercial.sql`, refletida no apêndice
idempotente de `supabase/baseline.sql` e registrada em `supabase/migrations/MANIFEST.md`.

| Tabela | Conteúdo | Unicidade |
|---|---|---|
| `supervisor_settings` | ligado/desligado + `config` jsonb (validado por Zod) | PK `organization_id` |
| `supervisor_runs` | uma leitura por janela de conversa: análise, modelo, status | `(organization_id, conversation_id, last_message_id)` |
| `supervisor_actions` | ação planejada/realizada, antes/depois, evidência, risco, status | `(organization_id, dedup_key)` |
| `supervisor_reports` | diagnóstico gravado (métricas + `diagnosis` jsonb) | — |

- `organization_id ... references organizations(id) on delete cascade` em todas; `type`/`status` são
  `text` + `CHECK`, não enum.
- **RLS**: só policy de **SELECT**, para `manager`+ da própria organização
  (`tenant_isolation_supervisor_*_select`, via `fn_role_at_least`). Nenhuma policy de escrita: toda
  escrita é pelo servidor com cliente admin, **filtrando `organization_id` manualmente**.
- `revoke all ... from anon, authenticated` + `grant select ... to authenticated`.
- Nenhuma função `security definer` nova.
- **LGPD**: a cascata de anonimização (`lib/lgpd/cascata.ts`) limpa leituras, ações e trechos de casos
  de relatório do contato anonimizado.

### 3.5 APIs

| Rota | Método | Papel mínimo |
|---|---|---|
| `/api/v1/supervisor/settings` | GET / PUT | manager / admin |
| `/api/v1/supervisor/actions` | GET | manager |
| `/api/v1/supervisor/actions/[id]` | POST (aprovar/recusar) | manager |
| `/api/v1/supervisor/observe` | POST (analisar agora) | admin |
| `/api/v1/supervisor/reports` | GET / POST | manager |
| `/api/v1/supervisor/reports/[id]/pdf` | GET | manager |
| `/api/v1/cron/supervisor-comercial` | GET / POST | segredo interno |
| `/api/v1/ai/providers` (existente) | PUT | admin — passou a aceitar `openai-assinatura` **só** nos pontos do Supervisor |

Respostas com `ok()` / `fail()`; entradas validadas por Zod; referências (funil, etapa, fluxo) conferidas
contra a organização ativa (id de outra organização → 422).

### 3.6 Auditoria

Ações em `lib/audit/actions.ts`: `supervisor.settings_updated`, `supervisor.action_applied`,
`supervisor.action_approved`, `supervisor.action_rejected`, `supervisor.report_generated`,
`supervisor.observe_requested` e `ai.login_codex_conectado` / `ai.login_codex_desconectado`. A troca de modelo é
auditada pela rota de Provedores (`ai.purpose_binding_updated`). Rodada de cron sem efeito não audita
(doutrina do repositório).

### 3.7 "Nunca fala com o cliente" — como é garantido

- O executor não importa nenhum caminho de envio. `lib/supervisor/sem-caminho-de-envio.test.ts` varre os
  imports do módulo e reprova qualquer dependência de envio (WAHA, fila de saída, envio de mensagem).
- Follow-ups são só **inscritos** em fluxos existentes (que têm suas próprias regras de horário e
  anti-banimento) e, por padrão, exigem aprovação.

### 3.8 Interface

Página `app/app/analise/supervisor/page.tsx` (porta no menu Análise › Supervisor Comercial,
`lib/navigation/catalogo.ts`, `minRole: manager`). Textos passam por `t()` com espanhol em
`lib/i18n/dicionario.ts`.

---

## 4. Experiência do usuário

1. **Conectar uma IA.** Agente de IA › Credenciais: chave de API (Anthropic, OpenAI, Gemini…) ou
   "Entrar com o ChatGPT" (conta da assinatura).
2. **Configurar.** Análise › Supervisor Comercial › Configuração:
   - **Modelo de IA do Supervisor** — provedor e modelo, ou Automático;
   - ligar o Supervisor e escolher os funis monitorados;
   - modo de cada tipo de ação (automático, pede aprovação, desligado);
   - nível de prova para "ganho", troca de valor já preenchido, disparo de automações por etapa;
   - minutos de silêncio antes de ler, máximo de conversas por rodada;
   - script comercial e critérios de atendimento; tags permitidas e removíveis; fluxo de follow-up;
   - diagnóstico recorrente;
   - botão "Analisar agora" (admin).
3. **Acompanhar.** Aba Atividade (o que foi feito, com links para o card e o Inbox) e aba Pendências
   (aprovar/recusar, escolher o negócio quando ambíguo, motivo de perda).
4. **Diagnóstico.** Aba Diagnóstico: período, vendedor, "Gerar diagnóstico"; leitura na tela; "Baixar
   PDF" e "Resumo em PDF"; opção de não identificar os negócios.

---

## 5. Decisões arquiteturais

### 5.1 Reutilizado do Deskcomm

`resolveActiveLeadForContact`; movimentação com lock otimista, `emitLeadActivity` e `emit_event`;
`encerraDemanda`; `enrollFollowupFlow`; `recalculaScoreDoLead` (fórmula, não IA); `resolverModeloDoPonto`,
`ai_purpose_bindings` e a rota de Provedores; `llm_calls` e `getBudgetStatus`; `fn_attendant_metrics`;
`audit()`; `fn_user_org_ids` / `fn_role_at_least` nas policies; `traduzir` / `useT`; `useTeamMembers`;
catálogo de navegação; `event_log` + scheduler para o cron; `@react-pdf/renderer` já usado no PDF de LGPD.

### 5.2 Desenvolvido

- Todo `lib/supervisor/` (observação, política, executor, diagnóstico, PDF, diário, escolha de modelo).
- `lib/event-log/sem-disparo.ts` e a checagem nos dois consumidores.
- **Porte enxuto da assinatura do ChatGPT** (`lib/ai/pontos/pkce-da-assinatura.ts` — copiado do
  upstream —, `lib/ai/credenciais/login-codex.ts`, `lib/ai/credenciais/modelo-da-assinatura.ts`,
  `app/actions/settings/conectarLoginCodex.ts`,
  `app/app/ai/credentials/_components/PainelDeLoginCodex.tsx`). Diferenças conscientes em relação ao
  upstream:
  - só o Supervisor usa a assinatura; `settings.llm.provider` da organização não é alterado;
  - não há o interruptor de módulo da instalação nem o aviso de "assinatura desconectada";
  - a identidade do `id_token` é conferida por emissor, audiência e nonce, **sem verificar a assinatura
    contra o JWKS** (o token chega direto do endpoint de token da OpenAI, por TLS, em troca do código +
    verificador PKCE). O upstream verifica com JWKS;
  - o identificador da instalação para o SIWC é derivado do `INTERNAL_SECRET`, em vez de uma tabela;
  - a inferência pela assinatura exige streaming, `store: false` e nenhum parâmetro de amostragem: em vez
    de mudar o motor, um middleware no modelo converte `generateObject` em streaming
    (`middlewareDaAssinatura`).
  Os caminhos de arquivo são os do upstream **de propósito**: na integração, estes arquivos devem ser
  **substituídos** pelos do upstream, e `lib/supervisor/modelo.ts` adaptado à API de lá.

---

## 6. Testes e homologação

### 6.1 Gates desta branch

Ver §6.4: typecheck, lint, `test:unit` e `test:db` passaram no código deste commit; `test:e2e` e
`test:shell` não foram executados.

### 6.2 Homologação com modelo real (`gpt-5.6-luna` pela assinatura ChatGPT)

Ambiente isolado: Supabase local (stack própria, portas 563xx) com `baseline.sql`, `next build` +
`next start`, dados **sintéticos** em duas organizações de nichos diferentes (moda: 8 conversas; agência de
sites: 5 conversas). Critérios esperados escritos **antes** da execução. Trava no script: qualquer chamada
com modelo diferente de `gpt-5.6-luna` interrompia a homologação; nenhuma tentativa repetida após falha.

| | Pixel Digital (sites) | Visual Moda |
|---|---|---|
| Leituras | 5/5 ok, ~41 s cada | 7 ok (1 conversa fora: dado sintético inconsistente, ver §7) |
| Diagnóstico | 2/2 chamadas ok, `completo: true`, ~2 min | 2/2 ok, `completo: true`, 108 s |
| Custo equivalente de API | US$ 0,07 | US$ 0,09 |
| Conferências | aprovadas, exceto S1 (abaixo) | 20/21 (a que falhou é a conversa fora) |

Comprovado com o modelo real:
- preço respondido **com** valor não virou falha (M4); preço **sem** valor virou (M1–M3, S2, S5);
- resposta de madrugada no domingo respondida segunda às 9h05 não virou demora (M8);
- M1, M2 e M3 caíram no **mesmo grupo** de preço, e a visita (M5) nunca entrou nele;
- recorrência com contagem exata ("mais 2", "mais 1");
- ≤ 5 casos, um por atendimento; resumo executivo, recomendações priorizadas com indicador, pontos
  positivos, riscos e limitações preenchidos; "como melhorar" com exemplo de mensagem e follow-up;
- PDF de 10 páginas sem rótulos internos e sem termos de outro nicho; baixado sem nova chamada de IA.

### 6.3 Bugs encontrados na homologação e corrigidos

- Assinatura recusava `generateObject` (400): middleware de streaming.
- Rótulos internos `c1`/`c3` no resumo e nos pontos positivos: regra no prompt + limpeza em código.
- Modelo padrão do Anthropic numa organização que só tinha credencial Google: degrau de modelo padrão
  do provedor conectado (`lib/supervisor/modelo.ts`).
- Mensagens chegavam ao modelo em UTC: hora local com dia da semana.
- Título do negócio (dado pessoal) enviado ao modelo quando havia um só negócio: título genérico.
- Rodapé fixo do PDF não renderizava: âncora `top` em vez de `bottom`.
- Movimento pendente de "ganho" travava a mudança de etapa: desfecho só conta quando aplicado.

Na revisão para esta auditoria (2026-11-19), a suíte completa apontou duas violações de guardas do
repositório causadas pela Feature C, corrigidas sem mudar funcionalidade:
- `tests/unit/i18n-a-data-segue-o-idioma.test.ts` — datas da aba Atividade e do Diagnóstico estavam em
  `pt-BR` fixo; agora seguem o idioma de quem lê (`useTagDeIdioma()` → `dataHora` / `montaDiario`,
  `lib/supervisor/diario.ts`). O prompt (lido pelo modelo) e o PDF (texto gerado em português) entraram
  na lista de exceções do guarda, com o motivo.
- `tests/unit/rotulo-do-contato.test.ts` — `display_name || model_id` em `escolha-de-modelo.ts` é nome
  de **modelo**, não de contato; registrado em `LEITURAS_LEGITIMAS`, como o guarda instrui.

### 6.4 Resultado dos gates

Rodada de 2026-11-19, no código deste commit (máquina local, WSL2, Node 22). Logs fora do repositório.

| Gate | Comando | Resultado |
|---|---|---|
| typecheck | `pnpm typecheck` | **passou** (exit 0) |
| lint | `pnpm lint` | **passou** — 0 erros, 416 avisos (pré-existentes no repositório) |
| unit (suíte inteira) | `pnpm test:unit` | **passou** — 1.248 arquivos, 12.509 testes, 1 falha esperada (exit 0) |
| banco | `pnpm test:db` | **passou** — 255 arquivos, 2.161 testes (baseline install + update, invariantes, RLS entre 2 organizações, RLS das 4 tabelas novas em `tests/invariants/supervisor-comercial-rls.test.ts`) |
| e2e | `pnpm test:e2e` | **não executado** — não há spec do Supervisor; a prova pela tela foi feita com scripts Playwright fora do repositório |
| shell / kit | `pnpm test:shell` | **não executado** — a única mudança de kit é uma linha no agendador |
| build | `next build` | **passou** nas recompilações da demo (sem medição de tamanho de bundle) |

A primeira rodada de `pnpm test:unit` do dia terminou com 27 falhas e 16 erros. Rodados sozinhos, 18 dos
21 arquivos passaram (timeouts de 15 s e do pool de workers sob carga); os 3 restantes eram 1 timeout e as
duas violações de guarda descritas em §6.3, corrigidas antes da rodada registrada acima.

---

## 7. Limitações e riscos conhecidos

**Comportamento do modelo (observado com `gpt-5.6-luna`):**
- **Falha por ausência é descartada.** "Ninguém confirmou a visita" (M5) não tem frase a citar; o modelo
  devolveu o achado sem evidência e a verificação o descartou. A regra "nada sem prova" protege contra
  alucinação, mas cega o Supervisor para omissões. Não resolvido.
- **Erro de conta de horas no texto.** Em S1 o modelo escreveu "mais de 24 horas depois" de uma chamada
  que tinha passado havia ~17 h. A regra de 24 h em código (contada da última mensagem) não foi
  violada; o texto, sim.
- **Seleção dos casos** pode não destacar o grupo mais recorrente: na moda, o grupo de preço (3
  atendimentos) apareceu dentro do caso, mas o caso principal foi "oferta sem ação definida".
- **Regra "objeção com menos de 24 h não é falha" não testada com modelo real**: a conversa M7 tinha
  `last_message_at` no futuro no seed sintético e foi corretamente ignorada.

**Provedores:**
- Só `gpt-5.6-luna` (assinatura) foi homologado com modelo real. Gemini ficou sem cota durante todos os
  testes; Anthropic e OpenAI por chave **não foram testados com modelo real**.
- Uso da assinatura do ChatGPT para carga automática de servidor: o próprio upstream recomenda chave de
  API para operação em volume; limites e termos da assinatura são risco do operador.

**Custos e escala:**
- 1 chamada por conversa com mensagem nova depois do silêncio; ~US$ 0,01 por leitura e ~US$ 0,02 por
  diagnóstico com Luna (equivalente de API, amostra pequena).
- Testado com no máximo 8 conversas por organização. **Não há medição** com centenas de conversas por
  rodada, nem do diagnóstico perto do teto de 150 fichas.
- O cron processa as organizações em sequência dentro de `maxDuration = 300` s.

**Integração com o upstream:**
- **Colisão de número de migration**: `0381` já existe no upstream (`0381_meta_ads_captura_de_utm`).
  A migration precisa ser renumerada (NNNN e timestamp juntos) na integração. Não foi renumerada nesta
  etapa por decisão do dono do produto. **O commit desta branch foi feito com o desvio documentado do
  hook (`DESKCOMM_MIGRATION_EDIT=1`) — ver §8.**
- Branch 12.561 commits atrás do upstream: integração vai exigir merge grande; conflitos esperados no
  `baseline.sql`, no `MANIFEST.md`, no dicionário de i18n, no catálogo de navegação e nos arquivos da
  assinatura (que existem no upstream com outra implementação).
- O upstream tem `experiments/extensoes/probe-supervisor*` — sem relação de código encontrada, mas o
  nome merece conferência.

**Idioma:** a interface do Supervisor tem espanhol nos textos e nas datas, mas "Hoje"/"Ontem"/"às" do
diário e o PDF inteiro continuam em português.

**Doutrina do repositório ainda não cumprida:**
- Sem spec Playwright do Supervisor em `tests/e2e/` (a prova pela tela foi feita com scripts fora do
  repositório).
- Mapa vivo em `docs/architecture/` sem a peça nova (DoD 13).
- Destino núcleo × extensão (DoD 18) não declarado formalmente: pela régua do repositório o Supervisor
  é **extensão** candidata (a operação comum continua inteira com ele desligado), mas foi feito no núcleo.

---

## 8. Prontidão para produção

**Pronto (implementado e testado):** leitura, política, executor, aprovações, diário, diagnóstico com
casos e recorrência, PDF, escolha de modelo, RLS das tabelas novas, auditoria, LGPD.

**Obrigatório antes de clientes reais:**
1. Renumerar a migration (NNNN + timestamp) contra o upstream do momento, atualizar baseline, MANIFEST e
   referências nos testes; rodar `pnpm checar:colisao-de-migration`.
2. Integrar com o upstream atual e **substituir** o porte da assinatura pela implementação do upstream.
3. `pnpm test:db` e `pnpm test:e2e` de novo **depois da integração com o upstream** (os resultados de
   §6.4 valem para a base `3538380b9`, não para o upstream atual).
4. Homologar com o provedor que o cliente vai usar (Anthropic/OpenAI por chave não testados).
5. Medir custo e tempo com volume real (centenas de conversas) e calibrar `max_conversas_por_rodada`
   e `silencio_minutos`.
6. Decidir o tratamento de falhas por ausência (M5).
7. Spec Playwright da jornada do Supervisor e atualização do mapa vivo.
8. Começar com ganho/perda/follow-up em "pede aprovação" (é o padrão) e o disparo de automações
   desligado (é o padrão).

**Não usar em produção antes dos itens 1–3.**
