/**
 * Kommo MCP Server - Cloudflare Workers
 * 
 * Implementa MCP over HTTP (Streamable) para compatibilidade com n8n e outros clientes
 */

// Tipos para Cloudflare Workers
export interface Env {
  KOMMO_BASE_URL: string;
  KOMMO_ACCESS_TOKEN: string;
  API_BEARER_TOKEN: string; // Token para autenticar requisições à API
}

// Importar cliente adaptado para fetch
import { createKommoClient, KommoClientInterface } from "./kommo/clientCF.js";

// Tipos
import {
  LeadsListResponse,
  Lead,
  LeadUpdateRequest,
  NotesCreateResponse,
  NoteCreateRequest,
  TasksCreateResponse,
  TaskCreateRequest,
  PipelinesListResponse,
  StagesListResponse,
} from "./kommo/types.js";

// ========== MCP Protocol Types ==========
interface MCPRequest {
  jsonrpc: "2.0";
  id: string | number;
  method: string;
  params?: Record<string, unknown>;
}

interface MCPResponse {
  jsonrpc: "2.0";
  id: string | number;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
}

interface MCPToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
}

// Cache simples em memória (por worker instance)
const pipelinesCache = new Map<string, { data: unknown; expiresAt: number }>();

function getCached<T>(key: string): T | null {
  const entry = pipelinesCache.get(key);
  if (!entry || Date.now() > entry.expiresAt) {
    pipelinesCache.delete(key);
    return null;
  }
  return entry.data as T;
}

function setCache(key: string, data: unknown, ttlSeconds: number = 600) {
  pipelinesCache.set(key, {
    data,
    expiresAt: Date.now() + ttlSeconds * 1000,
  });
}

// ========== Tool Definitions para MCP ==========
const toolDefinitions: MCPToolDefinition[] = [
  {
    name: "kommo_list_leads",
    description: "Lista leads do Kommo CRM. Use para buscar leads por nome ou listar todos.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Texto para buscar no nome do lead" },
        limit: { type: "number", description: "Quantidade de resultados (padrão: 10)" },
        page: { type: "number", description: "Página para paginação (padrão: 1)" },
      },
    },
  },
  {
    name: "kommo_update_lead",
    description: "Atualiza um lead específico. Pode alterar nome, preço ou status.",
    inputSchema: {
      type: "object",
      properties: {
        lead_id: { type: "number", description: "ID do lead a ser atualizado" },
        name: { type: "string", description: "Novo nome do lead" },
        price: { type: "number", description: "Novo preço/valor do lead" },
        status_id: { type: "number", description: "ID do novo status/estágio" },
      },
      required: ["lead_id"],
    },
  },
  {
    name: "kommo_add_notes",
    description: "Adiciona uma nota/observação a um lead.",
    inputSchema: {
      type: "object",
      properties: {
        lead_id: { type: "number", description: "ID do lead" },
        text: { type: "string", description: "Texto da nota" },
      },
      required: ["lead_id", "text"],
    },
  },
  {
    name: "kommo_add_tasks",
    description: "Cria uma tarefa para um lead. Tipos: 1=Ligar, 2=Reunião, 3=Email.",
    inputSchema: {
      type: "object",
      properties: {
        lead_id: { type: "number", description: "ID do lead" },
        text: { type: "string", description: "Descrição da tarefa" },
        complete_till: { type: "number", description: "Prazo em Unix timestamp" },
        task_type_id: { type: "number", description: "Tipo: 1=Ligar, 2=Reunião, 3=Email" },
      },
      required: ["lead_id", "text", "complete_till"],
    },
  },
  {
    name: "kommo_list_pipelines",
    description: "Lista todos os pipelines (funis) e seus estágios.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "kommo_list_pipeline_stages",
    description: "Lista os estágios de um pipeline específico.",
    inputSchema: {
      type: "object",
      properties: {
        pipeline_id: { type: "number", description: "ID do pipeline" },
      },
      required: ["pipeline_id"],
    },
  },
];

// ========== Tool Handlers ==========
type ToolHandler = (
  params: Record<string, unknown>,
  client: KommoClientInterface
) => Promise<unknown>;

