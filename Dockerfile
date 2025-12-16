# ==========================================
# Kommo MCP Server - Multi-stage Dockerfile
# ==========================================

# Stage 1: Build
FROM node:20-alpine AS builder

WORKDIR /app

# Copiar package files
COPY package*.json ./

# Instalar dependências (ignorando scripts para evitar erro no prepare)
RUN npm ci --ignore-scripts

# Copiar código fonte
COPY tsconfig.json ./
COPY src/ ./src/

# Build TypeScript
RUN npm run build

# Remover devDependencies
RUN npm prune --production

# ==========================================
# Stage 2: Production
FROM node:20-alpine AS production

# Labels para GHCR
LABEL org.opencontainers.image.source="https://github.com/cardosolucass96/kommo-mcp-server"
LABEL org.opencontainers.image.description="Kommo MCP Server - Model Context Protocol for Kommo CRM"
LABEL org.opencontainers.image.licenses="MIT"

# Criar usuário não-root
RUN addgroup -g 1001 -S nodejs && \
    adduser -S nodejs -u 1001

WORKDIR /app

# Copiar apenas o necessário do builder
COPY --from=builder --chown=nodejs:nodejs /app/node_modules ./node_modules
COPY --from=builder --chown=nodejs:nodejs /app/dist ./dist
COPY --from=builder --chown=nodejs:nodejs /app/package.json ./

# Usar usuário não-root
USER nodejs

# Expor porta
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD wget --no-verbose --tries=1 --spider http://localhost:3000/health || exit 1

# Comando de execução
CMD ["node", "dist/server.js"]
