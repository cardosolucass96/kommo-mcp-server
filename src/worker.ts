/**
 * Kommo MCP Server - Cloudflare Workers
 * 
 * API HTTP compatível com MCP over HTTP/SSE
 */

// Tipos para Cloudflare Workers
export interface Env {
  KOMMO_BASE_URL: string;
  KOMMO_ACCESS_TOKEN: string;
  KOMMO_DEBUG?: string;
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

// Session storage (por request - em produção use KV ou Durable Objects)
interface SessionContext {
  leadId: number | null;
  leadName: string | null;
  startedAt: string | null;
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
  client: KommoClientInterface,
  session: SessionContext
) => Promise<{ response: Response; session?: SessionContext }>;

const tools: Record<string, { description: string; handler: ToolHandler }> = {
  // ========== SESSION TOOLS ==========
  
  kommo_start_session: {
    description: "Inicia atendimento com um lead",
    handler: async (params, client, session) => {
      const { lead_id, query } = params as { lead_id?: number; query?: string };
      
      let leadId: number;
      let leadName: string;

      if (lead_id) {
        const response = await client.get<LeadsListResponse>("/leads", {
          "filter[id]": lead_id,
        });
        const lead = response._embedded?.leads?.[0];
        if (!lead) {
          return { response: errorResponse(`Lead ${lead_id} não encontrado.`, 404) };
        }
        leadId = lead.id;
        leadName = lead.name;
      } else if (query) {
        const response = await client.get<LeadsListResponse>("/leads", {
          query: query,
          limit: 1,
        });
        const lead = response._embedded?.leads?.[0];
        if (!lead) {
          return { response: errorResponse(`Nenhum lead encontrado com "${query}".`, 404) };
        }
        leadId = lead.id;
        leadName = lead.name;
      } else {
        return { response: errorResponse("Informe lead_id ou query.") };
      }

      const newSession: SessionContext = {
        leadId,
        leadName,
        startedAt: new Date().toISOString(),
      };

      return {
        response: successResponse(
          { lead_id: leadId, lead_name: leadName, session: newSession },
          `🎯 Atendimento iniciado com "${leadName}"`
        ),
        session: newSession,
      };
    },
  },

  kommo_end_session: {
    description: "Encerra o atendimento atual",
    handler: async (_params, _client, session) => {
      if (!session.leadId) {
        return { response: errorResponse("Nenhum atendimento ativo.") };
      }
      
      const leadName = session.leadName;
      const newSession: SessionContext = { leadId: null, leadName: null, startedAt: null };

      return {
        response: successResponse(
          { lead_name: leadName },
          `✅ Atendimento com "${leadName}" encerrado`
        ),
        session: newSession,
      };
    },
  },

  kommo_get_session: {
    description: "Mostra informações do atendimento atual",
    handler: async (_params, _client, session) => {
      if (!session.leadId) {
        return { response: successResponse({ active: false }, "⚠️ Nenhum atendimento ativo.") };
      }
      return {
        response: successResponse(
          { active: true, lead_id: session.leadId, lead_name: session.leadName },
          `🎯 Em atendimento: "${session.leadName}"`
        ),
      };
    },
  },

  // ========== LIST LEADS ==========
  
  kommo_list_leads: {
    description: "Lista leads do Kommo CRM",
    handler: async (params, client, _session) => {
      const { query, limit = 10, page = 1 } = params as { query?: string; limit?: number; page?: number };
      
      const queryParams: Record<string, unknown> = { limit, page };
      if (query) queryParams.query = query;

      const response = await client.get<LeadsListResponse>("/leads", queryParams);
      const leads = response._embedded?.leads || [];

      return {
        response: successResponse(
          { total: leads.length, leads },
          `Encontrados ${leads.length} leads`
        ),
      };
    },
  },

  // ========== UPDATE LEAD ==========
  
  kommo_update_lead: {
    description: "Atualiza o lead em atendimento",
    handler: async (params, client, session) => {
      if (!session.leadId) {
        return { response: errorResponse("⛔ Nenhum atendimento ativo. Use kommo_start_session primeiro.", 403) };
      }

      const { name, price, status_id } = params as { name?: string; price?: number; status_id?: number };
      
      const body: LeadUpdateRequest = {};
      if (name) body.name = name;
      if (price !== undefined) body.price = price;
      if (status_id) body.status_id = status_id;

      const response = await client.patch<Lead>(`/leads/${session.leadId}`, body);

      return {
        response: successResponse(response, `Lead "${session.leadName}" atualizado`),
      };
    },
  },

  // ========== ADD NOTES ==========
  
  kommo_add_notes: {
    description: "Adiciona nota ao lead em atendimento",
    handler: async (params, client, session) => {
      if (!session.leadId) {
        return { response: errorResponse("⛔ Nenhum atendimento ativo.", 403) };
      }

      const { text } = params as { text: string };
      
      const payload: NoteCreateRequest[] = [{
        entity_id: session.leadId,
        note_type: "common",
        params: { text },
      }];

      const response = await client.post<NotesCreateResponse>("/leads/notes", payload);

      return {
        response: successResponse(
          response._embedded?.notes || [],
          `📝 Nota adicionada ao lead "${session.leadName}"`
        ),
      };
    },
  },

  // ========== ADD TASKS ==========
  
  kommo_add_tasks: {
    description: "Cria tarefa para o lead em atendimento",
    handler: async (params, client, session) => {
      if (!session.leadId) {
        return { response: errorResponse("⛔ Nenhum atendimento ativo.", 403) };
      }

      const { text, complete_till, task_type_id = 1 } = params as { 
        text: string; 
        complete_till: number; 
        task_type_id?: number;
      };
      
      const payload: TaskCreateRequest[] = [{
        task_type_id,
        text,
        complete_till,
        entity_id: session.leadId,
        entity_type: "leads",
        request_id: `task_${Date.now()}`,
      }];

      const response = await client.post<TasksCreateResponse>("/tasks", payload);

      return {
        response: successResponse(
          response._embedded?.tasks || [],
          `📞 Tarefa criada para "${session.leadName}"`
        ),
      };
    },
  },

  // ========== LIST PIPELINES ==========
  
  kommo_list_pipelines: {
    description: "Lista pipelines e estágios do Kommo",
    handler: async (_params, client, _session) => {
      const cached = getCached<unknown>("pipelines");
      if (cached) {
        return { response: successResponse(cached, "Pipelines (cache)") };
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

      return {
        response: successResponse(formatted, `${pipelines.length} pipelines`),
      };
    },
  },

  // ========== LIST PIPELINE STAGES ==========
  
  kommo_list_pipeline_stages: {
    description: "Lista estágios de um pipeline específico",
    handler: async (params, client, _session) => {
      const { pipeline_id } = params as { pipeline_id: number };
      
      const cacheKey = `stages_${pipeline_id}`;
      const cached = getCached<unknown>(cacheKey);
      if (cached) {
        return { response: successResponse(cached, "Estágios (cache)") };
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

      return {
        response: successResponse(formatted, `${stages.length} estágios`),
      };
    },
  },
};

// Handler principal para Cloudflare Workers
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    
    // CORS headers
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, X-Session",
    };

    // Handle CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    // Health check
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

        // Recuperar sessão do header ou criar nova
        let session: SessionContext = { leadId: null, leadName: null, startedAt: null };
        const sessionHeader = request.headers.get("X-Session");
        if (sessionHeader) {
          try {
            session = JSON.parse(atob(sessionHeader));
          } catch {
            // Sessão inválida, usar nova
          }
        }

        // Criar cliente Kommo
        const client = createKommoClient(env.KOMMO_BASE_URL, env.KOMMO_ACCESS_TOKEN);

        // Executar tool
        const result = await tools[toolName].handler(params, client, session);

        // Adicionar nova sessão ao header se mudou
        const responseHeaders: Record<string, string> = {
          "Content-Type": "application/json",
          ...corsHeaders,
        };
        
        if (result.session) {
          responseHeaders["X-Session"] = btoa(JSON.stringify(result.session));
        }

        // Clonar a response com os novos headers
        const originalResponse = result.response;
        const responseBody = await originalResponse.text();
        
        return new Response(responseBody, {
          status: originalResponse.status,
          headers: responseHeaders,
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
