# Funcionalidades exclusivas da distribuição oianmaxdev

Tudo o que esta distribuição acrescenta à release oficial indicada em
`.github/distro/base-oficial`. Funcionalidade nova entra aqui junto com o PR que
a traz.

| Funcionalidade | Desde | Migrations (faixa 5xxx) | Onde |
|---|---|---|---|
| Supervisor Comercial por IA (Feature C): mantém o CRM a partir das conversas dos vendedores, aprovações, diário de atividade, diagnóstico comercial com estudos de caso, recorrência, falhas por omissão comprovadas e PDF | base 1.126.0 | `5001_supervisor_comercial` | `lib/supervisor/`, `app/app/analise/supervisor/`, `app/api/v1/supervisor/`, `app/api/v1/cron/supervisor-comercial/` |

## Identidade da distribuição

- Imagens: `ghcr.io/oianmaxdev/{deskcommcrm,deskcomm-worker,deskcomm-scheduler,deskcomm-voice-agent}`
  (`IMG_NS` em `hostgator-setup-kit/_common.sh`; rótulo `org.opencontainers.image.source` aponta para o fork).
- Versões: `vX.Y.Z` com patch = 1000 + patch oficial × 100 + revisão (ex.: `v1.126.1001` = oficial 1.126.0, revisão 1).
- Migrations próprias só na faixa **5xxx** (o upstream usa 0xxx e 9xxx).
- Workflows: `distro-release.yml` (candidata), `distro-promover.yml` (produção, ato humano),
  `distro-acompanhar-upstream.yml` (integra cada release oficial estável).
