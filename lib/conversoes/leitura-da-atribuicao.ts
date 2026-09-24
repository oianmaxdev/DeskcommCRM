/**
 * Ler de qual anúncio o contato veio — o outro lado da 0164.
 *
 * A 0164 (`lib/leads/atribuicao-de-anuncio.ts`) ESTAMPA a atribuição no contato,
 * com guarda de primeiro toque e merge atômico no banco. Este arquivo é o
 * primeiro consumidor dela: até aqui o dado era só de escrita.
 *
 * Não reaproveito o tipo `AtribuicaoDeAnuncio` daquele módulo de propósito. Ele
 * é o formato de ESCRITA e carrega `bruto` — o payload inteiro de onde o dado
 * saiu, que existe para ser prova e pode ter qualquer tamanho. Quem vai enviar
 * precisa de três campos. O leitor consulta `ad_raw` apenas para comprovar o
 * `ctwa_clid` Meta legado e nunca repassa o payload cru ao transporte ou log.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { ehPlataformaConhecida } from "@/lib/plataformas-de-anuncio/registry";
import type { PlataformaDeAnuncio } from "@/lib/plataformas-de-anuncio/types";

export interface AtribuicaoParaEnvio {
  plataforma: PlataformaDeAnuncio;
  /** Clique verificado no referral Meta ou `gclid` capturado do Google. */
  cliqueDeOrigem: string;
  telefone: string | null;
}

export type LeituraDeAtribuicao =
  | { temAtribuicao: true; atribuicao: AtribuicaoParaEnvio }
  | { temAtribuicao: false; motivo: "sem_contato" | "sem_atribuicao" | "plataforma_desconhecida" };

/**
 * ⚠️ FILTRA `organization_id` MESMO TENDO O ID DO CONTATO. O chamador é um
 * worker com client service-role, que bypassa RLS: um `contact_id` de outra
 * organização (por dado corrompido ou por bug de quem monta o evento) leria o
 * telefone e o clique de um terceiro e reportaria a venda na conta de anúncios
 * errada. O mesmo padrão de `encerraDemanda`, e pelo mesmo motivo.
 */
export async function lerAtribuicao(
  admin: SupabaseClient,
  organizationId: string,
  contactId: string | null,
): Promise<LeituraDeAtribuicao> {
  if (!contactId) return { temAtribuicao: false, motivo: "sem_contato" };

  const { data } = await admin
    .from("contacts")
    .select("phone_number, source_metadata")
    .eq("id", contactId)
    .eq("organization_id", organizationId)
    .maybeSingle();

  if (!data) return { temAtribuicao: false, motivo: "sem_contato" };

  const linha = data as { phone_number: string | null; source_metadata: unknown };
  const meta =
    linha.source_metadata && typeof linha.source_metadata === "object"
      ? (linha.source_metadata as Record<string, unknown>)
      : {};
  if (meta.ad_platform == null) {
    return { temAtribuicao: false, motivo: "sem_atribuicao" };
  }

  // Plataforma que não está no vocabulário significa dado gravado por uma versão
  // futura (ou corrompido). Recusar explicitamente é melhor que assumir a Meta e
  // reportar a venda na conta errada.
  if (!ehPlataformaConhecida(meta.ad_platform)) {
    return { temAtribuicao: false, motivo: "plataforma_desconhecida" };
  }

  // Antes da Feature A, o extrator Meta caía de `ctwa_clid` para `source_id`
  // (id do anúncio) e gravava ambos em `ad_source_id`. Uma linha antiga sem
  // referral bruto não prova qual dos dois foi persistido. A prova do clique
  // está no campo próprio do payload causal, inclusive para dados legados.
  const bruto = meta.ad_raw && typeof meta.ad_raw === "object" && !Array.isArray(meta.ad_raw)
    ? (meta.ad_raw as Record<string, unknown>)
    : null;
  const clid = bruto?.ctwa_clid ?? bruto?.ctwaClid;
  const clique = meta.ad_platform === "meta_ads"
    ? (typeof clid === "string" ? clid.trim() : "")
    : (typeof meta.ad_source_id === "string" ? meta.ad_source_id.trim() : "");
  if (!clique) return { temAtribuicao: false, motivo: "sem_atribuicao" };

  return {
    temAtribuicao: true,
    atribuicao: {
      plataforma: meta.ad_platform,
      cliqueDeOrigem: clique,
      // Só dígitos: a plataforma exige E.164 sem `+` nem separadores ANTES do
      // hash. Normalizar depois do hash seria tarde — o hash já estaria errado.
      telefone: linha.phone_number ? linha.phone_number.replace(/\D/g, "") || null : null,
    },
  };
}
