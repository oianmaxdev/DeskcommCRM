# Runbook — implantar a distribuição oianmaxdev na VPS (Hostinger)

> **Status:** preparado, **não executado**. Nenhum passo abaixo foi rodado na VPS de produção.
> A implantação depende de autorização explícita do dono, e da conclusão dos pré-requisitos da §0.
> Os dados da VPS marcados com **[confirmar]** vieram de uma leitura anterior e ainda precisam ser
> conferidos pelo MCP da Hostinger (só leitura) ou por SSH.

## 0. Pré-requisitos (bloqueadores)

1. **Actions do fork habilitadas.** Em 2026-11-26 o GitHub respondia "Actions has been disabled for
   this repository" no fork `oianmaxdev/DeskcommCRM`. Na aba **Actions** do fork, clique em
   "I understand my workflows, go ahead and enable them". Se não houver esse botão, confira
   *Settings → Billing* da conta.
2. **Gates verdes no PR interno** (`oianmaxdev/DeskcommCRM#1`): verify, invariants, build-and-size,
   e2e e imagens-ok. Depois, merge na `main` do fork.
3. **Release candidata publicada** pelo workflow `distro-release` (ex.: `v1.126.1001`) com as quatro
   imagens em `ghcr.io/oianmaxdev/*`.
4. **Pacotes do GHCR públicos.** Pacote novo nasce privado: em *Packages → cada pacote → Package
   settings → Change visibility → Public*, para `deskcommcrm`, `deskcomm-worker`, `deskcomm-scheduler`
   e `deskcomm-voice-agent`. A VPS puxa anonimamente.
5. **Restauração testada** num ambiente isolado (§2.4).

## 1. O que se sabe da VPS

| Item | Valor |
|---|---|
| Provedor / plano | Hostinger KVM 1 — 1 vCPU, 4 GB RAM, 50 GB, Ubuntu 24.04, ID `1653422` **[confirmar]** |
| Instalação | `/opt/deskcommcrm`, `docker-compose.prod.yml`, versão **1.110.0** (imagens `ghcr.io/melgarafael/*:1.110.0`) **[confirmar]** |
| Proxy | Traefik do n8n (`/docker/n8n`) nas portas 80/443 → o `.env` deve ter `REVERSE_PROXY=traefik` **[confirmar]** |
| Banco | não há Supabase na stack local; hipótese: Supabase externo **[confirmar a origem de `SUPABASE_DB_URL` sem expor a credencial]** |
| Outros serviços (fora do escopo, não tocar) | Evolution API (`/docker/evolution`), n8n + Traefik (`/docker/n8n`) |

## 2. Pré-implantação

### 2.1 Inventário (só leitura)

```bash
cd /opt/deskcommcrm
git remote -v && git describe --tags --exact-match 2>/dev/null; git status --porcelain | head
docker compose ps
docker inspect --format '{{.Config.Image}} {{.Image}}' $(docker compose ps -q) | tee ~/inventario-imagens-$(date +%F).txt
grep -E '^(REVERSE_PROXY|APP_IMAGE|WORKER_IMAGE|SCHEDULER_IMAGE|VOICE_AGENT_IMAGE|APP_DOMAIN|COMPOSE_PROFILES)=' .env
df -h / && free -m && docker system df
crontab -l; systemctl list-timers | grep -i deskcomm; ls -la backups/ 2>/dev/null | tail -5
```

Guarde a saída: os **digests atuais** são o caminho de volta da aplicação (§4.1).

### 2.2 Compatibilidade

- 1.110.0 → 1.126.0 é atualização **oficial** para frente: o `update.sh` reaplica o `baseline.sql`
  (idempotente e aditivo) e cobre as migrations oficiais do intervalo.
- A distribuição acrescenta só a migration **`5001_supervisor_comercial`**: tabelas novas
  (`supervisor_*`), uma função `fn_supervisor_conversas_pendentes` (só `service_role`) e colunas nas
  próprias tabelas. **Não altera tabela existente do núcleo.**
- O Supervisor nasce **desligado** em todas as organizações (§6).

### 2.3 Backup

```bash
cd /opt/deskcommcrm
bash hostgator-setup-kit/backup.sh                       # dump do banco (o mesmo que o update.sh faz)
sudo tar czf ~/deskcomm-config-$(date +%F).tgz .env docker-compose*.yml   # contém SEGREDOS
docker run --rm -v deskcommcrm_waha_data:/d -v ~/:/b alpine tar czf /b/waha-sessoes-$(date +%F).tgz -C /d .   # nome do volume [confirmar]
```

- Copie o dump e os dois `.tgz` para **fora da VPS** (sua máquina ou um storage privado).
  O `.tgz` de configuração tem segredos: não suba para repositório nem para lugar público.
- Espaço: o `update.sh` recusa sozinho se faltar disco (imagens + último backup + 20%).

### 2.4 Restauração testada (obrigatória)

Num ambiente **isolado** (máquina local ou VPS descartável), suba um Postgres/Supabase **vazio**,
restaure o dump com `bash hostgator-setup-kit/restore.sh` (ele recusa banco que não está vazio) e
confira contagens: organizações, usuários, contatos, conversas, mensagens, negócios, tarefas.
Nunca aponte esse ambiente para o banco de produção.

## 3. Implantação (janela de manutenção)

