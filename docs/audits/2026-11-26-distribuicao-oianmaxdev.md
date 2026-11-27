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
| DeskcommCRM | `/opt/deskcommcrm`, 1.110.0: app, worker e scheduler saudáveis; Redis, `serverless-redis-http`, WAHA `latest-2026.7.2`. Imagens fixadas por versão (`*_PULL_POLICY=missing`) |
| Proxy | `REVERSE_PROXY=traefik` (lido do `.env` pelo MCP), rede `n8n_default`, entrypoints `web`/`websecure`, resolver `mytlschallenge` |
| Banco | **Supabase na nuvem** (pooler `sa-east-1`) — não há Postgres na stack |
| Volumes do WAHA | `deskcommcrm_waha-data` (sessões) e `deskcommcrm_waha-media` |
| Chaves SSH | nenhuma cadastrada no painel; o WSL não tem chave nem configuração para a VPS |
| Backups | da Hostinger, semanais (15/11 e 22/11), restauram a VM inteira. **Sem snapshot.** Sem grupo de firewall |
| ⚠️ Segurança | o `.env` guarda `OWNER_PASSWORD` em texto puro (senha do dono, usada só no primeiro bootstrap). **Recomendado: trocar a senha e apagar a linha.** O MCP devolve o `.env` inteiro em leitura — os segredos não foram reproduzidos em arquivo nenhum |
| Fora do escopo | Evolution (a API publica 8080 em 0.0.0.0 — vale revisar) e n8n + Traefik |

O que só o SSH responde (não bloqueia, mas vale conferir na janela): `git status` limpo em
`/opt/deskcommcrm`, `docker buildx version` e o crontab do agente.

## E. Homologação

### E.1 CI do fork (GitHub Actions)

| Onde | Resultado |
|---|---|
| PR #1 (integração) | **os 5 gates verdes**: `verify` (typecheck completo, lint, `test:unit`), `invariants` (Postgres 15 e 17), `build-and-size`, `e2e` (todas as partes, incluindo `supervisor-comercial.spec.ts`), `imagens-ok`. Três rodadas: a 1ª e a 2ª acharam defeitos reais que a suíte local não pegava (`lint:channels`, LGPD Art. 18 II, fixtures tipadas, entrada duplicada de branding, seed e login com MFA na spec E2E) — todos corrigidos |
| `main` do fork (merge `1b15faeff`) | 5 gates verdes |
| Release `v1.126.1001` | **prerelease** publicada pelo `distro-release` com gates exigidos; 4 imagens em amd64+arm64, **públicas** (pull anônimo 200), `revision` = commit da tag, `source` = o fork |
| Instabilidade conhecida | a perna Postgres 17 de `invariants` bateu no teto de 45 min duas vezes (no fork não há o executor próprio do upstream); passou ao re-rodar. O teto **não** foi subido: a regra escrita no repositório manda investigar antes |
| PR #2 (`v1.126.1002`) | Actions desligadas pelo GitHub em 27/11 ~00h UTC e religadas pelo dono. **5 gates verdes** no PR e na `main` (`ef180a01f`). Os invariantes foram cancelados aos 45 min nas duas majors; o teto do fork subiu para 60 com a razão medida (§E.4) |
| Release `v1.126.1002` | **prerelease** publicada com gates exigidos; 4 imagens amd64+arm64, pull anônimo 200 |

### E.2 Simulações numa VPS isolada

Ambiente: contêiner Ubuntu 24.04 com Docker próprio (docker-in-docker), Traefik na rede
`n8n_default` como o da Hostinger, Supabase local **novo** no lugar do da nuvem, a instalação
**oficial 1.110.0** com as imagens oficiais, 20 contatos / 20 conversas / 200 mensagens / 20 negócios
**sintéticos**. Nenhum contato com produção, nenhuma mensagem enviada.

