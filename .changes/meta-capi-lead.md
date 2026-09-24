---
impacto: capacidade_nova
secao: adicionado
titulo: Leads de anúncios da Meta passam a ser reportados no nascimento
---

Quando uma conversa de anúncio da Meta cria um negócio automaticamente, o CRM
agora reporta o evento **Lead** para a Meta Conversions API. Se esse negócio for
ganho depois, o evento de compra continua sendo enviado como antes: os dois
sinais coexistem e não duplicam um ao outro.

O envio só acontece quando a própria mensagem que criou o negócio traz um
`ctwa_clid` válido. O identificador do anúncio, uma origem antiga do contato ou
um negócio criado manualmente não são tratados como um novo Lead de anúncio.

Em **Configurações → Conversões**, a lista passa a identificar se a pendência é
de Lead ou de compra. Nenhuma configuração nova é necessária para quem já usa a
conexão da Meta.
