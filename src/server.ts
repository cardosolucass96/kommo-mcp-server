/**
 * Kommo MCP Server - Fastify + Node.js
 * Multi-tenant: Token Bearer = senha|subdomain|kommoToken
 */

import 'dotenv/config';
import Fastify, { FastifyRequest, FastifyReply } from 'fastify';
import cors from '@fastify/cors';
import { createKommoClient, KommoClientInterface } from "./kommo/clientCF.js";
import {
  LeadsListResponse,
  Lead,
  LeadUpdateRequest,
  LeadCreateRequest,
  LeadCreateResponse,
  NotesCreateResponse,
  NotesListResponse,
  NoteCreateRequest,
  TasksCreateResponse,
  TasksListResponse,
  TaskCreateRequest,
  PipelinesListResponse,
  StagesListResponse,
  Contact,
  ContactsListResponse,
  User,
  UsersListResponse,
  EventsListResponse,
  Company,
  CompaniesListResponse,
} from "./kommo/types.js";
import {
  MCP_PROTOCOL_VERSION,
  SERVER_INFO,
  CACHE_TTL,
  JSON_RPC_ERRORS,
  API_LIMITS,
  SERVER_CONFIG,
  ERROR_MESSAGES,
} from "./constants.js";
import {
  mcpRequestSchema,
  validateToolParams,
  executeRequestSchema,
  isMCPRequestArray,
} from "./schemas.js";

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

// Cache simples em memória
const pipelinesCache = new Map<string, { data: unknown; expiresAt: number }>();

function getCached<T>(key: string): T | null {
  const entry = pipelinesCache.get(key);
  if (!entry || Date.now() > entry.expiresAt) {
    pipelinesCache.delete(key);
    return null;
  }
  return entry.data as T;
}

function setCache(key: string, data: unknown, ttlSeconds: number = CACHE_TTL.PIPELINES) {
  pipelinesCache.set(key, {
    data,
    expiresAt: Date.now() + ttlSeconds * 1000,
  });
}

// ========== Tool Definitions Generator ==========
// Função para buscar pipelines e gerar descrição dinâmica
async function getPipelinesDescription(client: KommoClientInterface): Promise<string> {
  try {
    const response = await client.get<PipelinesListResponse>("/leads/pipelines");
    const pipelines = response._embedded?.pipelines || [];
    
    if (pipelines.length === 0) {
      return "";
    }
    
    let pipelinesInfo = "\n\n📊 PIPELINES E ETAPAS DISPONÍVEIS NESTE CRM:\n";
    
    pipelines.forEach((pipeline) => {
      pipelinesInfo += `\n🔹 ${pipeline.name} (pipeline_id: ${pipeline.id})${pipeline.is_main ? ' [PRINCIPAL]' : ''}\n`;
      const stages = pipeline._embedded?.statuses || [];
      stages.forEach((stage) => {
        pipelinesInfo += `   • ${stage.name} (status_id: ${stage.id})\n`;
      });
    });
    
    return pipelinesInfo;
  } catch (error) {
    console.error("Error fetching pipelines for description:", error);
    return "";
  }
}

