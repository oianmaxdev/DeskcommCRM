/**
 * "Registre o fato, mas não dispare automação em cima dele."
 *
 * Existe para o Supervisor Comercial por IA (lib/supervisor). Quando ele move um
 * negócio de etapa ou aplica uma tag SOZINHO, o evento (`lead.stage_changed`,
 * `lead.tag_added`) continua sendo emitido — a linha do tempo, as métricas, o
 * retorno ao fluxo e a medição de conversão dependem dele, e tirá-lo faria o
 * movimento do Supervisor sumir de tudo que lê o `event_log`.
 *
 * O que NÃO pode acontecer é uma decisão administrativa da IA virar MENSAGEM
 * para o cliente por tabela: regras de automação (`send_whatsapp_message`,
 * `send_ai_message`, `call_webhook`, `start_message_flow`) e o gatilho de
 * follow-up por etapa ouvem esses eventos. Os consumidores que podem terminar
 * em envio leem esta marca e pulam o evento, com o motivo no `event_log`.
 *
 * A organização pode optar por disparar (`movimento_dispara_automacoes` na
 * política do Supervisor), e movimento APROVADO por um gestor é decisão humana:
 * nesses dois casos a marca não vai.
 */
export const SEM_DISPARO_AUTOMATICO = "sem_disparo_automatico";

export function eventoPedeSemDisparo(metadata: Record<string, unknown> | null | undefined): boolean {
  return metadata?.[SEM_DISPARO_AUTOMATICO] === true;
}