const toolHandlers: Record<string, ToolHandler> = {
  kommo_list_leads: async (params, client) => {
    const { query, limit = 10, page = 1 } = params as { query?: string; limit?: number; page?: number };
    
    const queryParams: Record<string, unknown> = { limit, page };
    if (query) queryParams.query = query;

    const response = await client.get<LeadsListResponse>("/leads", queryParams);
    const leads = response._embedded?.leads || [];

    return { total: leads.length, leads };
  },

  kommo_update_lead: async (params, client) => {
    const { lead_id, name, price, status_id } = params as { 
      lead_id: number;
      name?: string; 
      price?: number; 
      status_id?: number;
    };

    if (!lead_id) throw new Error("lead_id é obrigatório");
    
    const body: LeadUpdateRequest = {};
    if (name) body.name = name;
    if (price !== undefined) body.price = price;
    if (status_id) body.status_id = status_id;

    return await client.patch<Lead>(`/leads/${lead_id}`, body);
  },

  kommo_add_notes: async (params, client) => {
    const { lead_id, text } = params as { lead_id: number; text: string };

    if (!lead_id) throw new Error("lead_id é obrigatório");
    if (!text) throw new Error("text é obrigatório");
    
    const payload: NoteCreateRequest[] = [{
      entity_id: lead_id,
      note_type: "common",
      params: { text },
    }];

    const response = await client.post<NotesCreateResponse>("/leads/notes", payload);
    return response._embedded?.notes || [];
  },

  kommo_add_tasks: async (params, client) => {
    const { lead_id, text, complete_till, task_type_id = 1 } = params as { 
      lead_id: number;
      text: string; 
      complete_till: number; 
      task_type_id?: number;
    };

    if (!lead_id) throw new Error("lead_id é obrigatório");
    if (!text) throw new Error("text é obrigatório");
    if (!complete_till) throw new Error("complete_till é obrigatório");
    
    const payload: TaskCreateRequest[] = [{
      task_type_id,
      text,
      complete_till,
      entity_id: lead_id,
      entity_type: "leads",
      request_id: `task_${Date.now()}`,
    }];

    const response = await client.post<TasksCreateResponse>("/tasks", payload);
    return response._embedded?.tasks || [];
  },

  kommo_list_pipelines: async (_params, client) => {
    const cached = getCached<unknown>("pipelines");
    if (cached) return cached;

    const response = await client.get<PipelinesListResponse>("/leads/pipelines");
    const pipelines = response._embedded?.pipelines || [];

    const formatted = pipelines.map((p) => ({
      id: p.id,
      name: p.name,
      is_main: p.is_main,
      stages: p._embedded?.statuses?.map((s) => ({
        id: s.id,
        name: s.name,
        color: s.color,
      })) || [],
    }));

    setCache("pipelines", formatted, 600);
    return formatted;
  },

  kommo_list_pipeline_stages: async (params, client) => {
    const { pipeline_id } = params as { pipeline_id: number };

    if (!pipeline_id) throw new Error("pipeline_id é obrigatório");
    
    const cacheKey = `stages_${pipeline_id}`;
    const cached = getCached<unknown>(cacheKey);
    if (cached) return cached;

    const response = await client.get<StagesListResponse>(
      `/leads/pipelines/${pipeline_id}/statuses`
    );
    const stages = response._embedded?.statuses || [];

    const formatted = stages.map((s) => ({
      id: s.id,
      name: s.name,
      color: s.color,
      sort: s.sort,
    }));

    setCache(cacheKey, formatted, 600);
    return formatted;
  },
};

// ========== MCP Protocol Handler ==========
async function handleMCPRequest(
  mcpRequest: MCPRequest,
  env: Env
): Promise<MCPResponse> {
  const { id, method, params } = mcpRequest;

  try {
    switch (method) {
      case "initialize":
        return {
          jsonrpc: "2.0",
          id,
          result: {
            protocolVersion: "2024-11-05",
            capabilities: {
              tools: {},
            },
            serverInfo: {
              name: "kommo-mcp-server",
              version: "1.0.0",
            },
          },
        };

      case "notifications/initialized":
        // Notificação, não precisa de resposta
        return { jsonrpc: "2.0", id, result: {} };

      case "tools/list":
        return {
          jsonrpc: "2.0",
          id,
          result: {
            tools: toolDefinitions,
          },
        };

      case "tools/call": {
        const toolParams = params as { name: string; arguments?: Record<string, unknown> };
        const toolName = toolParams.name;
        const toolArgs = toolParams.arguments || {};

        const handler = toolHandlers[toolName];
        if (!handler) {
          return {
            jsonrpc: "2.0",
            id,
            error: {
              code: -32601,
              message: `Tool "${toolName}" não encontrada`,
            },
          };
        }

        const client = createKommoClient(env.KOMMO_BASE_URL, env.KOMMO_ACCESS_TOKEN);
        const result = await handler(toolArgs, client);

        return {
          jsonrpc: "2.0",
          id,
          result: {
            content: [
              {
                type: "text",
                text: JSON.stringify(result, null, 2),
              },
            ],
          },
        };
      }

      default:
        return {
          jsonrpc: "2.0",
          id,
          error: {
            code: -32601,
            message: `Método "${method}" não suportado`,
          },
        };
    }
  } catch (error) {
    return {
      jsonrpc: "2.0",
      id,
      error: {
        code: -32000,
        message: error instanceof Error ? error.message : "Erro interno",
      },
    };
  }
}