1. **Janela**: horário de menor movimento; avise a equipe que o CRM ficará até ~15 min indisponível.
2. **Apontar o clone para o fork** (é o que faz a tela Configurações → Atualização e o `update.sh`
   passarem a ver as releases da distribuição) e **trocar o kit em disco pelo da distribuição**:

   ```bash
   cd /opt/deskcommcrm
   git status --porcelain            # precisa sair VAZIO; se não, pare e investigue
   git remote set-url origin https://github.com/oianmaxdev/DeskcommCRM.git
   git fetch --tags origin
   git checkout v1.126.1001          # só código e kit; o app segue rodando a imagem antiga
   ```

   **Por que o checkout manual, só desta vez:** o `update.sh` confere as quatro imagens no registro
   ANTES de trocar o código, usando o namespace (`IMG_NS`) do kit que está no disco. Rodado com o kit
   oficial 1.110.0, ele procuraria `ghcr.io/melgarafael/*:1.126.1001`, que não existe, e recusaria
   (sem estragar nada). Com o kit da distribuição no disco, o pré-voo e a gravação das imagens usam
   `ghcr.io/oianmaxdev`. Das próximas vezes, o kit já é o da distribuição e isto não é necessário.

3. **Atualizar com o atualizador oficial** (backup, pré-voo das quatro imagens, reaplicação do
   baseline, troca das imagens, healthcheck e volta automática da imagem se o app não subir). O
   `--force` é o caminho previsto pelo próprio kit para "código já na versão, imagem antiga":

   ```bash
   bash hostgator-setup-kit/update.sh --to v1.126.1001 --force
   ```

   Se o passo 3 parar antes de trocar as imagens, volte o código: `git checkout -` (o app nunca saiu
   da imagem antiga).

   Com `REVERSE_PROXY=traefik` no `.env`, todo `docker compose` do kit leva
   `-f docker-compose.prod.yml -f docker-compose.traefik.yml`. **Não rode `docker compose up -d` à mão
   sem os dois `-f`**: o domínio responderia 404.
4. **Verificações**:
   - `curl -sI https://<seu-domínio>` → **307** (redireciona para o login), nunca 404;
   - `docker compose ps` → app, worker e scheduler `healthy`;
   - `docker inspect --format '{{.Config.Image}}' $(docker compose ps -q app)` → `ghcr.io/oianmaxdev/deskcommcrm:1.126.1001`;
   - na tela: login, Inbox, um funil, Agentes de IA, Configurações → Atualização mostrando a versão
     instalada;
   - canais: as sessões do WhatsApp (WAHA) continuam conectadas; mande e receba uma mensagem de teste
     **num número seu**;
   - integrações: webhooks de saída, n8n e Evolution seguem respondendo (sem alterar nada neles);
   - Análise › Supervisor Comercial abre e mostra o Supervisor **desligado**.

### Critérios para interromper ou voltar

- domínio responde 404 ou 5xx por mais de 2 min depois do `update.sh`;
- app/worker/scheduler não ficam `healthy`;
- WhatsApp desconectado e não volta em 5 min;
- erro de baseline no log do `update.sh` (ele para sozinho antes de trocar as imagens).

## 4. Rollback

### 4.1 Aplicação (imagem)

O `update.sh` já volta a imagem anterior sozinho quando o app não sobe. Para voltar à mão para a
versão oficial anterior:

```bash
cd /opt/deskcommcrm
bash hostgator-setup-kit/update.sh --to v1.110.0 --force   # e, se a tag não existir no fork:
git remote set-url origin https://github.com/melgarafael/DeskcommCRM.git && git fetch --tags origin
bash hostgator-setup-kit/update.sh --to v1.110.0 --force
```

### 4.2 Configuração

Restaure `.env` e os `docker-compose*.yml` do `.tgz` da §2.3 e rode o `up -d` **com os dois `-f`**.

### 4.3 Banco — não é "voltar a imagem"

- O baseline é aditivo: voltar a imagem **não** desfaz schema. As tabelas `supervisor_*` ficam e
  são inofensivas para a versão anterior.
- **Nunca** restaure o backup por cima do banco em produção: o `restore.sh` só aceita banco vazio, e
  restaurar apagaria tudo o que chegou depois (mensagens, negócios, contatos).
- Recuperação de banco só em caso de corrupção comprovada: restaure num banco **novo e vazio**,
  reconcilie o que entrou depois do backup e só então aponte o app para ele — decisão do dono, com
  janela própria.

## 5. Impacto esperado

- Indisponibilidade de alguns minutos durante a troca das imagens; o worker retoma as filas.
- 1 vCPU / 4 GB compartilhados com Evolution e n8n: **nada é compilado na VPS** (imagens prontas do
  GHCR). O Supervisor, quando ligado, faz uma chamada de IA por conversa com mensagem nova depois de
  20 min de silêncio, no máximo 20 por rodada de 5 min.

## 6. Piloto com clientes reais (depois da implantação)

| Controle | Como |
|---|---|
| Desligado por padrão | `supervisor_settings` sem linha = desligado; nada liga sozinho |
| Ativação por organização | Análise › Supervisor Comercial › Configuração → "Supervisor ligado" (admin) |
| Funis monitorados | marque só os do piloto |
| Ganho, perda, valor e follow-up | já nascem em "pede aprovação" — mantenha |
| Mover etapa, tags, tarefas | comece em "pede aprovação" no piloto; tags só da lista permitida (vazia por padrão) |
| Automações indiretas | "Movimentos automáticos disparam as automações" desligado (padrão) |
| Modelo e custo de IA | Modelo de IA do Supervisor; limite mensal em Agente de IA › Orçamento (o Supervisor para quando esgota) |
| Monitoramento | aba Atividade (o que fez), Pendências (o que espera), `llm_calls` (custo), log do scheduler (`supervisor-comercial`) |
| Desligar rápido | desmarcar "Supervisor ligado" e salvar — vale na próxima rodada (≤ 5 min) |

## 7. Atualizações futuras

Depois desta primeira implantação, as próximas versões da distribuição chegam pela tela
**Configurações → Atualização** (o clone já aponta para o fork). Só aparecem versões **promovidas**
pelo workflow `distro-promover` — candidatas não chegam à VPS.
