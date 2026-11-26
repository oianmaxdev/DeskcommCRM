/**
 * SUPERVISOR COMERCIAL (distribuição oianmaxdev) — provado pela tela, como um
 * gestor o usaria.
 *
 * O CI não tem chave de IA, então a LEITURA das conversas (o modelo) fica com os
 * testes de unidade e de banco (`lib/supervisor/*.test.ts`,
 * `tests/invariants/supervisor-*.test.ts`). Este spec semeia o que o modelo
 * teria produzido — leitura, ações e um diagnóstico gravado — e prova pela tela
 * tudo o que é determinístico:
 *   · a PORTA (Análise › Supervisor Comercial) e a configuração salva (ligar,
 *     escolher funil) — admin;
 *   · o DIÁRIO de atividade com os links para o card do negócio e o Inbox;
 *   · a APROVAÇÃO de uma pendência pela tela: a tag chega ao negócio e a ação
 *     fecha `approved` (passando por `executing`, achado D);
 *   · o DIAGNÓSTICO com a verificação da falha por omissão;
 *   · o PDF baixado sem NENHUMA chamada de IA nova;
 *   · NENHUMA mensagem enviada ao cliente durante tudo isso.
 *
 * Pré-requisitos (banco local do baseline, app buildada):
 *   pnpm e2e:env && pnpm e2e:build
 *   pnpm exec playwright test tests/e2e/supervisor-comercial.spec.ts
 */
import * as fs from "node:fs";
import * as path from "node:path";

import { expect, test, type Page } from "./helpers/test";
import { createClient } from "@supabase/supabase-js";

import { carregarEnvLocal } from "../../scripts/lib/env-de-teste";

const CREDS_PATH = path.join(process.cwd(), ".e2e-creds.json");
const EVIDENCIA = process.env.E2E_EVIDENCIA ?? path.join(process.cwd(), "evidence/supervisor-comercial");

interface Creds {
  password: string;
  org_id: string;
  users: Record<string, { id: string; email: string; role: string }>;
}

const env = carregarEnvLocal();
const admin = createClient(env.NEXT_PUBLIC_SUPABASE_URL!, env.SUPABASE_SERVICE_ROLE_KEY!, {
  auth: { autoRefreshToken: false, persistSession: false },
});

let creds: Creds;
const SUFIXO = `${Date.now()}`.slice(-7);
const FUNIL = `Supervisor E2E ${SUFIXO}`;
const NEGOCIO = `Calça pantalona ${SUFIXO}`;
const TAG = `prova-${SUFIXO}`;

const ids = { pipeline: "", etapaA: "", etapaB: "", lead: "", contato: "", conversa: "", run: "", aplicada: "", pendente: "", relatorio: "" };

async function login(page: Page, email: string, senha: string): Promise<void> {
  await page.goto("/login");
  await page.locator("#email").fill(email);
  await page.locator("#password").fill(senha);
  await page.getByRole("button", { name: "Entrar", exact: true }).click();
  await page.waitForURL(/\/app/, { timeout: 60_000 });
}

async function captura(page: Page, nome: string): Promise<void> {
  fs.mkdirSync(EVIDENCIA, { recursive: true });
  await page.screenshot({ path: path.join(EVIDENCIA, `${nome}.png`), fullPage: true });
}

async function contar(tabela: string): Promise<number> {
  const { count, error } = await admin
    .from(tabela)
    .select("id", { count: "exact", head: true })
    .eq("organization_id", creds.org_id);
  if (error) throw new Error(`${tabela}: ${error.message}`);
  return count ?? 0;
}

async function insere<T extends Record<string, unknown>>(tabela: string, linha: T): Promise<string> {
  const { data, error } = await admin.from(tabela).insert(linha).select("id").single();
  if (error) throw new Error(`${tabela}: ${error.message}`);
  return (data as { id: string }).id;
}

