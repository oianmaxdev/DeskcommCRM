# Runbook — implantar a distribuição oianmaxdev na VPS (Hostinger)

> **Status:** preparado, **não executado**. Nenhum passo abaixo foi rodado na VPS de produção.
> A implantação depende de autorização explícita do dono, e da conclusão dos pré-requisitos da §0.
> Os dados da VPS da §1 foram lidos pelo MCP da Hostinger (só leitura) em 2026-11-26, inclusive o
> compose e o `.env` do projeto. Os segredos do `.env` **não** são reproduzidos aqui. O que só o SSH
> alcança está listado no fim da §1.

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

## 1. A VPS — confirmado pelo MCP da Hostinger em 2026-11-26 (só leitura)

| Item | Valor |
|---|---|
| VM | Hostinger KVM 1, ID `1653422`, `srv1653422.hstgr.cloud`, Ubuntu 24.04 (template "Ubuntu 24.04 with n8n"), ligada há 39 dias |
| Recursos | 1 vCPU (~7% de uso médio), 4 GB RAM (~2,5 GB em uso, ~1,5 GB livres), 50 GB disco (~20,8 GB usados, ~29 GB livres) |
| DeskcommCRM | projeto `deskcommcrm`, `/opt/deskcommcrm/docker-compose.prod.yml`, **1.110.0**: `app`, `worker`, `scheduler` (healthy há 12 dias), `redis:7-alpine`, `serverless-redis-http` (digest fixo), `waha` (`devlikeapro/waha:latest-2026.7.2`) |
| Memória por serviço | app ~250 MB (limite 768 MB), worker ~195 MB (512 MB), WAHA ~356 MB (1,3 GB), resto < 10 MB |
| Proxy | o `app` **não publica porta**: é servido pelo Traefik do projeto `n8n` (portas 80/443) — **confirmado no `.env`: `REVERSE_PROXY=traefik`**, rede `n8n_default`, entrypoints `web`/`websecure`, resolver `mytlschallenge` |
| Banco | **não há Postgres na stack do Deskcomm**: **confirmado: Supabase na nuvem** (pooler `sa-east-1`, porta 5432). O `update.sh` aplica o baseline nele por `SUPABASE_DB_URL`. Backup e restauração dependem do plano do Supabase — o dump do §2.3 é obrigatório |
| Imagens em uso | `ghcr.io/melgarafael/*:1.110.0` com `*_PULL_POLICY=missing` (fixadas por versão, como manda a doutrina) |
| Volumes do WAHA | `waha-data` (sessões pareadas) e `waha-media`; nome real com o prefixo do projeto: `deskcommcrm_waha-data` e `deskcommcrm_waha-media` |
| Chaves SSH na VM | **nenhuma cadastrada** no painel (acesso de root por senha, presumido) |
| ⚠️ Segurança | o `.env` guarda **`OWNER_PASSWORD` em texto puro** (a senha do dono, usada só no primeiro bootstrap). Recomendado: trocar essa senha no CRM e apagar a linha do `.env`. Fora do escopo desta implantação, mas não deve continuar assim |
| Outros projetos (fora do escopo, não tocar) | `evolution` (API + Postgres 15 + Redis; **a API publica a porta 8080 em 0.0.0.0** — fora do escopo, mas vale revisar), `n8n` (n8n em 127.0.0.1:5678 + Traefik) |
| Backups Hostinger | semanais (pontos em 2026-11-15 e 2026-11-22). **Restauram a VM inteira** (inclui Evolution e n8n): não servem para voltar só o CRM |
| Snapshot | **nenhum** — recomendado criar um imediatamente antes da implantação (com autorização) |
| Firewall Hostinger | nenhum grupo associado |

O que o MCP não alcança (ler por SSH, §2.1): `git remote -v`/`git status` em `/opt/deskcommcrm`
(o `checkout` do §3 recusa árvore suja), como o agente de atualização está agendado (cron/systemd)
— **ele precisa ficar parado durante a janela** — e onde/quando o `backup.sh` grava.

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

0. **Snapshot da VM** pelo hPanel ou API da Hostinger, minutos antes da janela (a VM não tem nenhum
   hoje; criar um novo substitui o anterior). É a volta mais rápida para o estado inteiro da VM — e
   também volta n8n e Evolution, então é só para desastre.

```bash
cd /opt/deskcommcrm
bash hostgator-setup-kit/backup.sh                       # dump do banco (o mesmo que o update.sh faz)
sudo tar czf ~/deskcomm-config-$(date +%F).tgz .env docker-compose*.yml   # contém SEGREDOS
docker run --rm -v deskcommcrm_waha-data:/d -v ~/:/b alpine tar czf /b/waha-sessoes-$(date +%F).tgz -C /d .
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
