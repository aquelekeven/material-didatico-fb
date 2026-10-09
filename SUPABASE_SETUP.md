# Configuração do Supabase

O frontend já está apontando para o projeto:

- Project URL: `https://zjlrkptqlxnbiubxkivg.supabase.co`
- chave no navegador: **publishable key**

A secret/service role **não fica no HTML**.

## 1. Criar/atualizar as tabelas

No Supabase:

1. Abra **SQL Editor**.
2. Crie uma nova query.
3. Copie todo o conteúdo de `supabase/setup.sql`.
4. Clique em **Run**.

Esse SQL pode ser executado mesmo se a versão anterior do banco já tiver sido criada.

## 2. Publicar a Edge Function

A função está em:

`supabase/functions/material-api/index.ts`

Ela precisa ser publicada com **JWT verification desativada**, porque este app não usa Supabase Auth; a própria função valida o PIN e a sessão do dispositivo.

Se usar Supabase CLI, o repositório já contém:

`supabase/config.toml`

com:

```toml
[functions.material-api]
verify_jwt = false
```

Também é possível criar/deployar a função pelo editor de Edge Functions do Dashboard e colar o conteúdo do `index.ts`.

## 3. Como o acesso funciona

Na primeira entrada, a pessoa informa:

- nome livre (por exemplo: Alessandra)
- PIN de 4 números

Se o nome ainda não existe, ele é criado e aquele PIN fica associado ao nome.

Nas próximas entradas, o mesmo nome exige o mesmo PIN.

A identidade do usuário do app é independente da lista de designers. Portanto, Alessandra pode entrar e alterar o painel sem virar uma opção de designer.

A sessão fica lembrada no navegador por até 90 dias. O botão **Trocar** no topo permite mudar de pessoa.

## 4. Auditoria escondida

O histórico **não aparece em nenhum lugar da interface**.

Ele é gravado em:

`public.material_didatico_audit_log`

e não possui permissão de leitura para `anon` ou `authenticated`.

O log registra, quando disponível:

- nome declarado
- horário
- alterações realizadas
- dispositivo
- user-agent
- IP observado pelo backend

O IP é apenas informação auxiliar: pessoas na mesma rede corporativa podem compartilhar o mesmo IP público e VPNs/redes diferentes podem alterá-lo.

Para consultar manualmente como administrador, use o Table Editor do Supabase ou uma query no SQL Editor, por exemplo:

```sql
select
  created_at,
  user_name,
  action,
  device_id,
  ip_observed,
  user_agent,
  details
from public.material_didatico_audit_log
order by created_at desc;
```

## 5. Segurança

O navegador possui apenas a publishable key e permissão de leitura do estado.

As alterações passam pela Edge Function:

`navegador -> validação de sessão/PIN -> atualização do estado -> log de auditoria`

O PIN é armazenado como hash PBKDF2 com salt, nunca em texto puro.

Após 5 tentativas de PIN incorreto para um nome, esse perfil fica bloqueado por 10 minutos.

### Esqueci o PIN

Como não existe e-mail/login, a recuperação é administrativa. A forma mais simples é excluir manualmente o perfil em `material_didatico_users`; o histórico antigo permanece porque o log usa `ON DELETE SET NULL` no ID e preserva o nome gravado.