// Validar Bearer Token
function validateAuth(request: Request, env: Env): boolean {
  const authHeader = request.headers.get("Authorization");
  if (!authHeader) return false;
  
  const [type, token] = authHeader.split(" ");
  if (type !== "Bearer" || !token) return false;
  
  return token === env.API_BEARER_TOKEN;
}

// Handler principal para Cloudflare Workers
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    
    // CORS headers
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization, Mcp-Session-Id",
    };

    // Handle CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    // Health check (público)
    if (url.pathname === "/" || url.pathname === "/health") {
      return new Response(
        JSON.stringify({ 
          status: "ok", 
          version: "1.0.0",
          name: "kommo-mcp-server",
          transport: "streamable-http",
          tools: toolDefinitions.map(t => t.name),
        }),
        { headers: { "Content-Type": "application/json", ...corsHeaders } }
      );
    }

    // ========== MCP Endpoint ==========
    if (url.pathname === "/mcp") {
      // Autenticação
      if (!validateAuth(request, env)) {
        return new Response(
          JSON.stringify({ error: "Unauthorized" }),
          { status: 401, headers: { "Content-Type": "application/json", ...corsHeaders } }
        );
      }

      // DELETE = encerrar sessão (apenas retorna OK)
      if (request.method === "DELETE") {
        return new Response(null, { status: 204, headers: corsHeaders });
      }

      // GET não é suportado para streamable HTTP
      if (request.method === "GET") {
        return new Response(
          JSON.stringify({ error: "Use POST para enviar mensagens MCP" }),
          { status: 405, headers: { "Content-Type": "application/json", ...corsHeaders } }
        );
      }

      // POST = mensagem MCP
      if (request.method === "POST") {
        try {
          const body = await request.text();
          
          // Pode ser uma única mensagem ou batch (múltiplas mensagens)
          const parsed = JSON.parse(body);
          const messages: MCPRequest[] = Array.isArray(parsed) ? parsed : [parsed];
          
          const responses: MCPResponse[] = [];
          
          for (const msg of messages) {
            const response = await handleMCPRequest(msg, env);
            // Não retornar resposta para notificações (id undefined ou null)
            if (msg.id !== undefined && msg.id !== null) {
              responses.push(response);
            }
          }

          // Se só uma mensagem, retorna objeto; se batch, retorna array
          const result = responses.length === 1 ? responses[0] : responses;

          return new Response(JSON.stringify(result), {
            headers: { 
              "Content-Type": "application/json",
              ...corsHeaders,
            },
          });
        } catch (error) {
          return new Response(
            JSON.stringify({
              jsonrpc: "2.0",
              id: null,
              error: {
                code: -32700,
                message: "Parse error",
              },
            }),
            { status: 400, headers: { "Content-Type": "application/json", ...corsHeaders } }
          );
        }
      }
    }

    // ========== Legacy REST API (mantido para compatibilidade) ==========
    
    // Autenticação para rotas legacy
    if (!validateAuth(request, env)) {
      return new Response(
        JSON.stringify({ error: true, message: "Unauthorized. Bearer token required." }),
        { status: 401, headers: { "Content-Type": "application/json", ...corsHeaders } }
      );
    }

    // List tools (legacy)
    if (url.pathname === "/tools" && request.method === "GET") {
      return new Response(
        JSON.stringify({ tools: toolDefinitions }),
        { headers: { "Content-Type": "application/json", ...corsHeaders } }
      );
    }

    // Execute tool (legacy)
    if (url.pathname === "/execute" && request.method === "POST") {
      try {
        const body = await request.json() as { tool: string; params?: Record<string, unknown> };
        const { tool: toolName, params = {} } = body;

        const handler = toolHandlers[toolName];
        if (!handler) {
          return new Response(
            JSON.stringify({ error: true, message: `Tool "${toolName}" não encontrada.` }),
            { status: 404, headers: { "Content-Type": "application/json", ...corsHeaders } }
          );
        }

        const client = createKommoClient(env.KOMMO_BASE_URL, env.KOMMO_ACCESS_TOKEN);
        const result = await handler(params, client);

        return new Response(
          JSON.stringify({ success: true, data: result }),
          { headers: { "Content-Type": "application/json", ...corsHeaders } }
        );

      } catch (error) {
        const message = error instanceof Error ? error.message : "Erro desconhecido";
        return new Response(
          JSON.stringify({ error: true, message }),
          { status: 500, headers: { "Content-Type": "application/json", ...corsHeaders } }
        );
      }
    }

    // 404 para outras rotas
    return new Response(
      JSON.stringify({ error: true, message: "Not Found" }),
      { status: 404, headers: { "Content-Type": "application/json", ...corsHeaders } }
    );
  },
};
