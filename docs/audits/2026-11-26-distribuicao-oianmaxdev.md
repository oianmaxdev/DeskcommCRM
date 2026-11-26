# Distribuição oianmaxdev — integração da Feature C, correções da auditoria e preparação para produção

> Relatório da missão de 2026-11-25/26. Branch `distro/integracao/1.126.0` no fork
> `oianmaxdev/DeskcommCRM`, PR interno **#1** (para a `main` do fork). Cada afirmação diz se foi
> **feito**, **testado** (com o tipo de prova) ou **não comprovado**.
> **Nada foi alterado na VPS de produção.**

## A. Auditoria independente — achados e correções

| Achado | Confirmado? | Reprodução antes da correção | Correção | Testes de regressão |
|---|---|---|---|---|
| **A — fila travada** (`observador.ts`) | Sim | contra `724347ae5`: 0 de 50 conversas novas lidas com as 100 antigas já lidas; reivindicação de processo morto contava como leitura para sempre; falhas recentes ocupavam as vagas | `fn_supervisor_conversas_pendentes` (anti-join no banco, só `service_role`), rodízio por `ultima_rodada_em`, prazo de 200 s por rodada | `lib/supervisor/observador-fila.test.ts` (6 casos, centenas de conversas, várias organizações); `tests/invariants/supervisor-fila-justa.test.ts` (Postgres real) |
| **B — concorrência nas escritas** (`executor.ts`) | Sim | 5 casos falharam contra `724347ae5`: mesmo campo sobrescrito, outro campo perdido, tag perdida, valor "aplicado" por cima do vendedor, qualificação sobrescrita | trava otimista pela versão da linha (`updated_at`, avançado pelo trigger oficial `trg_crm_leads_updated_at`), relendo e recalculando até 3 vezes; qualificação por compare-and-set no JSON | `lib/supervisor/executor-concorrencia.test.ts`; `eq` em jsonb provado num PostgREST real |
| **C — anonimização dos PDFs** | — | — | **fora do escopo por decisão do dono** (nada alterado) | — |
| **D — ações interrompidas** (rota de aprovação, executor, observador) | Sim | ação nascia `applied` (ou virava `approved`) antes do efeito; queda no meio = "sucesso" sem efeito, sem nova tentativa | estado `executing` (`execution_started_at`, `execution_attempts`); `concluiAcao` só fecha quem está em execução; `lib/supervisor/retomada.ts` retoma no cron (>10 min, até 3 vezes); efeitos idempotentes (etapa no destino, ids derivados da ação para tarefa e checkpoint, linha do tempo por `source_id`) | `lib/supervisor/executor-concorrencia.test.ts` (queda antes e depois do efeito, retomadas concorrentes, conclusão dupla, desistência) |
| **Falhas por omissão** | Limitação confirmada (M5 da homologação anterior) | — | `lib/supervisor/omissao.ts`: origem citada + prazo vencido em horário comercial + nenhuma mensagem do vendedor/IA/automação depois da combinação + nada programado; frase que nunca afirma que algo "não aconteceu" | `lib/supervisor/omissao.test.ts` (14 casos) |

**Riscos residuais**
- Eventos `lead.stage_changed`/`lead.tag_added` podem ser emitidos duas vezes numa retomada depois de queda exatamente entre o efeito e a conclusão. Por padrão o evento do Supervisor não dispara automações.
- A ausência só é verificada no WhatsApp registrado. Ligação ou visita não são observáveis, e o texto diz isso.
- A desistência após 3 tentativas fecha a ação como `failed`, e a tela mostra.

## B. Integração com o upstream

- **Versão oficial usada:** **v1.126.0** (`41afb7bcc3`, release estável mais recente em 2026-11-25). É posterior à 1.110.0 da VPS, então não é downgrade.
- **Estratégia:** worktree nova a partir da tag, com **cherry-pick `-x`** do commit original `724347ae5`, que fica preservado em `feat/supervisor-comercial-ia`. Foram 12 conflitos resolvidos à mão.
  - O `test:db` pegou dois resíduos da resolução no `baseline.sql`, ambos corrigidos.
  - O diff contra a v1.126.0 **só acrescenta linhas**: nenhuma linha oficial foi apagada em nenhum arquivo.
