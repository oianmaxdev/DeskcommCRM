/**
 * PROVA POR OMISSÃO — como uma falha que é a AUSÊNCIA de algo vira achado
 * comprovado sem que o modelo invente evidência.
 *
 * "Ninguém confirmou a visita" não tem frase a citar. O que se cita é a
 * ORIGEM (a mensagem em que o passo foi combinado, ou a última da conversa) e o
 * que se verifica, em código, é:
 *   1. a origem existe, literal, na janela lida — e por isso TODO o histórico
 *      registrado depois dela também está na janela;
 *   2. o passo já era devido: o prazo combinado (ou 24 h depois da origem),
 *      empurrado para o próximo horário comercial do fuso da empresa;
 *   3. não há mensagem do vendedor, da IA ou de automação depois da combinação
 *      (a troca imediata — até 2 h — é parte da própria combinação);
 *   4. não há retorno programado (tarefa futura ou follow-up ativo).
 *
 * O texto que sai daqui nunca diz que algo "não aconteceu": diz que não há
 * REGISTRO no canal observado até o instante verificado. Ligação, visita ou
 * contato por outro canal não são observáveis aqui.
 */
import { normalizaTexto, type MensagemDaJanela } from "./analise";

export const CODIGOS_DE_OMISSAO = ["sem_follow_up", "compromisso_nao_cumprido"] as const;
export type CodigoDeOmissao = (typeof CODIGOS_DE_OMISSAO)[number];
export const ehOmissao = (c: string): c is CodigoDeOmissao => (CODIGOS_DE_OMISSAO as readonly string[]).includes(c);

/** Sem prazo combinado, o retorno é devido 24 h depois da origem. */
export const PRAZO_PADRAO_MS = 24 * 3600 * 1000;
/** Resposta até aqui depois da origem é a própria combinação, não o acompanhamento. */
export const JANELA_DA_COMBINACAO_MS = 2 * 3600 * 1000;
const INICIO_COMERCIAL = 9;
const FIM_COMERCIAL = 18;

export interface ProvaPorOmissao {
  origem: { mensagem: string; trecho: string; enviada_em: string; quem: MensagemDaJanela["quem"] };
  devido_em: string;
  verificado_ate: string;
  canal: "whatsapp";
}

export type ResultadoDaOmissao =
  | { ok: true; prova: ProvaPorOmissao }
  | {
      ok: false;
      motivo: "origem_nao_citada" | "origem_fora_da_janela" | "ainda_nao_vencido" | "houve_acompanhamento" | "acao_programada";
    };

function partesNoFuso(d: Date, fuso: string | null): { dia: number; hora: number } {
  try {
    const f = new Intl.DateTimeFormat("en-US", { timeZone: fuso ?? "UTC", weekday: "short", hour: "numeric", hourCycle: "h23" });
    const p = Object.fromEntries(f.formatToParts(d).map((x) => [x.type, x.value]));
    const dias = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    return { dia: dias.indexOf(p.weekday ?? "Mon"), hora: Number(p.hour ?? 12) };
  } catch {
    return { dia: d.getUTCDay(), hora: d.getUTCHours() };
  }
}

/**
 * O primeiro instante em horário comercial (seg–sáb, 9h–18h no fuso) a partir
 * de `d`. Avança de hora em hora: simples, e o pior caso é uma semana (168).
 */
export function proximoHorarioComercial(d: Date, fuso: string | null): Date {
  let t = new Date(d.getTime());
  for (let i = 0; i < 24 * 8; i++) {
    const { dia, hora } = partesNoFuso(t, fuso);
    if (dia !== 0 && hora >= INICIO_COMERCIAL && hora < FIM_COMERCIAL) return t;
    // vai para o início da próxima hora cheia
    t = new Date(Math.floor(t.getTime() / 3_600_000) * 3_600_000 + 3_600_000);
  }
  return t;
}

export function provaPorOmissao(p: {
  codigo: CodigoDeOmissao;
  janela: readonly MensagemDaJanela[];
  /** A citação que o modelo deu (origem do passo), se deu. */
  citacao: { mensagem: string; trecho: string } | null | undefined;
  /** Quando o passo combinado era devido, se foi combinado um momento. */
  prazoIso?: string | null;
  agora: Date;
  fuso: string | null;
  /** Há tarefa futura ou follow-up ativo para este negócio/contato? */
  acaoProgramada: boolean;
}): ResultadoDaOmissao {
  if (p.janela.length === 0) return { ok: false, motivo: "origem_fora_da_janela" };
  let origem: MensagemDaJanela | undefined;
  let trecho = "";
  if (p.citacao?.mensagem) {
    origem = p.janela.find((m) => m.ref === p.citacao!.mensagem.trim());
    if (!origem) return { ok: false, motivo: "origem_fora_da_janela" };
    const t = normalizaTexto(p.citacao.trecho ?? "");
    if (t.length < 3 || !normalizaTexto(origem.texto).includes(t)) return { ok: false, motivo: "origem_nao_citada" };
    trecho = p.citacao.trecho.trim();
  } else if (p.codigo === "sem_follow_up") {
    // Falta de retorno se mede a partir da última mensagem da conversa — o
    // sistema a conhece sem depender do modelo.
    origem = p.janela[p.janela.length - 1];
    trecho = origem!.texto.slice(0, 120);
  } else {
    // Compromisso não cumprido exige citar o compromisso.
    return { ok: false, motivo: "origem_nao_citada" };
  }
  const enviada = Date.parse(origem!.enviadaEm);
  const prazo = p.prazoIso && Number.isFinite(Date.parse(p.prazoIso)) ? Date.parse(p.prazoIso) : enviada + PRAZO_PADRAO_MS;
  const devido = proximoHorarioComercial(new Date(Math.max(prazo, enviada)), p.fuso);
  if (p.agora.getTime() < devido.getTime()) return { ok: false, motivo: "ainda_nao_vencido" };

  const acompanhou = p.janela.some(
    (m) => m.quem !== "cliente" && Date.parse(m.enviadaEm) > enviada + JANELA_DA_COMBINACAO_MS,
  );
  if (acompanhou) return { ok: false, motivo: "houve_acompanhamento" };
  if (p.acaoProgramada) return { ok: false, motivo: "acao_programada" };

  return {
    ok: true,
    prova: {
      origem: { mensagem: origem!.ref, trecho, enviada_em: origem!.enviadaEm, quem: origem!.quem },
      devido_em: devido.toISOString(),
      verificado_ate: p.agora.toISOString(),
      canal: "whatsapp",
    },
  };
}

/** A frase de verificação que acompanha o achado na tela e no PDF. Nunca afirma que algo não aconteceu. */
export function fraseDaProva(prova: ProvaPorOmissao, formata: (iso: string) => string): string {
  return (
    `Combinado/último contato em ${formata(prova.origem.enviada_em)} (“${prova.origem.trecho.slice(0, 120)}”); ` +
    `o acompanhamento era devido até ${formata(prova.devido_em)}; ` +
    `não há mensagem do vendedor registrada no WhatsApp entre a combinação e ${formata(prova.verificado_ate)}. ` +
    `Contato por outro canal (ligação, visita) não é observável aqui.`
  );
}
