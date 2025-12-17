# Kommo MCP Server

Servidor MCP (Model Context Protocol) para integração com o CRM Kommo via Fastify + Node.js.

## 🎯 Características

- **Multi-tenant**: Suporta múltiplas contas Kommo via token Bearer
- **MCP over HTTP**: Protocolo JSON-RPC 2.0 (Streamable)
- **Sistema de Aprovação**: Pede confirmação antes de operações em múltiplos registros (via sampling)
- **Cache inteligente**: Pipelines e campos customizados cacheados
- **Validação de entrada**: Schemas Zod para validação robusta de parâmetros
- **Type-safe**: TypeScript com strict mode e tipagens completas
- **Error handling**: Tratamento de erros estruturado com códigos JSON-RPC
- **Logging**: Sistema de logs integrado com Fastify
- **Segurança**: Validação de tokens, variáveis de ambiente obrigatórias

## 📦 Instalação

```bash
npm install
npm run build
```

## ⚙️ Configuração

Crie um arquivo `.env` na raiz (copie de `.env.example`):

```env
PORT=3000
HOST=0.0.0.0
MCP_PASSWORD=SuaSenhaSegura123
```

⚠️ **IMPORTANTE**: 
- `MCP_PASSWORD` é **OBRIGATÓRIO** - o servidor não inicia sem ele
- Nunca use senhas fracas ou padrão em produção
- Nunca commite o arquivo `.env` com credenciais reais

## 🚀 Executar localmente

```bash
# Desenvolvimento (inicia servidor + MCP Inspector)
npm run dev

# Apenas o servidor
npm start

# Build + Servidor (sem inspector)
npm run build && npm start

# Watch mode (recompila automaticamente)
npm run dev:watch

# Apenas MCP Inspector
npm run inspector
```

Quick start:

```bash
# Instalar dependências
npm install

# Desenvolvimento (servidor + inspector)
npm run dev

# Produção
npm run build
npm start
```

## 🔐 Autenticação

Formato do token Bearer:
```
MCP_PASSWORD|subdomain|kommoAccessToken
```

Exemplo:
```bash
curl -H "Authorization: Bearer Admin123|mpcamotestecom|eyJ0eXAi..." \
     -H "Content-Type: application/json" \
     -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' \
     http://localhost:3000/mcp
```

## 📡 Endpoints

| Método | Endpoint | Descrição |
|--------|----------|-----------|
| GET | `/` | Health check |
| GET | `/health` | Health check |
| POST | `/mcp` | MCP Protocol (JSON-RPC 2.0) |
| DELETE | `/mcp` | Encerrar sessão |
| GET | `/tools` | Listar ferramentas (legacy) |
| POST | `/execute` | Executar ferramenta (legacy) |

## 🔧 Ferramentas Disponíveis

| Ferramenta | Descrição | Validação |
|------------|-----------|-----------|
| `kommo_list_leads` | Lista/busca leads | ✅ Zod schema |
| `kommo_update_lead` | Atualiza lead (nome, preço, status, campos customizados) | ✅ Zod schema |
| `kommo_add_notes` | Adiciona notas ao lead | ✅ Zod schema |
| `kommo_add_tasks` | Cria tarefas/lembretes | ✅ Zod schema |
| `kommo_list_pipelines` | Lista pipelines e estágios (cached) | - |
| `kommo_list_pipeline_stages` | Lista estágios de um pipeline (cached) | ✅ Zod schema |
| `kommo_list_lead_custom_fields` | Lista campos customizados (cached) | - |

### Cache
- **Pipelines**: 10 minutos
- **Estágios**: 10 minutos
- **Campos customizados**: 1 hora

## 🔄 Uso com n8n

```
1. kommo_start_session  → Inicia atendimento com lead
2. kommo_update_lead    → Modifica dados
3. kommo_add_notes      → Registra observações
4. kommo_add_tasks      → Cria follow-ups
5. kommo_end_session    → Encerra atendimento
```

## ⚠️ Boas Práticas e Segurança

### Segurança
- ✅ Senha obrigatória via variável de ambiente
- ✅ Validação de entrada com Zod schemas
- ✅ Tokens multi-parte com validação
- ✅ Error handling estruturado
- ✅ Logs de erros com Fastify

### Desenvolvimento
- ✅ TypeScript com strict mode
- ✅ Tipagens completas (FastifyRequest, FastifyReply)
- ✅ Constantes centralizadas em arquivo separado
- ✅ Schemas de validação reutilizáveis
- ✅ Cache configurável por TTL

### Código Limpo
- ✅ Separação de responsabilidades (types, schemas, constants)
- ✅ Error codes padronizados (JSON-RPC 2.0)
- ✅ Mensagens de erro descritivas
- ✅ Validação early-return

### Documentação
- 📄 `README.md` - Visão geral e setup
- 📄 `USAGE.md` - Exemplos práticos de uso com curl
- 📄 `APPROVAL-SYSTEM.md` - Sistema de aprovação para operações em múltiplos registros
- 📄 `src/constants.ts` - Constantes e configurações
- 📄 `src/schemas.ts` - Schemas de validação

## 🔐 Sistema de Aprovação

O servidor implementa um sistema de aprovação via **MCP sampling** para operações que afetam múltiplos registros. Quando você executa comandos como "adicione nota em lucas cardoso" e existem 2 ou mais leads com esse nome, o agente **pedirá aprovação** antes de executar.

**Consulte `APPROVAL-SYSTEM.md` para detalhes completos.**

## 🛠️ Desenvolvimento

```bash
# Build
npm run build

# Dev mode
npm run dev

# Watch mode
npm run dev:watch
```