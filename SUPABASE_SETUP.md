# Configuração do Supabase

O frontend já está configurado para usar o projeto:

- Project URL: `https://zjlrkptqlxnbiubxkivg.supabase.co`
- API key: publishable key (segura para uso no navegador)

## Ativar o banco compartilhado

1. Abra o projeto no Supabase.
2. Vá em **SQL Editor**.
3. Crie uma nova query.
4. Copie todo o conteúdo de `supabase/setup.sql`.
5. Clique em **Run**.
6. Abra/recarregue o painel.

Quando funcionar, o indicador no topo muda para **Online · tempo real**.

## Como funciona

O estado do painel é persistido na tabela `public.material_didatico_state`.
O Realtime escuta alterações nessa tabela e atualiza os outros navegadores automaticamente.

O `localStorage` continua existindo como cache/fallback local.

## Segurança atual

Esta primeira versão usa acesso anônimo via publishable key e RLS limitado à linha `id = 'main'`.
Isso permite que qualquer pessoa que tenha acesso ao site também altere o cronograma.

Se o painel for disponibilizado fora de um ambiente interno/controlado, a próxima melhoria recomendada é adicionar Supabase Auth e restringir escrita aos usuários autorizados.