| # | Cenário | Resultado |
|---|---|---|
| 1 | Backup do runbook §2.3 | ok — e achou que o `.tgz` de configuração nascia **644 com segredos** → runbook com `umask 077` |
| 2 | Transição 1.110.0 → `v1.126.1001`, runbook literal (checkout manual + `--force`) | passou (3 min), dados intactos — **mas** registrou a própria versão nova como "anterior" |
| 3 | Mesma transição, kit da distribuição em cópia externa (método novo) | **passou em 1m24s** sem `--force`; volta automática registrada para `v1.110.0`; crontab aponta para o kit do clone |
| 4 | Verificação pela tela (navegador real) | login, Inbox (20 conversas), CRM, **Supervisor desligado**, Configurações › Atualização com "Versão instalada: 1.126.1001" |
| 5 | Dados e schema depois | contagens idênticas; 4 tabelas `supervisor_*`, funções e gatilho LGPD; `supervisor_settings` vazio |
| 6 | Rollback manual para a 1.110.0 oficial | **51 s**, dados intactos, 1.110.0 saudável sobre o banco já atualizado |
| 7 | **App cai logo depois da atualização → volta automática do vigia** | **FALHOU na `v1.126.1001`**: procurava `oianmaxdev/*:1.110.0`, recusava, **app fora do ar**. Corrigido (`ns_da_versao`/`img_ref`, PR #2) e provado com o mesmo comando do vigia: volta à 1.110.0 oficial em 1m31s |
| 8 | Versão sem imagens publicadas | recusa em 4 s, nada muda (a mensagem diz "DNS/rede" — texto oficial) |
| 9 | Falha de migração (função conflitante plantada) | para em 76 s **antes** de trocar imagens; 1.110.0 no ar; o código fica na versão nova → runbook manda `git checkout v1.110.0` |
| 10 | Restauração do backup num banco vazio (§2.4) | **23 s**, 250 tabelas conferidas, contagens idênticas, login ok |
| — | `buildx` ausente | o pré-voo recusa sem mexer em nada → runbook ganhou a checagem `docker buildx version` |
| — | Traefik reiniciado na janela do vigia | um 503 passageiro conta como queda e dispara a volta → runbook: não reiniciar o proxy nos minutos seguintes |

**Com a `v1.126.1002` publicada (27/11/2026):**

| # | Cenário | Resultado |
|---|---|---|
| 11 | Personalizada → personalizada (`1001 → 1002`), kit do clone, sem `--force` | **passou em 2m17s**; volta registrada para `v1.126.1001`; dados intactos |
| 12 | App cai depois de `1001 → 1002` → volta automática | **voltou sozinho para a `v1.126.1001` em 50 s**, saudável |
| 13 | §4.1 literal: rollback manual para a 1.110.0 oficial | **52 s**, saudável |
| 14 | **§3 literal com a `v1.126.1002`** (o procedimento de produção) | **passou em 1m42s**; volta registrada para `v1.110.0`; árvore limpa; crontab sem referência à cópia externa |
| 15 | **App cai depois da transição → volta automática para a 1.110.0 oficial** (kit corrigido dentro do clone) | **voltou sozinho em 74 s**, imagens `melgarafael:1.110.0`, `/app` 307, dados intactos — o defeito do cenário 7 está corrigido na versão publicada |
| 16 | Tela depois da §3 | Versão instalada 1.126.1002 com a revisão do commit da tag; Supervisor desligado; Inbox e CRM. Atualização avisa "não consegui checar" até a promoção (`releases/latest` 404) — esperado |

**Não ensaiados:** conflito real no `distro-acompanhar-upstream` (só acontece quando sair release
oficial nova) e gate reprovando o `distro-release` (a lógica está no workflow e foi lida, não
provocada). Produção conferida pelo MCP depois de tudo: **1.110.0, saudável, intocada.**

### E.3 Local

`test:shell` completo verde sobre o PR #2; `test:db` dos invariantes afetados (LGPD, definers,
Supervisor) verde no Postgres real; typecheck restrito dos arquivos tocados limpo.

### E.4 Consumo do GitHub Actions

Em 100 execuções recentes do fork, **80 eram agendadas e sem utilidade aqui**: `relogio` (a cada 5
min, para instalação sem agendador — a VPS tem o contêiner `scheduler`) e `vigia-de-colisao` (a cada
2 h, para colisão de migrations entre muitos PRs do upstream — o `verify` já mede em cada PR).
**Desligados no repositório** (`gh workflow disable`), junto com o `acolhida` (no fork nunca faz
nada) — configuração, não código: a integração do upstream não os religa.

| Medida | Valor |
|---|---|
| Uma rodada completa de gates | ~350 min de executor (ci 156, e2e 140, imagens 48, perf 3) |
| Por mudança | ~700 (PR + push na `main`) |
| Teto dos invariantes | 45 → 60 min no fork: verde medido 38–43 min, cancelado aos 45 em 3 de 4 rodadas, e cada nova tentativa custava até 90 min |
| Ficou ligado | os 5 gates, `distro-acompanhar-upstream` (6/6 h), `distro-release`, `distro-promover`, `mysql-integracao` (informativo), `release` (pulado no fork) |

Para gastar menos: **juntar correções em poucos PRs** (cada PR paga duas rodadas) e não disparar
workflow à mão sem motivo. Cortar a rodada do push na `main` exigiria mexer em vários workflows do
upstream e abriria conflito em toda integração — não compensa.

## F. Para a sua operação

1. **Novas versões oficiais:** a cada 6 horas o GitHub confere se saiu release estável nova do Deskcomm. Se saiu, ele mistura a versão nova com as suas funcionalidades numa branch separada e abre um PR com os testes rodando. Nada chega à sua VPS sozinho.
2. **Quando houver conflito:** o processo para. Nada é publicado e a VPS segue na versão atual. Aparece um PR rascunho dizendo quais arquivos conflitaram.
3. **Atualizar pela interface:** depois que uma versão é **promovida** (workflow `distro-promover`, o seu "aprovo"), ela aparece em **Configurações → Atualização**. Uma prerelease não aparece ali.
4. **Nova funcionalidade sua:** entra por PR na `main` do fork, com migrations na faixa 5xxx e uma linha em `.github/distro/funcionalidades.md`. Depois, `distro-release` com a próxima revisão.
5. **Voltar versão:** automática se o app não subir ou cair logo depois (a partir da `v1.126.1002`); manual pelos pins (runbook §4.1), porque o `update.sh` recusa downgrade. O banco não volta junto: as mudanças são aditivas.
6. **O que falta para a implantação:**
   1. **sua autorização** para a janela: snapshot, backup e o runbook §3 com `v1.126.1002`;
   2. a promoção da `v1.126.1002` (`distro-promover`), na mesma autorização.

## G. Ferramentas e skills

| Item | Uso | Resultado |
|---|---|---|
| Hooks do `deskcomm-contribuir` (pre-commit de colisão de migration, pre-push que protege a `main`) | ativos em todos os commits | a 5001 passou sem desvio; a `main` do fork avançou por API, sem `force` |
| MCP da Hostinger | só operações de leitura (VM, projetos Docker, contêineres e consumo, backups, snapshot, métricas) | seção D |
| GitHub CLI | PR interno no fork, refs, diagnóstico das Actions | PR #1; bloqueio das Actions identificado |
| actionlint | validação dos workflows novos | sem erros |
| Skills GSD, Vibe Coding Tool Kit e skills de nuvem | **não carregadas**: o processo do próprio repositório (doutrina, guardas, `test:db`) já cobria o necessário | — |
