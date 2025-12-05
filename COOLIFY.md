# Deploy no Coolify (Self-Hosted)

Coolify é uma plataforma de deploy self-hosted open-source (alternativa ao Heroku/Vercel/Railway).

**Pré-requisitos:**
- Coolify instalado no seu servidor ([docs.coolify.io](https://coolify.io/docs))
- Acesso ao painel Coolify (ex: `https://coolify.seudominio.com`)

## ⚙️ Configuração Inicial do Coolify (se ainda não fez)

### 1. Servidor/Destino

No Coolify, configure um **Server** (destino de deploy):
- Pode ser `localhost` (mesmo servidor do Coolify)
- Ou servidor remoto via SSH

### 2. Wildcard Domain (Opcional, mas recomendado)

Configure um domínio wildcard para apps automáticos:
```
*.apps.seudominio.com → IP_DO_SERVIDOR
```

Isso permite URLs automáticas tipo:
- `https://kommo-mcp.apps.seudominio.com`
- `https://outro-app.apps.seudominio.com`

### 3. Verificar Docker

Coolify precisa de Docker instalado no servidor de destino:
```bash
docker --version
docker compose version
```

---

## 🚀 Opção 1: Deploy via GitHub (Recomendado)

### 1. Preparar Coolify

1. Acesse seu painel Coolify self-hosted
2. Clique em **+ New Resource**
3. Selecione **Public Repository** (ou **Private Repository** se tiver GitHub conectado)

### 2. Configurar Projeto

**Repository URL:**
```
https://github.com/cardosolucass96/kommo-mcp-server
```

**Branch:** `main`

**Build Pack:** Selecione `Dockerfile`

### 3. Configurar Variáveis de Ambiente

No Coolify, vá em **Environment Variables** e adicione:

```env
PORT=3000
HOST=0.0.0.0
MCP_PASSWORD=M0ra1s#3013
NODE_ENV=production
```

### 4. Configurar Portas

- **Port:** `3000`
- **Expose Port:** `3000` (ou deixe o Coolify escolher)

### 5. Health Check (Opcional)

- **Health Check Path:** `/health`
- **Health Check Port:** `3000`
- **Health Check Interval:** `30s`

### 6. Deploy

1. Clique em **Deploy**
2. Aguarde o build (leva ~2-3 minutos)
3. Coolify vai gerar uma URL automática baseada no seu domínio
   - Exemplo: `https://kommo-mcp.seu-servidor.com`
   - Ou IP direto: `http://IP_DO_SERVIDOR:3000`

**Importante:** Se você configurou um domínio wildcard no Coolify (ex: `*.apps.seudominio.com`), a URL será automática. Caso contrário, configure manualmente na seção **Domains**.

---

## 🔧 Opção 2: Deploy via Docker Compose

### 1. Criar Aplicação

1. No Coolify, clique em **+ New Resource**
2. Selecione **Docker Compose**

### 2. Adicionar docker-compose.yml

Cole este conteúdo:

```yaml
version: '3.8'

services:
  kommo-mcp-server:
    image: ghcr.io/cardosolucass96/kommo-mcp-server:latest
    container_name: kommo-mcp-server
    restart: unless-stopped
    ports:
      - "3000:3000"
    environment:
      - NODE_ENV=production
      - PORT=3000
      - HOST=0.0.0.0
      - MCP_PASSWORD=${MCP_PASSWORD:-M0ra1s#3013}
    healthcheck:
      test: ["CMD", "node", "-e", "require('http').get('http://localhost:3000/health', (r) => {process.exit(r.statusCode === 200 ? 0 : 1)})"]
      interval: 30s
      timeout: 3s
      retries: 3
      start_period: 5s
```

### 3. Configurar Variáveis

Adicione as variáveis de ambiente no Coolify:

```env
MCP_PASSWORD=SuaSenhaSecreta123
```

### 4. Deploy

Clique em **Deploy** e aguarde.

---

## 🌐 Configurar Domínio Customizado

### No Coolify:

1. Vá em **Domains**
2. Adicione seu domínio: `mcp.seudominio.com`
3. Coolify configura SSL automaticamente com Let's Encrypt (se configurado)

### No seu DNS:

**Opção A: Registro A (Recomendado)**
```
Type: A
Name: mcp
Value: IP_DO_SEU_SERVIDOR_COOLIFY
TTL: 3600
```

**Opção B: CNAME (se tiver domínio base no Coolify)**
```
Type: CNAME
Name: mcp
Value: apps.seuservidor.com
TTL: 3600
```

**Aguarde propagação DNS (~5-30 minutos)**

### SSL/HTTPS

Se você configurou SSL no Coolify:
- ✅ Let's Encrypt automático (recomendado)
- ✅ Certificado customizado (avançado)
- ⚠️ Certifique-se que porta 80 e 443 estão abertas no firewall

---

## 📊 Monitoramento

### Logs

No Coolify:
1. Vá em **Logs**
2. Veja logs em tempo real

### Métricas

No Coolify você pode ver:
- CPU usage
- Memory usage
- Network I/O

---

## 🔄 Atualizar Aplicação

### Deploy Automático (CI/CD)

1. No Coolify, ative **Auto Deploy**
2. Cada push para `main` faz deploy automático

### Deploy Manual

1. No Coolify, clique em **Redeploy**
2. Aguarde o novo build

---

## 🧪 Testar Deploy

```bash
# Health check (substitua pela sua URL)
curl https://mcp.seudominio.com/health

# Ou com IP direto
curl http://IP_DO_SERVIDOR:3000/health

# Testar MCP endpoint
TOKEN="M0ra1s#3013|mpcamotestecom|SEU_KOMMO_TOKEN"
curl -X POST https://mcp.seudominio.com/mcp \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

---

## 🐛 Troubleshooting

### Build falhou

**Erro:** `Cannot find module`
- **Solução:** Verifique se `package.json` está correto
- Certifique-se que `npm install` está funcionando

**Erro:** `Port already in use`
- **Solução:** Mude a porta no Coolify (ex: 3001)

**Erro:** `Docker daemon not accessible`
- **Solução:** Verifique se Docker está rodando no servidor de destino
```bash
# No servidor
sudo systemctl status docker
sudo systemctl start docker
```

### Container não inicia

1. Vá em **Logs** no Coolify
2. Procure por erros
3. Verifique variáveis de ambiente

**Erro comum:** Variável de ambiente faltando
```bash
# Certifique-se que PORT está definido
PORT=3000
```

### Health check falhando

- Verifique se `/health` responde `200 OK`
- Aumente o `start_period` para `10s`
- Teste manualmente:
```bash
# Dentro do servidor
curl http://localhost:3000/health
```

### Sem acesso externo

**Firewall bloqueando:**
```bash
# Ubuntu/Debian
sudo ufw allow 3000/tcp
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw status

# CentOS/RHEL
sudo firewall-cmd --add-port=3000/tcp --permanent
sudo firewall-cmd --reload
```

**Porta não exposta no Coolify:**
- Vá em **Configuration** → **Ports**
- Certifique-se que porta 3000 está mapeada

**DNS não propagou:**
```bash
# Verificar DNS
nslookup mcp.seudominio.com
dig mcp.seudominio.com

# Testar com IP direto primeiro
curl http://IP_DO_SERVIDOR:3000/health
```

### SSL/HTTPS não funciona

**Let's Encrypt falhando:**
```bash
# Certifique-se que portas estão abertas
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp

# Verifique DNS apontando para IP correto
nslookup mcp.seudominio.com
```

**Certificado expirado:**
- Coolify renova automaticamente
- Se falhar, force renovação no painel Coolify

### Performance lenta

**Pouca memória:**
```bash
# Verificar uso de memória
docker stats kommo-mcp-server

# Aumentar limite no Coolify
# Configuration → Resources → Memory Limit: 512M
```

**CPU alto:**
- Verifique logs para erros infinitos
- Considere adicionar cache Redis (futuro)

---

## 💡 Dicas

### 1. Backup automático

Coolify faz backup automático da configuração.

### 2. Zero-downtime deploys

Coolify suporta rolling deploys automaticamente.

### 3. Logs persistentes

Configure volume para logs:
```yaml
volumes:
  - ./logs:/app/logs
```

### 4. Múltiplos ambientes

Crie apps separados para:
- `kommo-mcp-dev` (development)
- `kommo-mcp-staging` (staging)
- `kommo-mcp-prod` (production)

### 5. Alertas

Configure webhooks no Coolify para receber notificações de:
- Deploy falhou
- Container parou
- Health check falhou

---

## 📞 Usar no n8n

Depois do deploy no Coolify, configure no n8n MCP Agent:

```
URL: https://mcp.seudominio.com/mcp
Bearer Token: M0ra1s#3013|subdomain|kommoToken
```

Ou com IP direto (não recomendado para produção):
```
URL: http://IP_DO_SERVIDOR:3000/mcp
Bearer Token: M0ra1s#3013|subdomain|kommoToken
```

**⚠️ Importante:** Use sempre HTTPS em produção para segurança.

---

## 🔐 Segurança

### 1. Variáveis de ambiente sensíveis

Nunca coloque senhas no código. Use variáveis de ambiente no Coolify.

### 2. HTTPS obrigatório

Coolify configura SSL automaticamente. Sempre use `https://`.

### 3. Rate limiting

Considere adicionar rate limiting no Nginx (disponível no Coolify).

### 4. Firewall

Configure firewall para permitir apenas:
- Porta 80 (HTTP → redirect HTTPS)
- Porta 443 (HTTPS)
- Porta 22 (SSH - apenas seu IP)

---

## 📚 Recursos

- [Documentação Coolify](https://coolify.io/docs)
- [Coolify Discord](https://discord.gg/coolify)
- [GitHub Issues](https://github.com/coollabsio/coolify/issues)
