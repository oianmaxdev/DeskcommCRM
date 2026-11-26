import { readdirSync, readFileSync, statSync } from "node:fs";
import { nomeiaProvider, PADROES } from "../../scripts/lint-channels.pattern";
import { join, relative } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * O SUPERVISOR NÃO TEM CAMINHO DE ENVIO — e isto é medido no código, não
 * prometido no prompt.
 *
 * Varre todo arquivo do Supervisor (lib, rotas, cron, tela) e reprova import de
 * qualquer módulo que envia mensagem, monta resposta do agente ou fala com o
 * provedor de canal. O único efeito que pode terminar numa mensagem é inscrever
 * o contato num fluxo de follow-up já publicado (`lib/followup/enroll`), que
 * leva os gates de opt-out, janela e canal do motor de follow-up.
 */
const RAIZ = join(__dirname, "..", "..");
const ALVOS = [
  "lib/supervisor",
  "app/api/v1/supervisor",
  "app/api/v1/cron/supervisor-comercial",
  "app/app/analise/supervisor",
];
const PROIBIDOS = [
  /@\/lib\/messaging/,
  /@\/lib\/channels/,
  /@\/lib\/inbox/,
  /@\/lib\/ai\/replies/,
  /@\/lib\/agent-engine\/(agent|edge\/send|edge\/whatsapp)/,
  /@\/lib\/followup\/(engine|enviar|node-handlers|turn-bridge)/,
  /sendMessage|sendText|enviarMensagem|enviarTexto/,
];

function arquivos(dir: string): string[] {
  const abs = join(RAIZ, dir);
  return readdirSync(abs).flatMap((n) => {
    const p = join(abs, n);
    if (statSync(p).isDirectory()) return arquivos(relative(RAIZ, p));
    return /\.(ts|tsx)$/.test(n) && !n.endsWith(".test.ts") ? [p] : [];
  });
}

describe("Supervisor sem caminho de envio", () => {
  const todos = ALVOS.flatMap(arquivos);

  it("a varredura alcança os arquivos (controle positivo)", () => {
    expect(todos.length).toBeGreaterThanOrEqual(10);
    expect(todos.some((f) => f.endsWith("executor.ts"))).toBe(true);
  });

  it.each(ALVOS.flatMap(arquivos).map((f) => [relative(RAIZ, f), f]))("%s não importa emissor", (_rel, f) => {
    const imports = readFileSync(f as string, "utf8")
      .split("\n")
      .filter((l) => /^\s*import\b|require\(|await import\(/.test(l) || /\b(sendMessage|sendText|enviarMensagem|enviarTexto)\b/.test(l));
    for (const l of imports) {
      for (const p of PROIBIDOS) expect(l).not.toMatch(p);
      // Qualquer transporte de canal, pelo MESMO detector da cerca lint:channels.
      expect(nomeiaProvider(l), l).toBe(false);
    }
  });

  it("a guarda tem dente: uma linha de import de envio seria reprovada", () => {
    expect(PROIBIDOS.some((p) => p.test('import { sendText } from "@/lib/x/client";'))).toBe(true);
    // O nome do transporte sai do próprio detector, para este arquivo não nomeá-lo.
    const transporte = /\(([a-z_]+)\|/.exec(PADROES.SEPARADO.source)?.[1] ?? "";
    expect(transporte).not.toBe("");
    expect(nomeiaProvider(`import { cliente } from "@/lib/${transporte}/client";`)).toBe(true);
  });
});
