/**
 * Todo schema que o Supervisor manda a um modelo precisa caber no modo ESTRITO
 * de saída estruturada da OpenAI: em todo objeto, toda chave de `properties`
 * aparece em `required` (o "opcional" se expressa com `null`, nunca omitindo a
 * chave).
 *
 * Achado na demo PipeMax (28/11/2026), na v1.126.1002: `prazo_iso` era
 * `.nullable().optional()` e a OpenAI recusou 100% das leituras pela
 * assinatura ChatGPT ("'required' is required to be supplied and to be an
 * array including every key in properties. Missing 'prazo_iso'"). O Gemini
 * aceitava, e por isso a homologação não viu.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { analiseSchema } from "./analise";
import { casosSchema, diagnosticoSchema } from "./diagnostico";

type No = { type?: string | string[]; properties?: Record<string, No>; required?: string[]; items?: No | No[]; anyOf?: No[]; oneOf?: No[] };

function chavesForaDoRequired(no: No, caminho: string, out: string[]): void {
  if (no.properties) {
    const req = new Set(no.required ?? []);
    for (const [k, filho] of Object.entries(no.properties)) {
      if (!req.has(k)) out.push(`${caminho}.${k}`);
      chavesForaDoRequired(filho, `${caminho}.${k}`, out);
    }
  }
  const itens = Array.isArray(no.items) ? no.items : no.items ? [no.items] : [];
  for (const i of itens) chavesForaDoRequired(i, `${caminho}[]`, out);
  for (const alt of [...(no.anyOf ?? []), ...(no.oneOf ?? [])]) chavesForaDoRequired(alt, caminho, out);
}

describe("schemas do Supervisor × modo estrito da OpenAI", () => {
  it.each([
    ["analiseSchema", analiseSchema],
    ["diagnosticoSchema", diagnosticoSchema],
    ["casosSchema", casosSchema],
  ] as const)("%s: toda chave de todo objeto está em required", (_nome, schema) => {
    const json = z.toJSONSchema(schema as z.ZodType, { io: "input" }) as No;
    const fora: string[] = [];
    chavesForaDoRequired(json, "$", fora);
    expect(fora, "chave opcional quebra o modo estrito: use .nullable() em vez de .optional()").toEqual([]);
  });

  it("a guarda tem dente: um campo .optional() é apontado", () => {
    const json = z.toJSONSchema(z.object({ a: z.string(), b: z.string().nullable().optional() }), { io: "input" }) as No;
    const fora: string[] = [];
    chavesForaDoRequired(json, "$", fora);
    expect(fora).toEqual(["$.b"]);
  });
});