// Função para gerar tool definitions dinamicamente
async function generateToolDefinitions(client: KommoClientInterface): Promise<MCPToolDefinition[]> {
  const pipelinesInfo = await getPipelinesDescription(client);
  
  return [
    {
      name: "kommo_list_leads",
      description: `Lista leads do Kommo CRM com informações de contato e filtros avançados. Use para buscar leads por nome, telefone, período de criação, status ou pipeline. RETORNA: Cada lead inclui contact_info com id, nome completo, first_name, last_name e telefone do contato principal. FILTROS DISPONÍVEIS: created_at_from/to (Unix timestamp), status_id, pipeline_id. IMPORTANTE: Sempre use esta tool ANTES de atualizar um lead para obter o lead_id correto. OTIMIZAÇÃO: Para economizar tokens, retorna detalhes completos apenas dos primeiros 10 leads. Se houver mais de 10, os demais são retornados como resumo (id, name, price, status_id, contact_info). O total sempre é informado.${pipelinesInfo}`,
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Texto para buscar no nome do lead ou telefone" },
          limit: { type: "number", description: "Quantidade de resultados (padrão: 10, máximo: 250)" },
          page: { type: "number", description: "Página para paginação (padrão: 1)" },
          created_at_from: { type: "number", description: "Filtrar leads criados A PARTIR desta data (Unix timestamp em segundos). Exemplo: 1733961600 para 12/12/2024" },
          created_at_to: { type: "number", description: "Filtrar leads criados ATÉ esta data (Unix timestamp em segundos). Exemplo: 1734566400 para 19/12/2024" },
          status_id: { type: "number", description: "Filtrar por ID do status/etapa. Use os IDs listados acima nos pipelines disponíveis" },
          pipeline_id: { type: "number", description: "Filtrar por ID do pipeline/funil. Use os IDs listados acima" },
        },
      },
    },
    {
      name: "kommo_update_lead",
      description: `Atualiza um lead específico (nome, preço, status ou campos customizados). FLUXO: 1) Use kommo_list_leads para encontrar o lead_id. 2) Para mudar status, use os status_id listados na descrição de kommo_list_leads. 3) Para campos customizados, use kommo_list_lead_custom_fields. ⚠️ IMPORTANTE APROVAÇÃO: Se a busca retornar MÚLTIPLOS leads, você DEVE pedir aprovação do usuário ANTES de atualizar, mostrando claramente: quantos leads serão afetados, nome/ID de cada um, e o que será alterado. Cada CRM tem campos diferentes. EXEMPLO para campo customizado: custom_fields_values: [{field_id: 1093415, values: [{value: 'texto'}]}]${pipelinesInfo}`,
      inputSchema: {
        type: "object",
        properties: {
          lead_id: { type: "number", description: "ID do lead (obtenha com kommo_list_leads)" },
          name: { type: "string", description: "Novo nome do lead" },
          price: { type: "number", description: "Novo preço/valor do lead em número (ex: 1500.50)" },
          status_id: { type: "number", description: "ID do novo status. Use os IDs listados acima" },
          custom_fields_values: { 
            type: "array", 
            description: "Array de campos customizados. Cada item deve ter field_id (número) e values (array com objetos contendo value). Para campos select/multiselect, pode incluir enum_id também.",
            items: {
              type: "object",
              properties: {
                field_id: { type: "number", description: "ID do campo customizado (obtenha com kommo_list_lead_custom_fields)" },
                values: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: {
                      value: { type: ["string", "number", "boolean"], description: "Valor do campo" },
                      enum_id: { type: "number", description: "ID do enum (apenas para campos select/multiselect)" }
                    },
                    required: ["value"]
                  }
                }
              },
              required: ["field_id", "values"]
            }
          },
        },
        required: ["lead_id"],
      },
    },
    {
      name: "kommo_add_notes",
      description: "Adiciona nota/observação a um lead no Kommo CRM. WORKFLOW: 1) Use kommo_list_leads para obter o lead_id. 2) Passe o lead_id e texto da nota. A nota será registrada no histórico do lead, visível para toda a equipe. ⚠️ IMPORTANTE APROVAÇÃO: Se for adicionar notas em MÚLTIPLOS leads (loop/iteração), você DEVE pedir aprovação do usuário ANTES, mostrando quantos e quais leads receberão a nota. Use para documentar ligações, reuniões, acordos ou qualquer informação relevante sobre o lead.",
      inputSchema: {
        type: "object",
        properties: {
          lead_id: { type: "number", description: "ID do lead (obtenha com kommo_list_leads)" },
          text: { type: "string", description: "Texto da nota. Exemplo: 'Cliente confirmou interesse no produto X'" },
        },
        required: ["lead_id", "text"],
      },
    },
    {
      name: "kommo_add_tasks",
      description: "Cria tarefa/lembrete para um lead no Kommo CRM. WORKFLOW: 1) Use kommo_list_leads para obter lead_id. 2) Defina complete_till em Unix timestamp (exemplo: para amanhã use Date.now()/1000 + 86400). 3) Escolha task_type_id: 1=Ligar, 2=Reunião, 3=Escrever Email. ⚠️ IMPORTANTE APROVAÇÃO: Se for criar tarefas em MÚLTIPLOS leads (loop/iteração), você DEVE pedir aprovação do usuário ANTES, mostrando quantos e quais leads receberão a tarefa. A tarefa aparecerá no calendário do responsável pelo lead. IMPORTANTE: complete_till deve ser timestamp futuro em segundos (não milissegundos).",
      inputSchema: {
        type: "object",
        properties: {
          lead_id: { type: "number", description: "ID do lead (obtenha com kommo_list_leads)" },
          text: { type: "string", description: "Descrição da tarefa. Exemplo: 'Ligar para confirmar proposta'" },
          complete_till: { type: "number", description: "Prazo Unix timestamp em segundos. Amanhã = Math.floor(Date.now()/1000) + 86400" },
          task_type_id: { type: "number", description: "Tipo da tarefa: 1=Ligar (padrão), 2=Reunião, 3=Escrever Email" },
        },
        required: ["lead_id", "text", "complete_till"],
      },
    },
    {
      name: "kommo_list_pipelines",
      description: "Lista TODOS os pipelines (funis de venda) do Kommo CRM com seus estágios. USE quando precisar descobrir quais status_id existem para mover leads entre etapas do funil. RETORNA para cada pipeline: pipeline_id, nome, e lista completa de estágios com (status_id, nome, cor, ordem, tipo). WORKFLOW: 1) Chame esta tool sem parâmetros. 2) Encontre o pipeline desejado (ex: 'Vendas', 'Cobrança'). 3) Anote o status_id do estágio destino. 4) Use esse status_id em kommo_update_lead. Resultados são cacheados por 10 minutos.",
      inputSchema: {
        type: "object",
        properties: {},
      },
    },
    {
      name: "kommo_list_pipeline_stages",
      description: "Lista estágios de UM pipeline específico (alternativa mais focada ao kommo_list_pipelines). USE quando já souber o pipeline_id e quiser apenas os estágios daquele funil. RETORNA: lista de estágios com status_id, nome, cor, ordem e tipo. QUANDO USAR: Se não souber o pipeline_id, use kommo_list_pipelines primeiro para ver todos os pipelines. Se já souber o ID, use esta tool para resultados mais diretos. Útil para descobrir status_id válidos antes de mover leads.",
      inputSchema: {
        type: "object",
        properties: {
          pipeline_id: { type: "number", description: "ID do pipeline (obtenha com kommo_list_pipelines se necessário)" },
        },
        required: ["pipeline_id"],
      },
    },
    {
      name: "kommo_list_lead_custom_fields",
      description: "Lista TODOS os campos customizados disponíveis para leads neste CRM específico. CRUCIAL: Cada CRM tem campos diferentes! Use esta tool para: 1) Descobrir quais campos existem (id, name, code, type). 2) Ver valores permitidos (enums) para campos de seleção. 3) Identificar campos obrigatórios (is_required). 4) Saber o tipo de dado esperado (text, numeric, select, multiselect, date, url, checkbox, etc). SEMPRE consulte esta tool antes de atualizar campos customizados, pois os IDs e estruturas variam entre CRMs diferentes.",
      inputSchema: {
        type: "object",
        properties: {},
      },
    },
    {
      name: "kommo_create_lead",
      description: `Cria um NOVO lead no Kommo CRM com contato e empresa (opcional). IMPORTANTE: Para criar lead, você DEVE fornecer informações do CONTATO. Se não tiver contato, o lead não será criado corretamente no Kommo. WORKFLOW: 1) Nome do lead (obrigatório). 2) Telefone do contato (recomendado) + primeiro nome (obrigatório se tiver telefone). 3) Sobrenome e email (opcionais). 4) Empresa (opcional: company_name). 5) Preço e status_id (opcionais). 6) Responsável (opcional: responsible_user_id - use kommo_list_users para obter IDs). ATENÇÃO: contact_first_name é OBRIGATÓRIO quando você fornece contact_phone. Pode ser apenas o primeiro nome, tipo "João" ou "Maria". O sistema cria contato + lead em uma única operação (complex lead).${pipelinesInfo}`,
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", description: "Nome do lead (obrigatório). Ex: 'Proposta Empresa X'" },
          price: { type: "number", description: "Valor/preço do lead. Ex: 5000" },
          status_id: { type: "number", description: "ID do status inicial. Use os IDs listados acima" },
          pipeline_id: { type: "number", description: "ID do pipeline. Use os IDs listados acima" },
          responsible_user_id: { type: "number", description: "ID do usuário responsável (opcional). Use kommo_list_users para obter lista de usuários disponíveis" },
          contact_first_name: { type: "string", description: "Primeiro nome do contato. OBRIGATÓRIO se fornecer telefone. Ex: 'João'" },
          contact_last_name: { type: "string", description: "Sobrenome do contato (opcional). Ex: 'Silva'" },
          contact_phone: { type: "string", description: "Telefone do contato. Ex: '+5511999999999'. Requer contact_first_name" },
          contact_email: { type: "string", description: "Email do contato (opcional). Ex: 'joao@empresa.com'" },
          company_name: { type: "string", description: "Nome da empresa (opcional). Ex: 'Acme Corp'" },
          company_phone: { type: "string", description: "Telefone da empresa (opcional)" },
        },
        required: ["name"],
      },
    },
    {
      name: "kommo_get_lead_by_id",
      description: "Busca UM lead específico por ID com TODOS os detalhes completos. USE quando precisar informações detalhadas de um lead que você já conhece o ID. Mais eficiente que kommo_list_leads quando você sabe o ID exato. RETORNA: Lead completo com histórico, contatos, campos customizados, tarefas.",
      inputSchema: {
        type: "object",
        properties: {
          lead_id: { type: "number", description: "ID do lead (número inteiro positivo)" },
        },
        required: ["lead_id"],
      },
    },
    {
      name: "kommo_search_leads_by_phone",
      description: "Busca leads por TELEFONE. Muito usado em atendimento/vendas para encontrar clientes rapidamente pelo número. ATENÇÃO: Busca no telefone dos CONTATOS vinculados aos leads. Formato recomendado: +5511999999999 (com código país). Também funciona com busca parcial. RETORNA: Todos os leads cujos contatos têm aquele telefone.",
      inputSchema: {
        type: "object",
        properties: {
          phone: { type: "string", description: "Número de telefone completo ou parcial. Ex: '+5511999999999' ou '11999999999'" },
        },
        required: ["phone"],
      },
    },
    {
      name: "kommo_list_contacts",
      description: "Lista contatos do Kommo CRM (pessoas/empresas independente dos leads). USE para gestão de contatos, buscar telefones, emails. Cada contato pode estar vinculado a múltiplos leads. FILTROS: query para buscar por nome/telefone/email, limit e page para paginação. RETORNA: Lista de contatos com telefones, emails, campos customizados.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Buscar por nome, telefone ou email" },
          limit: { type: "number", description: "Quantidade de resultados (padrão: 50, máximo: 250)" },
          page: { type: "number", description: "Página para paginação (padrão: 1)" },
        },
      },
    },
    {
      name: "kommo_list_users",
      description: "Lista TODOS os usuários/vendedores do CRM. USE para: 1) Descobrir responsible_user_id ao criar/atualizar leads. 2) Análises por vendedor. 3) Atribuir tarefas. RETORNA: Lista de usuários com ID, nome, email e permissões. Útil para saber quem são os vendedores ativos.",
      inputSchema: {
        type: "object",
        properties: {},
      },
    },
    {
      name: "kommo_get_lead_events",
      description: "Busca o HISTÓRICO DE EVENTOS de um lead. USE para entender: 1) O que aconteceu com o lead (mudanças de status, etapa). 2) Mensagens recebidas/enviadas (incoming/outgoing_chat_message). 3) Chamadas, emails, tarefas concluídas. 4) Timeline completa do lead. RETORNA: Lista de eventos com tipo, data e detalhes.",
      inputSchema: {
        type: "object",
        properties: {
          lead_id: { type: "number", description: "ID do lead" },
          limit: { type: "number", description: "Quantidade de eventos (padrão: 20, máximo: 100)" },
        },
        required: ["lead_id"],
      },
    },
  ];
}

