# Conflito ao integrar a release oficial v1.128.0

A integração automática parou com conflito. Nada foi mesclado nem publicado; a produção segue na versão atual.

## Arquivos em conflito
- `.github/workflows/ci.yml`
- `lib/i18n/dicionario.ts`
- `supabase/baseline.sql`
- `tests/unit/preambulo-do-ci-nao-come-o-relogio.test.ts`

## Como resolver
```bash
git fetch origin && git switch distro/integracao/1.128.0
git remote add upstream https://github.com/melgarafael/DeskcommCRM.git 2>/dev/null || true
git fetch upstream tag v1.128.0 && git merge v1.128.0   # resolva preservando os DOIS lados
git rm .github/distro/conflito-1.128.0.md
echo v1.128.0 > .github/distro/base-oficial && git add -A && git commit
git push   # o PR rascunho atualiza e roda os gates
```
