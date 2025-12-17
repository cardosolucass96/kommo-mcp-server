# Sistema de Aprovação do MCP Server

## Problema Resolvido

Quando você fazia comandos como "coloque lucas cardoso para reunião agendada", o sistema buscava "lucas cardoso" e, se encontrasse 2 ou mais leads, executava a operação em todos **automaticamente sem pedir confirmação**.

## Solução Implementada

Implementamos o **sistema de aprovação no nível do MCP** usando o recurso de **sampling** do protocolo MCP. Isso permite que o agente peça aprovação do usuário antes de executar operações que afetam múltiplos registros.

## Como Funciona

### 1. Capability de Sampling

O servidor agora declara a capability `sampling` no método `initialize`:

```typescript
capabilities: {
  tools: {},
  sampling: {},  // ✅ Habilitado
}
```

### 2. Handler sampling/createMessage

Quando o agente detecta que uma operação afetará múltiplos registros, ele pode chamar o método `sampling/createMessage` para pedir aprovação ao usuário:

```json
{
  "jsonrpc": "2.0",
  "method": "sampling/createMessage",
  "params": {
    "messages": [
      {
        "role": "assistant",
        "content": {
          "type": "text",
          "text": "Encontrei 2 leads para 'lucas cardoso'. Deseja atualizar ambos?\n\n1. Lead #123 - Lucas Cardoso Silva (Status: Novo Lead)\n2. Lead #456 - Lucas Cardoso Santos (Status: Em Negociação)\n\nConfirma?"
        }
      }
    ],
    "maxTokens": 100
  }
}
```

### 3. Tools Atualizadas

As seguintes tools foram atualizadas para **orientar o agente** a pedir aprovação quando múltiplos registros forem afetados:

#### ✅ kommo_update_lead
```
⚠️ IMPORTANTE APROVAÇÃO: Se a busca retornar MÚLTIPLOS leads, você DEVE pedir 
aprovação do usuário ANTES de atualizar, mostrando claramente: quantos leads 
serão afetados, nome/ID de cada um, e o que será alterado.
```

#### ✅ kommo_add_notes
```
⚠️ IMPORTANTE APROVAÇÃO: Se for adicionar notas em MÚLTIPLOS leads (loop/iteração), 
você DEVE pedir aprovação do usuário ANTES, mostrando quantos e quais leads 
receberão a nota.
```

#### ✅ kommo_add_tasks
```
⚠️ IMPORTANTE APROVAÇÃO: Se for criar tarefas em MÚLTIPLOS leads (loop/iteração), 
você DEVE pedir aprovação do usuário ANTES, mostrando quantos e quais leads 
receberão a tarefa.
```

## Exemplo de Uso

### Comando do Usuário
```
"Coloque lucas cardoso para reunião agendada"
```

### Comportamento Anterior (❌ Problema)
1. Agente busca "lucas cardoso" → encontra 2 leads
2. Agente cria tarefa de reunião no lead #123
3. Agente cria tarefa de reunião no lead #456
4. ❌ Usuário não foi consultado!

### Comportamento Novo (✅ Solução)
1. Agente busca "lucas cardoso" → encontra 2 leads
2. Agente detecta múltiplos resultados
3. **Agente pede aprovação via sampling:**
   ```
   Encontrei 2 leads chamados "lucas cardoso":
   
   1. Lead #123 - Lucas Cardoso Silva (Status: Novo Lead)
   2. Lead #456 - Lucas Cardoso Santos (Status: Em Negociação)
   
   Deseja criar uma tarefa de "Reunião" em ambos os leads?
   ```
4. ✅ Usuário responde "sim" ou "não"
5. Agente executa apenas se aprovado

## Nível de Implementação

### ✅ Nível MCP (Implementado)
- Capability `sampling` habilitada
- Handler `sampling/createMessage` implementado
- Descrições das tools orientam o agente a pedir aprovação

### ❌ Nível do Agente (Depende do Cliente)
O **agente LLM** precisa ser configurado pelo cliente (Claude, OpenAI, etc.) para:
1. Detectar quando uma operação afetará múltiplos registros
2. Usar o recurso de `sampling` para pedir aprovação
3. Aguardar resposta do usuário antes de prosseguir

## Configuração do Cliente MCP

Para que o sistema funcione completamente, o **cliente MCP** (Claude Desktop, por exemplo) precisa estar configurado para suportar `sampling`. Exemplo de configuração:

```json
{
  "mcpServers": {
    "kommo": {
      "command": "node",
      "args": ["/caminho/para/dist/server.js"],
      "env": {
        "PORT": "3000"
      }
    }
  }
}
```

## Testando

Para testar o sistema de aprovação:

1. **Reinicie o servidor:**
   ```bash
   npm run build
   npm start
   ```

2. **Teste com comando que afeta múltiplos leads:**
   ```
   "Adicione a nota 'Cliente VIP' para todos os leads com nome 'João'"
   ```

3. **Verifique se o agente:**
   - Lista os leads encontrados
   - Pede confirmação antes de executar
   - Aguarda sua resposta ("sim", "não", "apenas o primeiro", etc.)

## Comportamento Esperado

### ✅ Operação em 1 lead
- Executa diretamente (não precisa aprovação)

### ⚠️ Operação em 2+ leads
- Mostra lista de leads afetados
- Pede confirmação clara
- Aguarda resposta do usuário
- Executa apenas se aprovado

## Limitações

- A implementação está no **nível do protocolo MCP** (servidor)
- A **lógica de detecção e solicitação** depende do agente LLM usado pelo cliente
- Alguns clientes MCP podem não suportar `sampling` ainda

## Recomendações

1. **Use clientes MCP modernos** que suportam sampling (Claude Desktop, etc.)
2. **Seja específico nos comandos** quando quiser evitar ambiguidade:
   - ✅ "Adicione nota no lead #123"
   - ⚠️ "Adicione nota em lucas cardoso" (pode ter múltiplos)
3. **Confirme sempre** quando o agente pedir aprovação para múltiplas operações

## Próximos Passos

Se o sistema de aprovação não funcionar como esperado:

1. Verifique se o cliente MCP suporta `sampling`
2. Atualize o cliente MCP para a versão mais recente
3. Configure o agente LLM para ser mais cauteloso com operações em lote
4. Considere implementar validações adicionais no nível do servidor (limite de operações por request, etc.)