// Lista básica de nomes de tools (para endpoints estáticos)
const toolNames = [
  "kommo_list_leads",
  "kommo_update_lead",
  "kommo_add_notes",
  "kommo_add_tasks",
  "kommo_list_pipelines",
  "kommo_list_pipeline_stages",
  "kommo_list_lead_custom_fields",
  "kommo_create_lead",
  "kommo_get_lead_by_id",
  "kommo_search_leads_by_phone",
  "kommo_list_contacts",
  "kommo_list_users",
  "kommo_get_lead_events",
];

// ========== Tool Handlers ==========
type ToolHandler = (
  params: Record<string, unknown>,
  client: KommoClientInterface
) => Promise<unknown>;

const toolHandlers: Record<string, ToolHandler> = {
  kommo_list_leads: async (params, client) => {
    const validated = validateToolParams('kommo_list_leads', params);
    if (!validated.success) {
      throw new Error(`Invalid parameters: ${JSON.stringify(validated)}`);
    }
    
    const { 
      query, 
      limit = API_LIMITS.DEFAULT_LEADS_LIMIT, 
      page = API_LIMITS.DEFAULT_PAGE,
      created_at_from,
      created_at_to,
      status_id,
      pipeline_id,
    } = validated.data;
    
    const queryParams: Record<string, unknown> = { limit, page, with: "contacts" };
    if (query) queryParams.query = query;
    
    // Adicionar filtros avançados
    if (created_at_from) queryParams['filter[created_at][from]'] = created_at_from;
    if (created_at_to) queryParams['filter[created_at][to]'] = created_at_to;
    if (status_id) queryParams['filter[statuses][0][status_id]'] = status_id;
    if (pipeline_id) queryParams['filter[statuses][0][pipeline_id]'] = pipeline_id;

    const response = await client.get<LeadsListResponse>("/leads", queryParams);
    const allLeads = response._embedded?.leads || [];
    const totalLeads = allLeads.length;

    // Coletar IDs únicos de contatos para buscar detalhes
    const contactIds = new Set<number>();
    allLeads.forEach(lead => {
      lead._embedded?.contacts?.forEach(contact => {
        contactIds.add(contact.id);
      });
    });

    // Buscar detalhes dos contatos se houver IDs
    let contactsMap = new Map<number, Contact>();
    if (contactIds.size > 0) {
      try {
        const contactsResponse = await client.get<ContactsListResponse>(
          "/contacts", 
          { id: Array.from(contactIds) }
        );
        const contacts = contactsResponse._embedded?.contacts || [];
        contacts.forEach(contact => {
          contactsMap.set(contact.id, contact);
        });
      } catch (error) {
        console.error("Error fetching contacts:", error);
      }
    }

    // Enriquecer leads com informações de contato
    const enrichedLeads = allLeads.map(lead => {
      const mainContactId = lead._embedded?.contacts?.find(c => c.is_main)?.id;
      const contact = mainContactId ? contactsMap.get(mainContactId) : null;
      
      let contactInfo = null;
      if (contact) {
        // Buscar telefone nos custom fields
        const phoneField = contact.custom_fields_values?.find(
          f => f.field_code === "PHONE" || f.field_type === "multitext"
        );
        const phone = phoneField?.values?.[0]?.value || null;
        
        contactInfo = {
          id: contact.id,
          name: contact.name,
          first_name: contact.first_name,
          last_name: contact.last_name,
          phone: phone,
        };
      }
      
      return {
        ...lead,
        contact_info: contactInfo,
      };
    });

    // Otimização: Limitar detalhes completos a 10 leads para economizar tokens
    if (totalLeads > API_LIMITS.MAX_LEADS_DETAIL) {
      const detailedLeads = enrichedLeads.slice(0, API_LIMITS.MAX_LEADS_DETAIL);
      const summaryLeads = enrichedLeads.slice(API_LIMITS.MAX_LEADS_DETAIL).map(lead => ({
        id: lead.id,
        name: lead.name,
        price: lead.price,
        status_id: lead.status_id,
        pipeline_id: lead.pipeline_id,
        contact_info: lead.contact_info,
      }));
      
      return {
        total: totalLeads,
        showing_details: API_LIMITS.MAX_LEADS_DETAIL,
        detailed_leads: detailedLeads,
        summary_leads: summaryLeads,
        message: `Showing full details for first ${API_LIMITS.MAX_LEADS_DETAIL} leads. Remaining ${summaryLeads.length} leads shown as summary (id, name, price, status, contact_info).`
      };
    }

    return { total: totalLeads, leads: enrichedLeads };
  },

  kommo_update_lead: async (params, client) => {
    const validated = validateToolParams('kommo_update_lead', params);
    if (!validated.success) {
      throw new Error(`Invalid parameters: ${JSON.stringify(validated)}`);
    }
    
    const { lead_id, name, price, status_id, custom_fields_values } = validated.data;
    
    const body: LeadUpdateRequest = {};
    if (name) body.name = name;
    if (price !== undefined) body.price = price;
    if (status_id) body.status_id = status_id;
    if (custom_fields_values) body.custom_fields_values = custom_fields_values;

    return await client.patch<Lead>(`/leads/${lead_id}`, body);
  },

  kommo_add_notes: async (params, client) => {
    const validated = validateToolParams('kommo_add_notes', params);
    if (!validated.success) {
      throw new Error(`Invalid parameters: ${JSON.stringify(validated)}`);
    }
    
    const { lead_id, text } = validated.data;
    
    const payload: NoteCreateRequest[] = [{
      entity_id: lead_id,
      note_type: "common",
      params: { text },
    }];

    const response = await client.post<NotesCreateResponse>("/leads/notes", payload);
    return response._embedded?.notes || [];
  },

  kommo_add_tasks: async (params, client) => {
    const validated = validateToolParams('kommo_add_tasks', params);
    if (!validated.success) {
      throw new Error(`Invalid parameters: ${JSON.stringify(validated)}`);
    }
    
    const { lead_id, text, complete_till, task_type_id = 1 } = validated.data;
    
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

    setCache("pipelines", formatted, CACHE_TTL.PIPELINES);
    return formatted;
  },

  kommo_list_pipeline_stages: async (params, client) => {
    const validated = validateToolParams('kommo_list_pipeline_stages', params);
    if (!validated.success) {
      throw new Error(`Invalid parameters: ${JSON.stringify(validated)}`);
    }
    
    const { pipeline_id } = validated.data;
    
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

    setCache(cacheKey, formatted, CACHE_TTL.STAGES);
    return formatted;
  },

  kommo_list_lead_custom_fields: async (_params, client) => {
    const cacheKey = "lead_custom_fields";
    const cached = getCached<unknown>(cacheKey);
    if (cached) return cached;

    const response = await client.get<any>("/leads/custom_fields");
    const fields = response._embedded?.custom_fields || [];

    const formatted = fields.map((f: any) => ({
      id: f.id,
      name: f.name,
      type: f.type,
      code: f.code || null,
      sort: f.sort,
      entity_type: f.entity_type,
      is_required: f.is_required || false,
      is_predefined: f.is_predefined || false,
      is_deletable: f.is_deletable || false,
      is_api_only: f.is_api_only || false,
      group_id: f.group_id || null,
      remind: f.remind || null,
      enums: f.enums?.map((e: any) => ({
        id: e.id,
        value: e.value,
        sort: e.sort,
      })) || null,
      required_statuses: f.required_statuses?.map((rs: any) => ({
        status_id: rs.status_id,
        pipeline_id: rs.pipeline_id,
      })) || null,
    }));

    setCache(cacheKey, formatted, CACHE_TTL.CUSTOM_FIELDS);
    return formatted;
  },

  kommo_create_lead: async (params, client) => {
    const validated = validateToolParams('kommo_create_lead', params);
    if (!validated.success) {
      throw new Error(`Invalid parameters: ${JSON.stringify(validated)}`);
    }
    
    const { 
      name, 
      price, 
      status_id, 
      pipeline_id,
      responsible_user_id,
      contact_first_name,
      contact_last_name,
      contact_phone,
      contact_email,
      company_name,
      company_phone,
      custom_fields_values
    } = validated.data;
    
    // Construir payload complexo do lead
    const leadData: any = {
      name,
      price,
      status_id,
      pipeline_id,
      responsible_user_id,
      custom_fields_values,
      _embedded: {},
    };
    
    // Criar contato (obrigatório no Kommo para ter telefone)
    if (contact_first_name || contact_phone || contact_email) {
      const contactCustomFields: any[] = [];
      
      // Adicionar telefone
      if (contact_phone) {
        contactCustomFields.push({
          field_code: "PHONE",
          values: [{ value: contact_phone, enum_code: "WORK" }]
        });
      }
      
      // Adicionar email
      if (contact_email) {
        contactCustomFields.push({
          field_code: "EMAIL",
          values: [{ value: contact_email, enum_code: "WORK" }]
        });
      }
      
      // Montar nome completo do contato
      const fullName = contact_last_name 
        ? `${contact_first_name} ${contact_last_name}` 
        : contact_first_name || "Contato";
      
      leadData._embedded.contacts = [{
        first_name: contact_first_name || "",
        last_name: contact_last_name || "",
        name: fullName,
        custom_fields_values: contactCustomFields.length > 0 ? contactCustomFields : undefined,
      }];
    }
    
    // Criar empresa (opcional)
    if (company_name) {
      const companyCustomFields: any[] = [];
      
      if (company_phone) {
        companyCustomFields.push({
          field_code: "PHONE",
          values: [{ value: company_phone, enum_code: "WORK" }]
        });
      }
      
      leadData._embedded.companies = [{
        name: company_name,
        custom_fields_values: companyCustomFields.length > 0 ? companyCustomFields : undefined,
      }];
    }
    
    // Usar endpoint /leads/complex para criar lead com contato e empresa
    const endpoint = (contact_first_name || company_name) ? "/leads/complex" : "/leads";
    const payload = endpoint === "/leads/complex" ? [leadData] : [leadData];
    
    const response = await client.post<LeadCreateResponse>(endpoint, payload);
    const createdLead = response._embedded?.leads?.[0];
    
    if (createdLead) {
      return {
        success: true,
        lead: createdLead,
        message: `Lead "${createdLead.name}" criado com sucesso! ID: ${createdLead.id}`,
      };
    }
    
    return response;
  },

  kommo_get_lead_by_id: async (params, client) => {
    const validated = validateToolParams('kommo_get_lead_by_id', params);
    if (!validated.success) {
      throw new Error(`Invalid parameters: ${JSON.stringify(validated)}`);
    }
    
    const { lead_id } = validated.data;
    
    // Buscar lead com contatos e empresas
    const lead = await client.get<Lead>(`/leads/${lead_id}`, { with: "contacts,companies" });
    
    // Resultado enriquecido
    const enrichedResult: any = {
      // Dados básicos do lead
      id: lead.id,
      name: lead.name,
      price: lead.price,
      status_id: lead.status_id,
      pipeline_id: lead.pipeline_id,
      responsible_user_id: lead.responsible_user_id,
      created_at: lead.created_at,
      updated_at: lead.updated_at,
      closed_at: lead.closed_at,
      loss_reason_id: lead.loss_reason_id,
      custom_fields_values: lead.custom_fields_values,
      tags: lead._embedded?.tags || [],
      
      // Dados enriquecidos (serão preenchidos abaixo)
      contacts: [],
      companies: [],
      tasks: [],
      notes: [],
      events: [],
    };
    
    // Buscar detalhes dos contatos
    if (lead._embedded?.contacts && lead._embedded.contacts.length > 0) {
      const contactIds = lead._embedded.contacts.map(c => c.id);
      try {
        const contactsResponse = await client.get<ContactsListResponse>(
          "/contacts", 
          { id: contactIds }
        );
        const contacts = contactsResponse._embedded?.contacts || [];
        
        enrichedResult.contacts = contacts.map(c => {
          const phoneField = c.custom_fields_values?.find(
            f => f.field_code === "PHONE" || f.field_type === "multitext"
          );
          const emailField = c.custom_fields_values?.find(
            f => f.field_code === "EMAIL"
          );
          
          const isMain = lead._embedded?.contacts?.some(ec => ec.id === c.id && ec.is_main);
          
          return {
            id: c.id,
            name: c.name,
            first_name: c.first_name,
            last_name: c.last_name,
            is_main: isMain || false,
            phone: phoneField?.values?.[0]?.value || null,
            email: emailField?.values?.[0]?.value || null,
            custom_fields: c.custom_fields_values,
          };
        });
      } catch (error) {
        console.error("Error fetching contacts:", error);
      }
    }
    
    // Buscar detalhes das empresas
    if (lead._embedded?.companies && lead._embedded.companies.length > 0) {
      const companyIds = lead._embedded.companies.map(c => c.id);
      try {
        const companiesResponse = await client.get<CompaniesListResponse>(
          "/companies", 
          { id: companyIds }
        );
        const companies = companiesResponse._embedded?.companies || [];
        
        enrichedResult.companies = companies.map(c => ({
          id: c.id,
          name: c.name,
          custom_fields: c.custom_fields_values,
        }));
      } catch (error) {
        console.error("Error fetching companies:", error);
      }
    }
    
    // Buscar tarefas do lead
    try {
      const tasksResponse = await client.get<TasksListResponse>("/tasks", {
        "filter[entity_type]": "leads",
        "filter[entity_id][]": lead_id,
        limit: 50,
      });
      const tasks = tasksResponse._embedded?.tasks || [];
      
      enrichedResult.tasks = tasks.map(t => ({
        id: t.id,
        text: t.text,
        is_completed: t.is_completed,
        complete_till: t.complete_till,
        task_type_id: t.task_type_id,
        responsible_user_id: t.responsible_user_id,
        result: t.result?.text || null,
        created_at: t.created_at,
      }));
    } catch (error) {
      console.error("Error fetching tasks:", error);
    }
    
    // Buscar notas do lead
    try {
      const notesResponse = await client.get<NotesListResponse>(`/leads/${lead_id}/notes`, {
        limit: 50,
      });
      const notes = notesResponse._embedded?.notes || [];
      
      enrichedResult.notes = notes.map(n => ({
        id: n.id,
        note_type: n.note_type,
        text: n.params?.text || null,
        created_at: n.created_at,
        created_by: n.created_by,
      }));
    } catch (error) {
      console.error("Error fetching notes:", error);
    }
    
    // Buscar eventos recentes do lead
    try {
      const eventsResponse = await client.get<EventsListResponse>("/events", {
        "filter[entity]": "lead",
        "filter[entity_id][]": lead_id,
        limit: 20,
      });
      const events = eventsResponse._embedded?.events || [];
      
      enrichedResult.events = events.map(e => ({
        id: e.id,
        type: e.type,
        created_at: e.created_at,
        value_after: e.value_after,
      }));
    } catch (error) {
      console.error("Error fetching events:", error);
    }
    
    // Resumo para facilitar leitura
    enrichedResult.summary = {
      total_contacts: enrichedResult.contacts.length,
      total_companies: enrichedResult.companies.length,
      total_tasks: enrichedResult.tasks.length,
      pending_tasks: enrichedResult.tasks.filter((t: any) => !t.is_completed).length,
      total_notes: enrichedResult.notes.length,
      total_events: enrichedResult.events.length,
      main_contact: enrichedResult.contacts.find((c: any) => c.is_main) || null,
    };
    
    return enrichedResult;
  },

  kommo_search_leads_by_phone: async (params, client) => {
    const validated = validateToolParams('kommo_search_leads_by_phone', params);
    if (!validated.success) {
      throw new Error(`Invalid parameters: ${JSON.stringify(validated)}`);
    }
    
    const { phone } = validated.data;
    
    // Buscar contatos por telefone
    const contactsResponse = await client.get<ContactsListResponse>("/contacts", { query: phone });
    const contacts = contactsResponse._embedded?.contacts || [];
    
    if (contacts.length === 0) {
      return { total: 0, leads: [], message: "Nenhum contato encontrado com este telefone" };
    }
    
    // Buscar leads vinculados a esses contatos
    const contactIds = contacts.map(c => c.id);
    const leadsPromises = contactIds.map(contactId => 
      client.get<LeadsListResponse>("/leads", { 
        query: String(contactId),
        with: "contacts",
        limit: 250 
      }).catch(() => ({ _embedded: { leads: [] } }))
    );
    
    const leadsResponses = await Promise.all(leadsPromises);
    const allLeads = leadsResponses.flatMap(r => r._embedded?.leads || []);
    
    // Remover duplicatas por ID
    const uniqueLeads = Array.from(
      new Map(allLeads.map(lead => [lead.id, lead])).values()
    );
    
    // Enriquecer com informações de contato
    const enrichedLeads = uniqueLeads.map(lead => {
      const mainContactId = lead._embedded?.contacts?.find(c => c.is_main)?.id;
      const contact = contacts.find(c => c.id === mainContactId);
      
      if (contact) {
        const phoneField = contact.custom_fields_values?.find(
          f => f.field_code === "PHONE" || f.field_type === "multitext"
        );
        const contactPhone = phoneField?.values?.[0]?.value || null;
        
        return {
          ...lead,
          contact_info: {
            id: contact.id,
            name: contact.name,
            phone: contactPhone,
          }
        };
      }
      return lead;
    });
    
    return { 
      total: enrichedLeads.length, 
      leads: enrichedLeads,
      contacts_found: contacts.length 
    };
  },

  kommo_list_contacts: async (params, client) => {
    const validated = validateToolParams('kommo_list_contacts', params);
    if (!validated.success) {
      throw new Error(`Invalid parameters: ${JSON.stringify(validated)}`);
    }
    
    const { query, limit = 50, page = 1 } = validated.data;
    
    const queryParams: Record<string, unknown> = { limit, page };
    if (query) queryParams.query = query;
    
    const response = await client.get<ContactsListResponse>("/contacts", queryParams);
    const contacts = response._embedded?.contacts || [];
    
    // Formatar contatos com telefones e emails
    const formatted = contacts.map(contact => {
      const phoneField = contact.custom_fields_values?.find(
        f => f.field_code === "PHONE" || f.field_type === "multitext"
      );
      const emailField = contact.custom_fields_values?.find(
        f => f.field_code === "EMAIL"
      );
      
      const phones = phoneField?.values?.map(v => v.value) || [];
      const emails = emailField?.values?.map(v => v.value) || [];
      
      return {
        id: contact.id,
        name: contact.name,
        first_name: contact.first_name,
        last_name: contact.last_name,
        phones,
        emails,
        created_at: contact.created_at,
        updated_at: contact.updated_at,
      };
    });
    
    return { total: formatted.length, contacts: formatted };
  },

  kommo_list_users: async (_params, client) => {
    const response = await client.get<UsersListResponse>("/users");
    const users = response._embedded?.users || [];
    
    const formatted = users.map(user => ({
      id: user.id,
      name: user.name,
      email: user.email,
      lang: user.lang,
      can_add_leads: user.rights?.lead_add === "Y",
      can_edit_leads: user.rights?.lead_edit === "Y",
    }));
    
    return { total: formatted.length, users: formatted };
  },

  kommo_get_lead_events: async (params, client) => {
    const validated = validateToolParams('kommo_get_lead_events', params);
    if (!validated.success) {
      throw new Error(`Invalid parameters: ${JSON.stringify(validated)}`);
    }
    
    const { lead_id, limit } = validated.data;
    
    // Buscar eventos do lead (note: filter[entity_id][] requer formato de array)
    const eventsResponse = await client.get<EventsListResponse>("/events", {
      "filter[entity]": "lead",
      "filter[entity_id][]": lead_id,
      limit: limit,
    });
    
    const events = eventsResponse._embedded?.events || [];
    
    // Formatar eventos
    const formatted = events.map(event => ({
      id: event.id,
      type: event.type,
      created_at: event.created_at,
      created_by: event.created_by,
      value_after: event.value_after,
      // Para mensagens de chat, extrair info útil
      message_info: event.value_after?.[0]?.message ? {
        origin: event.value_after[0].message.origin,
        talk_id: event.value_after[0].message.talk_id,
      } : null,
    }));
    
    return {
      lead_id: lead_id,
      total_events: formatted.length,
      events: formatted,
    };
  },
};