test.describe("Supervisor Comercial — pela tela", () => {
  test.describe.configure({ mode: "serial", timeout: 240_000 });
  test.use({ timezoneId: "America/Sao_Paulo", locale: "pt-BR" });

  let mensagensAntes = 0;
  let chamadasDeIaAntes = 0;

  test.beforeAll(async () => {
    creds = JSON.parse(fs.readFileSync(CREDS_PATH, "utf8")) as Creds;
    const org = creds.org_id;
    ids.pipeline = await insere("crm_pipelines", { organization_id: org, name: FUNIL, settings: {} });
    ids.etapaA = await insere("crm_stages", { organization_id: org, pipeline_id: ids.pipeline, name: "Em atendimento", position: 1 });
    ids.etapaB = await insere("crm_stages", { organization_id: org, pipeline_id: ids.pipeline, name: "Proposta", position: 2 });
    ids.contato = await insere("contacts", { organization_id: org, name: `Cliente E2E ${SUFIXO}` });
    const sessao = await insere("channel_sessions", { organization_id: org, waha_session_name: `sup-e2e-${SUFIXO}`, webhook_secret_encrypted: "\\x00" });
    ids.conversa = await insere("conversations", { organization_id: org, contact_id: ids.contato, channel_session_id: sessao });
    ids.lead = await insere("crm_leads", {
      organization_id: org, pipeline_id: ids.pipeline, stage_id: ids.etapaB, contact_id: ids.contato,
      title: NEGOCIO, position_in_stage: 1000, source: "manual", tags: [],
    });
    const agora = new Date();
    ids.run = await insere("supervisor_runs", {
      organization_id: org, conversation_id: ids.conversa, contact_id: ids.contato, lead_id: ids.lead,
      last_message_at: agora.toISOString(), last_message_id: crypto.randomUUID(), status: "analyzed",
      summary: "Cliente pediu a calça no 38 e combinou passar na loja.",
    });
    const base = { organization_id: org, run_id: ids.run, conversation_id: ids.conversa, contact_id: ids.contato, lead_id: ids.lead };
    ids.aplicada = await insere("supervisor_actions", {
      ...base, kind: "move_stage", risk: "baixo", status: "applied", dedup_key: `e2e:${SUFIXO}:mover`,
      before: { stage_id: ids.etapaA, stage_name: "Em atendimento" }, after: { stage_id: ids.etapaB, stage_name: "Proposta" },
      reason: "Vendedora enviou a proposta com o preço.", evidence: [{ quem: "vendedor", trecho: "Fica R$ 189,90", message_id: crypto.randomUUID() }],
    });
    ids.pendente = await insere("supervisor_actions", {
      ...base, kind: "add_tag", risk: "condicional", status: "pending_approval", dedup_key: `e2e:${SUFIXO}:tag`,
      after: { tag: TAG }, reason: "Cliente pediu para separar a peça.", evidence: [],
    });
    const verificacao =
      "Combinado/último contato em 14/11/2026 às 10h05 (“Amanhã passo aí”); o acompanhamento era devido até 15/11/2026 às 09h00; " +
      "não há mensagem do vendedor registrada no WhatsApp entre a combinação e 18/11/2026 às 03h57. Contato por outro canal (ligação, visita) não é observável aqui.";
    ids.relatorio = await insere("supervisor_reports", {
      organization_id: org, period_from: new Date(Date.now() - 7 * 86_400_000).toISOString(), period_to: agora.toISOString(),
      status: "done", conversations_eligible: 1, conversations_analyzed: 1,
      metrics: { categorias: [{ codigo: "compromisso_nao_cumprido", atendimentos: 1 }] },
      diagnosis: {
        versao: 2, completo: true,
        contexto: { organizacao: "E2E", fuso: "America/Sao_Paulo", nicho: "Loja de moda", criterios_formais: false, base: "ramo" },
        resumo_executivo: `Resumo E2E ${SUFIXO}: a visita combinada não teve confirmação registrada.`,
        gargalos: [], pontos_positivos: [], riscos: [], recomendacoes_priorizadas: [], limitacoes: [],
        casos: [{
          conversation_id: ids.conversa, lead_id: ids.lead, contact_id: ids.contato, titulo: NEGOCIO, tipo: "problema",
          motivo_da_escolha: "Visita combinada sem confirmação", situacao: "Visita combinada e não confirmada", estagio: "compromisso já combinado",
          contexto: "A cliente combinou passar na loja.", evidencias: [{ quem: "cliente", texto: "Amanhã passo aí para provar", em: "2026-11-14T13:05:00Z" }],
          positivos: [], faltou: [{ titulo: "Confirmação da visita", explicacao: "Não houve confirmação no dia combinado." }],
          verificacoes: [verificacao], como_melhorar: [], follow_up_sugerido: null, resumo: "Faltou confirmar a visita.",
          limitacao: null, recorrencia: null, outros_achados: [],
        }],
      },
    });
    mensagensAntes = await contar("messages");
    chamadasDeIaAntes = await contar("llm_calls");
  });

  test.afterAll(async () => {
    await admin.from("supervisor_reports").delete().eq("id", ids.relatorio);
    await admin.from("supervisor_runs").delete().eq("id", ids.run);
    await admin.from("crm_lead_activities").delete().eq("lead_id", ids.lead);
    await admin.from("crm_leads").delete().eq("id", ids.lead);
    await admin.from("crm_stages").delete().eq("pipeline_id", ids.pipeline);
    await admin.from("crm_pipelines").delete().eq("id", ids.pipeline);
  });

  test("a porta no menu leva à tela, e a configuração salva liga o Supervisor no funil escolhido", async ({ page }) => {
    await login(page, creds.users.admin!.email, creds.password);
    await page.goto("/app/analise");
    await page.getByRole("link", { name: /Supervisor Comercial/ }).first().click();
    await page.waitForURL(/\/app\/analise\/supervisor/);
    await page.getByRole("tab", { name: "Configuração" }).click();
    const config = page.getByTestId("supervisor-config");
    await config.getByRole("switch").first().click();
    await config.locator("label", { hasText: FUNIL }).locator("input[type=checkbox]").check();
    await page.getByRole("button", { name: "Salvar configuração" }).click();
    await expect(page.getByTestId("supervisor-msg")).toHaveText(/salva/i);
    const { data } = await admin.from("supervisor_settings").select("enabled, config").eq("organization_id", creds.org_id).single();
    expect((data as { enabled: boolean }).enabled).toBe(true);
    expect((data as { config: { pipelines: string[] } }).config.pipelines).toContain(ids.pipeline);
    await captura(page, "1-configuracao");
  });

  test("o diário mostra a ação feita, com links para o card do negócio e para o Inbox", async ({ page }) => {
    await login(page, creds.users.manager!.email, creds.password);
    await page.goto("/app/analise/supervisor");
    const linha = page.getByTestId("supervisor-acao").filter({ hasText: NEGOCIO }).first();
    await expect(linha).toContainText("Moveu o negócio");
    await expect(linha.getByRole("link", { name: "Abrir o card do negócio" })).toHaveAttribute("href", `/app/pipelines/${ids.pipeline}?lead=${ids.lead}`);
    await expect(linha.getByRole("link", { name: "Abrir a conversa no Inbox" })).toHaveAttribute("href", `/app/inbox?id=${ids.conversa}`);
    await captura(page, "2-diario");
  });

  test("aprovar uma pendência pela tela aplica a tag e fecha a ação como aprovada", async ({ page }) => {
    await login(page, creds.users.manager!.email, creds.password);
    await page.goto("/app/analise/supervisor");
    await page.getByRole("tab", { name: /Pendências/ }).click();
    const pendencia = page.getByTestId("supervisor-acao").filter({ hasText: TAG }).first();
    await pendencia.getByRole("button", { name: "Aprovar" }).click();
    await expect
      .poll(async () => {
        const { data } = await admin.from("supervisor_actions").select("status").eq("id", ids.pendente).single();
        return (data as { status: string }).status;
      }, { timeout: 30_000 })
      .toBe("approved");
    const { data: lead } = await admin.from("crm_leads").select("tags").eq("id", ids.lead).single();
    expect((lead as { tags: string[] }).tags).toContain(TAG);
    await captura(page, "3-aprovada");
  });

  test("o diagnóstico mostra como a ausência foi verificada, e o PDF sai sem chamada de IA", async ({ page }) => {
    await login(page, creds.users.manager!.email, creds.password);
    await page.goto("/app/analise/supervisor");
    await page.getByRole("tab", { name: "Diagnóstico" }).click();
    await expect(page.getByTestId("supervisor-diagnostico")).toContainText(`Resumo E2E ${SUFIXO}`);
    await expect(page.getByTestId("supervisor-caso-verificacao")).toContainText("não há mensagem do vendedor registrada no WhatsApp");
    await captura(page, "4-diagnostico");

    const href = await page.getByTestId("supervisor-pdf").getAttribute("href");
    expect(href).toBeTruthy();
    const resp = await page.request.get(href!);
    expect(resp.status()).toBe(200);
    expect(resp.headers()["content-type"]).toContain("application/pdf");
    expect((await resp.body()).subarray(0, 5).toString()).toBe("%PDF-");
    expect(await contar("llm_calls")).toBe(chamadasDeIaAntes);
  });

  test("nenhuma mensagem foi enviada ao cliente durante tudo isso", async () => {
    expect(await contar("messages")).toBe(mensagensAntes);
  });
});
