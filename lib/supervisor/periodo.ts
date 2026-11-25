/** O período de um diagnóstico, como a tela pede. Puro — testado em periodo.test.ts. */
import { z } from "zod";

export const periodoSchema = z.object({
  periodo: z.enum(["hoje", "7d", "15d", "30d", "custom"]),
  de: z.string().datetime({ offset: true }).optional(),
  ate: z.string().datetime({ offset: true }).optional(),
  owner_user_id: z.string().uuid().nullable().optional(),
  pipeline_id: z.string().uuid().nullable().optional(),
});
export type PedidoDePeriodo = z.infer<typeof periodoSchema>;

export function resolvePeriodo(p: PedidoDePeriodo, agora: Date): { de: Date; ate: Date } | null {
  if (p.periodo === "custom") {
    if (!p.de || !p.ate) return null;
    const de = new Date(p.de);
    const ate = new Date(p.ate);
    if (!(ate > de) || ate.getTime() - de.getTime() > 366 * 24 * 3600 * 1000) return null;
    return { de, ate };
  }
  if (p.periodo === "hoje") {
    const de = new Date(agora);
    de.setHours(0, 0, 0, 0);
    return { de, ate: agora };
  }
  const dias = Number(p.periodo.replace("d", ""));
  return { de: new Date(agora.getTime() - dias * 24 * 3600 * 1000), ate: agora };
}

