# Feature A — LeadSubmitted por clique CTWA recebido

## Estado e decisão de produto

Esta implementação está na branch `feat/meta-lead-org-activation` do fork
[`oianmaxdev/DeskcommCRM`](https://github.com/oianmaxdev/DeskcommCRM). A lógica funcional homologada
é o commit [`4d76349977ed5196a90c00722c240ae4764af747`](https://github.com/oianmaxdev/DeskcommCRM/commit/4d76349977ed5196a90c00722c240ae4764af747).
O commit posterior [`c2aec0507c861e937de49f4fb4a229cecac0b38f`](https://github.com/oianmaxdev/DeskcommCRM/commit/c2aec0507c861e937de49f4fb4a229cecac0b38f)
altera somente o texto explicativo da chave na interface; não integrou a `main` oficial e não
foi o SHA usado nos testes sintéticos citados abaixo. A correção da marca própria e das traduções
foi realizada no commit [`e85f6abfb585f30d42259361503cc557f6113870`](https://github.com/oianmaxdev/DeskcommCRM/commit/e85f6abfb585f30d42259361503cc557f6113870):
o componente passou a dizer “o sistema”, com traduções em espanhol e inglês. Branding, i18n e
componente passaram em **73 testes dirigidos**, exit code 0.

**A Feature A termina na A1. A2 foi cancelada.** Purchase, QualifiedLead e MetaEtapa mantêm a
atribuição de primeiro toque. Este documento registra o comportamento do fork e a evidência
disponível; não anuncia instalação em produção nem aceite da Meta.

## Problema e regra funcional

Um contato pode voltar por anúncios Click-to-WhatsApp (CTWA) diferentes sem nascer outro card.
Vincular `LeadSubmitted` ao nascimento do lead perde esses novos cliques; criar um card por clique
duplicaria trabalho comercial. A A1 registra cada clique CTWA válido recebido numa mensagem
inbound e cria uma oportunidade de envio independente do card, preservando o primeiro toque.

- **Clique e abertura do WhatsApp não bastam.** A conversão depende de uma mensagem inbound
  efetivamente recebida com `ctwa_clid` confiável na evidência do canal.
- Novo contato, contato existente e contato com lead aberto podem produzir `LeadSubmitted` para
  **cliques diferentes**, sem gerar card adicional por causa do clique.
- O mesmo `ctwa_clid` na mesma organização identifica uma única oportunidade. Reentrega do
  webhook, mensagens posteriores, concorrência e retry não criam outro `event_id`.
- `source_id`/`ad_id` identifica o anúncio, **não** substitui `ctwa_clid`. Mensagem orgânica,
  origem `post` e prova causal fornecida pelo cliente não tornam o clique elegível. O parser
  atual também aceita `ctwa_clid` quando `sourceType` está ausente; essa compatibilidade foi
  coberta no E2E sintético, mas a origem CTWA real ainda precisa ser verificada.
- A chave por organização começa desligada. A captura usa o relógio do banco e guarda o instante
  da ativação; clique anterior à ativação, durante uma desativação ou de uma ativação anterior
  não é enviado após reativação. O consumidor confere a ativação antes de iniciar o POST. Uma
  chamada já iniciada pode terminar após o desligamento.

## Caminho da mensagem ao registro de envio

1. A entrada WAHA autentica o webhook pelo mecanismo configurado e deduplica a mensagem por
   `organization_id` e `external_id`. Os parsers em
   [`lib/waha/atribuicao-de-anuncio.ts`](../../lib/waha/atribuicao-de-anuncio.ts) e
   [`lib/channels/atribuicao-de-anuncio-oficial.ts`](../../lib/channels/atribuicao-de-anuncio-oficial.ts)
   distinguem `ctwa_clid` do ID do anúncio. A ingestão grava a âncora `meta_ctwa_message_v1`
   nos metadados da mensagem, conforme
   [`lib/leads/prova-meta-lead-submitted.ts`](../../lib/leads/prova-meta-lead-submitted.ts).
2. O trigger `trg_record_meta_ctwa_click`, criado pela
   [migration 0693](../../supabase/migrations/20261020130001_0693_meta_lead_por_clique.sql),
   insere `meta_ctwa_click_dispatches` **na transação da mensagem**. A linha preserva organização,
   contato, primeira mensagem, `ctwa_clid`, instante confiável, época de ativação e `event_id`.
   A identidade não pode ser reassociada por atualização. A unicidade por organização e
   `ctwa_clid` impede um segundo registro; a linha retém o ID da primeira mensagem mesmo se a
   conversa for excluída e é removida por cascata quando contato ou organização forem excluídos.
3. A mensagem emite `message.received` pelo mecanismo do banco. O dispatcher registra
   [`conversoes.clique_meta`](../../lib/conversoes/clique-meta.handler.ts), que busca a linha na
   organização, valida a ativação, faz claim por RPC e envia pelo
   [transporte Meta](../../lib/plataformas-de-anuncio/meta/conversions.ts). O consumidor legado
   de `lead.created` continua disponível para eventos anteriores e se abstém quando já existe a
   linha do clique; não há segundo emissor para o mesmo clique.
4. O `event_id` é `<id da linha>:LeadSubmitted`. Claim com token e lease, settlement e reenvio
   usam as RPCs `fn_claim_meta_ctwa_click`, `fn_settle_meta_ctwa_click` e
   `fn_solicitar_reenvio_meta_ctwa_click`. Falha transitória agenda retry com a mesma identidade.
   A função `fn_meta_ctwa_click_enviado_legado` consulta a prova histórica
   `meta_capi_lead_birth_v1` e impede reenviar um clique já marcado `sent` no ledger anterior.
5. O POST à Graph usa `/{dataset_id}/events`, `LeadSubmitted`, `action_source` de mensagem,
   `ctwa_clid` e a identidade estável. O transporte exige confirmação `events_received = 1`;
   isso comprova a resposta da API, não a atribuição da conversão a uma campanha. Com
   `test_event_code`, o ledger fica `skipped` (`evento_de_teste`), não `sent`.

A [migration 0617](../../supabase/migrations/20261009030000_0617_meta_lead_submitted_causal.sql)
introduziu a prova causal de nascimento e o ledger legado. A
[migration 0618](../../supabase/migrations/20261015010000_0618_ativacao_meta_lead_por_org.sql)
introduziu a ativação por organização. O [baseline](../../supabase/baseline.sql) contém os
apêndices idempotentes das três mudanças. A 0693 traz `-- manifest:` no próprio SQL, RLS ligada,
grants restritos a `service_role` e filtros explícitos de organização no consumidor. O
`supabase/migrations/MANIFEST.md` é histórico e, pela doutrina atual, **não recebe linha nova**.

## Configuração e operação

1. Em **Configurações → Conversões**, configure uma conexão direta Meta Ads da organização com
   dataset e credencial CAPI próprios. Para o evento de mensagem, a identidade da conta precisa
   fornecer `page_id` **ou** `whatsapp_business_account_id`. A captura precisa receber a
   evidência CTWA real pelo canal de WhatsApp.
2. Um administrador da organização ativa **Enviar LeadSubmitted por clique CTWA à Meta** na
   mesma tela. A [ação](../../app/actions/settings/definirLeadSubmittedCausal.ts) usa a
   organização da sessão, RBAC, MFA quando exigida, bloqueio de suporte somente leitura,
   [RPC com horário do banco](../../supabase/migrations/20261015010000_0618_ativacao_meta_lead_por_org.sql)
   e auditoria `conversions.meta_lead_birth_updated`. Desativar essa chave não desliga a conexão
   Meta nem os demais eventos.
3. A tela apresenta o [histórico dos cliques](../../lib/conversoes/historico-de-cliques.ts) e
   permite pedir reprocessamento autorizado. Verifique a situação no ledger e a resposta da
   Meta antes de considerar um envio concluído. Não use código de teste para contabilizar
   conversões reais.

O WAHA padrão do produto permanece inalterado. A exigência de assinatura foi ativada no
cenário causal de QA; não é uma mudança global de configuração de produção.

## Compatibilidade e limites

O ledger novo é exclusivo de `LeadSubmitted` por clique. Purchase, QualifiedLead, MetaEtapa e
Google Ads continuam nos consumidores e livros anteriores. A atribuição do contato e do card
permanece de primeiro toque; retries de conversões antigas não trocam esse toque. Uma regra de
etapa Meta pode usar o nome externo `LeadSubmitted`, mas sua identidade e seu ledger continuam
separados do evento causal por clique.

O ledger registra a oportunidade quando a mensagem é persistida, inclusive se a organização
estiver desligada; nesse caso a linha fica `skipped` e não é reenviada retroativamente. Erro
transitório de leitura da configuração não equivale a desativação e solicita retry. Não se deve
interpretar um HTTP 200 do receptor sintético como aceitação pela Meta.

### Living System Checklist

1. Entrada: mensagem inbound com âncora CTWA validada na ingestão WAHA ou no canal oficial.
2. Saída: `conversoes.clique_meta` usa o transporte Meta; falha no anúncio não bloqueia a mensagem.
3. Registro: `message.received`, `meta_ctwa_click_dispatches` e auditoria da mudança da chave.
4. Tela e porta: histórico e chave em **Configurações → Conversões**.
5. Recuperação: claim com lease, retry transitório e pedido de reprocessamento autorizado.
6. Configuração: chave independente por organização, desligada por padrão, e conexão Meta direta.
7. Continuidade: atendimento e card seguem seus fluxos mesmo se a conversão não for enviada.
8. Retorno: status e motivo do ledger orientam nova tentativa ou correção da conexão.
9. Mapa vivo: [conversões de anúncios](../architecture/conversoes-de-anuncios.architecture.json).

## Evidência sintética e trabalho ainda pendente

| Evidência                                                                                      | Resultado demonstrado                                                                                                              | Limite                                                                                                                     |
| ---------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| [QA 39285916921](https://github.com/oianmaxdev/deskcomm-feature-a-qa/actions/runs/39285916921) | Três shards unitários, typecheck, build, E2E causal e regressões aprovados; Graph e WAHA sintéticos, evidências age criptografadas | O job agregado ficou vermelho no gate de banco por uma dependência de release; não contar esse run como aprovação do banco |
| [QA 39307744735](https://github.com/oianmaxdev/deskcomm-feature-a-qa/actions/runs/39307744735) | Invariantes A1 de banco em PostgreSQL descartável aprovados                                                                        | Demais jobs foram dispensados nessa execução direcionada                                                                   |

Os dois runs usam o **mesmo SHA funcional `4d76349977ed5196a90c00722c240ae4764af747`**;
a homologação sintética é a combinação de seus gates efetivamente executados. A
[spec causal](../../tests/e2e/meta-lead-submitted-causal.spec.ts), os
[invariantes do clique](../../tests/invariants/meta-lead-por-clique.test.ts) e os
[testes de regressão](../../tests/e2e/conversoes-reprocessamento.spec.ts) são o ponto de partida
para uma nova validação após integração.

**Ainda não foi comprovado:** clique de campanha CTWA verdadeira → payload do provedor →
mensagem recebida → aceite pela Meta e atribuição no Gerenciador de Eventos. Não houve merge na
`main` oficial, deploy ou uso de dados reais. O aplicativo v1.73 sobre o schema atualizado
e a restauração de backup também exigem ensaio próprio antes de instalação. O rollback de imagens
não reverte migrations.

## Contribuição futura ao produto original

### Regras documentadas

- A [doutrina](../../CLAUDE.md), o [guia de contribuição](../../CONTRIBUTING.md), a
  [skill do contribuidor](../../.agents/skills/deskcomm-contribuir/SKILL.md) e o
  [template de PR](../../.github/PULL_REQUEST_TEMPLATE.md) regem uma proposta ao
  [`melgarafael/DeskcommCRM`](https://github.com/melgarafael/DeskcommCRM). A base é a `main`
  **oficial**, não a `main` possivelmente divergente do fork. Use branch de trabalho nomeada
  conforme o guia, commits convencionais e PR para `main`, sem levar personalizações locais.
- Se houver issue correspondente, siga a triagem, coordene a atribuição e vincule a issue no PR.
  O template pede 1–3 frases do ponto de vista de quem usa, checklist DoD e medições honestas;
  marque o que não foi executado. O autor pode deixar habilitada a edição por mantenedores para
  resolução de conflitos. Um PR de fork pode aguardar liberação inicial dos workflows.
- Mudança de schema exige migration incremental com `-- manifest:`, apêndice idempotente no
  baseline, RLS/grants, teste de banco e verificação de colisão com a `main` oficial **e PRs
  abertos**. O histórico `MANIFEST.md` não é editado. Fragmento de release fica em
  [`.changes/meta-lead-por-clique.md`](../../.changes/meta-lead-por-clique.md), sem escrever
  manualmente uma versão no `CHANGELOG.md`.
- Rode `pnpm cercas`, typecheck, lint, unitários, banco e E2E pertinentes; depois confira os
  checks oficiais aplicáveis ao PR. Uma evidência de QA do fork não equivale ao CI do SHA
  integrado. A [arquitetura viva](../architecture/conversoes-de-anuncios.architecture.json)
  e seu [índice](../architecture/README.md) devem acompanhar a mudança.

### Bloqueadores medidos e proposta de revisão

Na comparação desta branch com a `main` oficial examinada para o encerramento, há conflitos de
conteúdo em ingestão de canais, tela de conversões, auditoria, i18n, handler de lead e índice de
arquitetura. Os números **0617, 0618 e 0693** colidem com migrations distintas do upstream; os
timestamps desses pares não são iguais. É preciso reconciliar sem editar uma migration já aplicada; novos arquivos
de integração e forward-fix, se necessários, devem seguir a doutrina e ser testados sobre o
schema oficial atualizado. Os tipos gerados em `lib/database.types.ts` ainda não contêm o
contrato novo do clique; regere-os pelo mecanismo oficial depois de resolver o schema.

O commit textual `c2aec0507` introduziu a marca fixa na interface; `e85f6abfb` corrigiu o
texto e as traduções em commit separado. Os runs sintéticos do SHA funcional não cobriram essas
edições textuais. A aprovação anterior não substitui os gates do SHA que resolva os conflitos
com o upstream.

**Modelo de título (proposta, não imposição do template):**
`feat(conversoes): enviar LeadSubmitted por clique CTWA recebido`.

**Modelo de descrição:** explicar em 1–3 frases que cada mensagem de clique CTWA novo pode
gerar uma conversão sem card adicional; indicar a issue/épico correto se houver, as migrations e
o baseline reconciliados, o isolamento por organização, o fragmento de release, os runs de QA
do fork como evidência anterior e os gates do **novo SHA integrado**. Declarar expressamente o
que não foi medido: clique CTWA real, aceite/atribuição pela Meta e deploy.

Antes de solicitar revisão: resolver conflitos e colisões de migrations; regenerar tipos;
conferir marca e idiomas; verificar que a branch não inclui arquivos locais ou segredos;
executar os gates do PR no schema atual e a prova de tela; completar o template com resultados
reais. A decisão de abrir o PR e a integração cabem a uma etapa posterior.
