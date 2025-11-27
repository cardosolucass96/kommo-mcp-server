/**
 * Kommo MCP Server - Cloudflare Workers
 * 
 * API HTTP com autenticação Bearer
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

// Resposta de erro
function errorResponse(message: string, status: number = 400): Response {
  return new Response(
    JSON.stringify({ error: true, message }),
    { status, headers: { "Content-Type": "application/json" } }
  );
}

// Resposta de sucesso
function successResponse(data: unknown, message?: string): Response {
  return new Response(
    JSON.stringify({ success: true, message, data }),
    { headers: { "Content-Type": "application/json" } }
  );
}

// Tool handlers
type ToolHandler = (
  params: Record<string, unknown>,
  client: KommoClientInterface
) => Promise<Response>;

const tools: Record<string, { description: string; handler: ToolHandler }> = {
  // ========== LIST LEADS ==========
  
  kommo_list_leads: {
    description: "Lista leads do Kommo CRM",
    handler: async (params, client) => {
      const { query, limit = 10, page = 1 } = params as { query?: string; limit?: number; page?: number };
      
      const queryParams: Record<string, unknown> = { limit, page };
      if (query) queryParams.query = query;

      const response = await client.get<LeadsListResponse>("/leads", queryParams);
      const leads = response._embedded?.leads || [];

      return successResponse(
        { total: leads.length, leads },
        `Encontrados ${leads.length} leads`
      );
    },
  },

  // ========== UPDATE LEAD ==========
  
  kommo_update_lead: {
    description: "Atualiza um lead específico",
    handler: async (params, client) => {
      const { lead_id, name, price, status_id } = params as { 
        lead_id: number;
        name?: string; 
        price?: number; 
        status_id?: number;
      };

      if (!lead_id) {
        return errorResponse("lead_id é obrigatório");
      }
      
      const body: LeadUpdateRequest = {};
      if (name) body.name = name;
      if (price !== undefined) body.price = price;
      if (status_id) body.status_id = status_id;

      const response = await client.patch<Lead>(`/leads/${lead_id}`, body);

      return successResponse(response, `Lead ${lead_id} atualizado`);
    },
  },

  // ========== ADD NOTES ==========
  
  kommo_add_notes: {
    description: "Adiciona nota a um lead",
    handler: async (params, client) => {
      const { lead_id, text } = params as { lead_id: number; text: string };

      if (!lead_id) {
        return errorResponse("lead_id é obrigatório");
      }

      if (!text) {
        return errorResponse("text é obrigatório");
      }
      
      const payload: NoteCreateRequest[] = [{
        entity_id: lead_id,
        note_type: "common",
        params: { text },
      }];

      const response = await client.post<NotesCreateResponse>("/leads/notes", payload);

      return successResponse(
        response._embedded?.notes || [],
        `📝 Nota adicionada ao lead ${lead_id}`
      );
    },
  },

  // ========== ADD TASKS ==========
  
  kommo_add_tasks: {
    description: "Cria tarefa para um lead",
    handler: async (params, client) => {
      const { lead_id, text, complete_till, task_type_id = 1 } = params as { 
        lead_id: number;
        text: string; 
        complete_till: number; 
        task_type_id?: number;
      };

      if (!lead_id) {
        return errorResponse("lead_id é obrigatório");
      }

      if (!text) {
        return errorResponse("text é obrigatório");
      }

      if (!complete_till) {
        return errorResponse("complete_till é obrigatório (Unix timestamp)");
      }
      
      const payload: TaskCreateRequest[] = [{
        task_type_id,
        text,
        complete_till,
        entity_id: lead_id,
        entity_type: "leads",
        request_id: `task_${Date.now()}`,
      }];

      const response = await client.post<TasksCreateResponse>("/tasks", payload);

      return successResponse(
        response._embedded?.tasks || [],
        `📞 Tarefa criada para lead ${lead_id}`
      );
    },
  },

  // ========== LIST PIPELINES ==========
  
  kommo_list_pipelines: {
    description: "Lista pipelines e estágios do Kommo",
    handler: async (_params, client) => {
      const cached = getCached<unknown>("pipelines");
      if (cached) {
        return successResponse(cached, "Pipelines (cache)");
      }

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

      return successResponse(formatted, `${pipelines.length} pipelines`);
    },
  },

  // ========== LIST PIPELINE STAGES ==========
  
  kommo_list_pipeline_stages: {
    description: "Lista estágios de um pipeline específico",
    handler: async (params, client) => {
      const { pipeline_id } = params as { pipeline_id: number };

      if (!pipeline_id) {
        return errorResponse("pipeline_id é obrigatório");
      }
      
      const cacheKey = `stages_${pipeline_id}`;
      const cached = getCached<unknown>(cacheKey);
      if (cached) {
        return successResponse(cached, "Estágios (cache)");
      }

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

      return successResponse(formatted, `${stages.length} estágios`);
    },
  },
};

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
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
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
          tools: Object.keys(tools),
        }),
        { headers: { "Content-Type": "application/json", ...corsHeaders } }
      );
    }

    // Todas as outras rotas requerem autenticação
    if (!validateAuth(request, env)) {
      return new Response(
        JSON.stringify({ error: true, message: "Unauthorized. Bearer token required." }),
        { status: 401, headers: { "Content-Type": "application/json", ...corsHeaders } }
      );
    }

    // List tools
    if (url.pathname === "/tools" && request.method === "GET") {
      const toolList = Object.entries(tools).map(([name, { description }]) => ({
        name,
        description,
      }));
      return new Response(
        JSON.stringify({ tools: toolList }),
        { headers: { "Content-Type": "application/json", ...corsHeaders } }
      );
    }

    // Execute tool
    if (url.pathname === "/execute" && request.method === "POST") {
      try {
        const body = await request.json() as { tool: string; params?: Record<string, unknown> };
        const { tool: toolName, params = {} } = body;

        if (!toolName || !tools[toolName]) {
          return new Response(
            JSON.stringify({ error: true, message: `Tool "${toolName}" não encontrada.` }),
            { status: 404, headers: { "Content-Type": "application/json", ...corsHeaders } }
          );
        }

        // Criar cliente Kommo
        const client = createKommoClient(env.KOMMO_BASE_URL, env.KOMMO_ACCESS_TOKEN);

        // Executar tool
        const result = await tools[toolName].handler(params, client);

        // Retornar response com CORS headers
        const responseBody = await result.text();
        
        return new Response(responseBody, {
          status: result.status,
          headers: { "Content-Type": "application/json", ...corsHeaders },
        });

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