// ========== MCP Protocol Handler ==========
async function handleMCPRequest(
  mcpRequest: MCPRequest,
  kommoBaseUrl: string,
  kommoAccessToken: string
): Promise<MCPResponse> {
  const { id, method, params } = mcpRequest;
  const client = createKommoClient(kommoBaseUrl, kommoAccessToken);

  try {
    switch (method) {
      case "initialize":
        return {
          jsonrpc: "2.0",
          id,
          result: {
            protocolVersion: MCP_PROTOCOL_VERSION,
            capabilities: {
              tools: {},
              sampling: {},
            },
            serverInfo: SERVER_INFO,
          },
        };

      case "notifications/initialized":
        return { jsonrpc: "2.0", id, result: {} };

      case "sampling/createMessage": {
        // O agente quer pedir aprovação ao usuário
        const samplingParams = params as {
          messages: Array<{ role: string; content: { type: string; text: string } }>;
          maxTokens: number;
        };
        
        // Extrair a mensagem do agente para o usuário
        const agentMessage = samplingParams.messages
          .filter((m) => m.role === "assistant")
          .map((m) => m.content.text)
          .join("\n");
        
        return {
          jsonrpc: "2.0",
          id,
          result: {
            role: "assistant",
            content: {
              type: "text",
              text: agentMessage || "Você gostaria de prosseguir com esta operação?",
            },
            model: "user-approval",
            stopReason: "endTurn",
          },
        };
      }

      case "tools/list": {
        // Gerar tool definitions dinamicamente com informações do CRM
        const toolDefinitions = await generateToolDefinitions(client);
        return {
          jsonrpc: "2.0",
          id,
          result: {
            tools: toolDefinitions,
          },
        };
      }

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
              code: JSON_RPC_ERRORS.METHOD_NOT_FOUND,
              message: ERROR_MESSAGES.TOOL_NOT_FOUND(toolName),
            },
          };
        }

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
            code: JSON_RPC_ERRORS.METHOD_NOT_FOUND,
            message: ERROR_MESSAGES.METHOD_NOT_SUPPORTED(method),
          },
        };
    }
  } catch (error) {
    return {
      jsonrpc: "2.0",
      id,
      error: {
        code: JSON_RPC_ERRORS.SERVER_ERROR,
        message: error instanceof Error ? error.message : "Internal server error",
      },
    };
  }
}