- **Migration:** `5001_supervisor_comercial`. A faixa **5xxx** fica reservada à distribuição, porque o upstream usa 0xxx e 9xxx.
  - A colisão da 0381 foi resolvida sem desvio de hook.
  - A 0381 nunca foi aplicada em produção.
  - Baseline: install e update passam com `ON_ERROR_STOP=1`.
  - MANIFEST atualizado.
- **Reaproveitado do upstream:**
  - login pela conta ChatGPT (PKCE, verificação do token, renovação com trava no banco, armazenamento cifrado, listagem de modelos);
  - rota de Provedores aceitando `openai-assinatura` em vínculos;
  - fábrica de modelos `createDefaultRegistry`, com contenção de saída de rede;
  - trigger `updated_at` e trava otimista;
  - kit de atualização, agente, identidade em runtime e `publish-image.yml`.
- **Duplicação eliminada:** o porte reduzido da assinatura saiu. O Supervisor só acrescenta o embrulho de streaming que o `generateObject` precisa, já que a assinatura exige streaming e `store: false`.
- **Contratos que mudaram e foram adaptados:**
  - o upstream removeu `DEFAULT_BOT_MODEL` (#2377): o diagnóstico usa o padrão de classificação;
  - `ModeloResolvido` passou a exigir `provider`;
  - a cascata de LGPD ganhou passos novos: o passo do Supervisor foi movido para antes do retorno;
  - 12 traduções duplicadas foram removidas.
- **Núcleo × extensão** (`docs/doctrine/extensoes.md`): pela régua "se nenhuma organização ativar, a operação comum continua inteira?", o Supervisor é **candidato a extensão**. Nesta distribuição ele fica no código, desligado por padrão, com migration na faixa própria. Extraí-lo para o formato de extensão é trabalho futuro.
- **Mapa vivo:** `docs/architecture/supervisor-comercial.architecture.json`.

## C. Distribuição personalizada

| Peça | Como ficou |
|---|---|
| Branches | `main` do fork = linha da distribuição (avançada por fast-forward até a v1.126.0, sem reescrita); `distro/integracao/<versão>` = candidatas; `upstream` = acompanhamento. Feature A/B intocadas |
| Versão | `vX.Y.Z` estrito (o único formato que o kit e a tela aceitam), patch = 1000 + patch oficial × 100 + revisão. `v1.126.1001` = oficial 1.126.0, revisão 1 |
| Base oficial registrada | `.github/distro/base-oficial`; funcionalidades exclusivas em `.github/distro/funcionalidades.md` |
| Imagens | `ghcr.io/oianmaxdev/{deskcommcrm,deskcomm-worker,deskcomm-scheduler,deskcomm-voice-agent}` — `IMG_NS`, padrões do compose/`.env`/instalador e o rótulo `org.opencontainers.image.source` apontam para o fork (a imagem não se apresenta como oficial). Construídas pelo `publish-image.yml` oficial, nunca na VPS |
| `distro-release.yml` | manual: confere versão e **gates oficiais verdes no commit**, cria a tag, dispara a publicação, confere digest e arquiteturas, cria **prerelease** com as notas (base, commit, migrations 5xxx, gates, digests, mudanças) |
| `distro-promover.yml` | ato humano (ambiente `producao`, onde dá para exigir revisor): torna a candidata `latest`, o que o atualizador da VPS lê. Recusa candidata publicada sem gates |
| `distro-acompanhar-upstream.yml` | a cada 6 h: release **estável** nova do upstream → branch de integração por merge comum; sem conflito, PR e gates disparados; com conflito, **nada publicado** e PR rascunho com o relatório. Não executa código do upstream |
| Gates disparáveis | `workflow_dispatch` acrescentado a ci, e2e e perf (o GITHUB_TOKEN só dispara esse evento) |
| Atualização pela tela | sem segundo atualizador: o agente e o `update.sh` oficiais leem `releases/latest` do `origin` do clone. Basta o clone da VPS apontar para o fork |

**Limitações conhecidas**
- A tela mostra o `CHANGELOG.md` oficial da faixa de versões. As notas próprias da distribuição ficam na página da release no GitHub.
- O canal `stable` das imagens não é movido pela release da distribuição, e a VPS não o usa: instala por número de versão.

**Bloqueio:** as **Actions do fork estão desligadas pelo GitHub** ("Actions has been disabled for this repository", embora a configuração diga habilitado). Até o dono religar, não há CI, imagem publicada nem release. Por isso **não existe ainda link de release candidata**.

## D. Hostinger e produção (MCP da Hostinger, só leitura, em 2026-11-26)

| Item | Valor |
|---|---|
| VM | KVM 1, ID `1653422`, Ubuntu 24.04 com n8n, 1 vCPU (~7% de uso), 4 GB RAM (~1,5 GB livres), 50 GB disco (~29 GB livres) |
| DeskcommCRM | `/opt/deskcommcrm`, 1.110.0: app, worker e scheduler saudáveis; Redis, `serverless-redis-http`, WAHA `latest-2026.7.2` |
| Memória | app ~250 MB de 768 MB, worker ~195 MB de 512 MB, WAHA ~356 MB de 1,3 GB |
| Proxy | app sem porta publicada → servido pelo Traefik do `n8n` (80/443) |
| Banco | externo: não há Postgres na stack do Deskcomm (tipo e host a confirmar por SSH) |
| Backups | da Hostinger, semanais (15/11 e 22/11), restauram a VM inteira. **Sem snapshot.** Sem grupo de firewall da Hostinger |
| Fora do escopo | Evolution (a API publica 8080 em 0.0.0.0 — vale revisar) e n8n + Traefik |

- **Plano de migração:** `docs/runbooks/distro-oianmaxdev-implantacao.md`.
  - Pré-requisitos, inventário e backup: snapshot, `backup.sh`, configuração e sessões do WAHA fora da VPS, e restauração testada em ambiente isolado.
  - Transição da instalação oficial para a distribuição: checkout do kit da distribuição antes do `update.sh --force`, porque o pré-voo usa o namespace de imagens do kit que está em disco.
  - Verificações e critérios de interrupção.
  - Rollback de aplicação, de configuração e de banco, sem nunca restaurar por cima.
  - Plano do piloto.
- **Impacto esperado:** alguns minutos de indisponibilidade do CRM. Nada é compilado na VPS. O Supervisor nasce desligado.

## E. Homologação

<!-- RESULTADOS -->

## F. Para a sua operação

1. **Novas versões oficiais:** a cada 6 horas o GitHub confere se saiu release estável nova do Deskcomm. Se saiu, ele mistura a versão nova com as suas funcionalidades numa branch separada e abre um PR com os testes rodando. Nada chega à sua VPS sozinho.
2. **Quando houver conflito:** o processo para. Nada é publicado e a VPS segue na versão atual. Aparece um PR rascunho dizendo quais arquivos conflitaram e o comando para resolver. Alguém (eu numa sessão, ou um dev) resolve preservando os dois lados.
3. **Atualizar pela interface:** depois que uma versão é **promovida** (workflow `distro-promover`, o seu "aprovo"), ela aparece em **Configurações → Atualização** como sempre. O botão usa o atualizador oficial: backup, troca, verificação e volta automática se não subir.
4. **Nova funcionalidade sua:** entra por PR na `main` do fork, com as migrations na faixa 5xxx e uma linha em `.github/distro/funcionalidades.md`. Depois, `distro-release` com a próxima revisão (ex.: `v1.126.1002`).
5. **Voltar versão:** a tela ou o `update.sh --to <versão> --force` voltam a aplicação. O banco não volta junto, porque as mudanças são aditivas e inofensivas. Recuperar banco é procedimento separado, nunca automático (runbook §4).
6. **Para autorizar a primeira implantação:**
   1. religar as Actions do fork;
   2. ver os gates verdes no PR #1 e fazer o merge;
   3. rodar `distro-release` (`v1.126.1001`);
   4. tornar os pacotes do GHCR públicos;
   5. aprovar a janela, o snapshot e a execução do runbook.

## G. Ferramentas e skills

| Item | Uso | Resultado |
|---|---|---|
| Hooks do `deskcomm-contribuir` (pre-commit de colisão de migration, pre-push que protege a `main`) | ativos em todos os commits | a 5001 passou sem desvio; a `main` do fork avançou por API, sem `force` |
| MCP da Hostinger | só operações de leitura (VM, projetos Docker, contêineres e consumo, backups, snapshot, métricas) | seção D |
| GitHub CLI | PR interno no fork, refs, diagnóstico das Actions | PR #1; bloqueio das Actions identificado |
| actionlint | validação dos workflows novos | sem erros |
| Skills GSD, Vibe Coding Tool Kit e skills de nuvem | **não carregadas**: o processo do próprio repositório (doutrina, guardas, `test:db`) já cobria o necessário | — |
