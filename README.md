# Material Didático FB - Prazos

Painel compartilhado para acompanhamento da produção de materiais didáticos da Fundação Bradesco.

## Recursos
- acompanhamento por material e designer
- progresso por página diagramada
- data prevista de início
- projeção de envio à gráfica e entrega impressa
- calendário de produção
- cálculo de dias úteis e carga por designer
- Supabase como estado compartilhado
- atualizações em tempo real entre navegadores
- identificação informal por nome + PIN de 4 dígitos
- histórico de alterações oculto da interface
- localStorage como cache/fallback

## Identidade x designer

Quem usa o sistema não precisa ser designer. A identidade serve apenas para registrar autoria das alterações; a lista de designers continua sendo administrada separadamente dentro do painel.

## Configuração

1. Execute `supabase/setup.sql` no SQL Editor.
2. Publique `supabase/functions/material-api/index.ts` como Edge Function com `verify_jwt = false`.

Veja `SUPABASE_SETUP.md` para o passo a passo.