// Validar Bearer Token
const SECRET_PASSWORD = process.env.MCP_PASSWORD;

if (!SECRET_PASSWORD) {
  throw new Error('MCP_PASSWORD environment variable is required');
}

interface AuthResult {
  valid: boolean;
  subdomain?: string;
  kommoBaseUrl?: string;
  kommoAccessToken?: string;
}

function validateAuth(authHeader: string | undefined): AuthResult {
  if (!authHeader) {
    return { valid: false };
  }
  
  const [type, token] = authHeader.split(" ");
  
  if (type !== "Bearer" || !token) {
    return { valid: false };
  }
  
  const parts = token.split("|");
  
  if (parts.length !== 3) {
    return { valid: false };
  }
  
  const [password, subdomain, kommoAccessToken] = parts;
  
  // Validar apenas a senha - o Kommo validará o resto
  if (password !== SECRET_PASSWORD) {
    return { valid: false };
  }
  
  const kommoBaseUrl = `https://${subdomain}.kommo.com`;
  
  return { valid: true, subdomain, kommoBaseUrl, kommoAccessToken };
}

// ========== Fastify Server ==========
async function startServer() {
  const fastify = Fastify({ logger: true });

  // CORS
  await fastify.register(cors, {
    origin: '*',
    methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'Mcp-Session-Id'],
  });

  // Health check
  fastify.get('/', async () => {
    return {
      status: 'ok',
      version: SERVER_INFO.version,
      name: SERVER_INFO.name,
      transport: 'streamable-http',
      tools: toolNames,
    };
  });

  fastify.get('/health', async () => {
    return { status: 'ok', timestamp: new Date().toISOString() };
  });

  // ========== MCP Endpoint ==========
  fastify.post('/mcp', async (request: FastifyRequest, reply: FastifyReply) => {
    // Log para debug
    fastify.log.info({
      authorization: request.headers.authorization,
      allHeaders: Object.keys(request.headers)
    }, 'MCP request headers');
    
    const auth = validateAuth(request.headers.authorization);
    
    if (!auth.valid || !auth.kommoBaseUrl || !auth.kommoAccessToken) {
      reply.code(401);
      return { 
        jsonrpc: "2.0",
        id: null,
        error: { 
          code: 401, 
          message: ERROR_MESSAGES.UNAUTHORIZED 
        } 
      };
    }

    try {
      const parsed = request.body;
      
      // Validar se é um array ou objeto único
      const messages: MCPRequest[] = isMCPRequestArray(parsed) ? parsed : [parsed as MCPRequest];
      
      const responses: MCPResponse[] = [];
      
      for (const msg of messages) {
        // Validar cada mensagem
        const validation = mcpRequestSchema.safeParse(msg);
        if (!validation.success) {
          responses.push({
            jsonrpc: "2.0",
            id: (msg as any).id || null,
            error: {
              code: JSON_RPC_ERRORS.INVALID_REQUEST,
              message: validation.error.message,
            },
          });
          continue;
        }
        
        const response = await handleMCPRequest(validation.data, auth.kommoBaseUrl, auth.kommoAccessToken);
        if (msg.id !== undefined && msg.id !== null) {
          responses.push(response);
        }
      }

      return responses.length === 1 ? responses[0] : responses;
    } catch (error) {
      fastify.log.error(error);
      reply.code(400);
      return {
        jsonrpc: "2.0",
        id: null,
        error: {
          code: JSON_RPC_ERRORS.PARSE_ERROR,
          message: "Parse error",
        },
      };
    }
  });

  fastify.delete('/mcp', async (request: FastifyRequest, reply: FastifyReply) => {
    reply.code(204);
    return;
  });

  // ========== Legacy REST API ==========
  fastify.get('/tools', async (request: FastifyRequest, reply: FastifyReply) => {
    const auth = validateAuth(request.headers.authorization);
    
    if (!auth.valid || !auth.kommoBaseUrl || !auth.kommoAccessToken) {
      reply.code(401);
      return { error: true, message: ERROR_MESSAGES.UNAUTHORIZED };
    }

    const client = createKommoClient(auth.kommoBaseUrl, auth.kommoAccessToken);
    const toolDefinitions = await generateToolDefinitions(client);
    return { tools: toolDefinitions };
  });

  fastify.post('/execute', async (request: FastifyRequest, reply: FastifyReply) => {
    const auth = validateAuth(request.headers.authorization);
    
    if (!auth.valid || !auth.kommoBaseUrl || !auth.kommoAccessToken) {
      reply.code(401);
      return { error: true, message: ERROR_MESSAGES.UNAUTHORIZED };
    }

    try {
      const validation = executeRequestSchema.safeParse(request.body);
      
      if (!validation.success) {
        reply.code(400);
        return { 
          error: true, 
          message: `Invalid request: ${validation.error.message}` 
        };
      }
      
      const { tool: toolName, params = {} } = validation.data;

      const handler = toolHandlers[toolName];
      if (!handler) {
        reply.code(404);
        return { error: true, message: ERROR_MESSAGES.TOOL_NOT_FOUND(toolName) };
      }

      const client = createKommoClient(auth.kommoBaseUrl, auth.kommoAccessToken);
      const result = await handler(params, client);

      return { success: true, data: result };
    } catch (error) {
      fastify.log.error(error);
      reply.code(500);
      const message = error instanceof Error ? error.message : "Unknown error";
      return { error: true, message };
    }
  });

  // Start server
  const PORT = parseInt(process.env.PORT || String(SERVER_CONFIG.DEFAULT_PORT), 10);
  const HOST = process.env.HOST || SERVER_CONFIG.DEFAULT_HOST;

  try {
    await fastify.listen({ port: PORT, host: HOST });
    console.log(`🚀 Kommo MCP Server running on http://${HOST}:${PORT}`);
    console.log(`📋 Available tools: ${toolNames.length}`);
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
}

// Iniciar servidor
startServer();
