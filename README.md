# ZAPMRO CLOUD v2.0

> CRM Profissional para WhatsApp com IA Integrada

## 🚀 Deploy Rápido no VPS (Ubuntu 24 LTS - Hostinger)

```bash
# 1. Conectar no VPS
ssh root@SEU_IP

# 2. Download e execução do script de deploy
curl -fsSL https://raw.githubusercontent.com/gabrielmaisresultadosonline/kindred-connect/main/deploy.sh | bash

# 3. Acessar o sistema
# http://SEU_IP:3000
```

## 📋 Instalação Manual

```bash
# Clonar repositório
git clone https://github.com/gabrielmaisresultadosonline/kindred-connect.git
cd kindred-connect

# Instalar dependências
npm install

# Configurar variáveis de ambiente
cp .env.example .env
nano .env  # Configure sua API Key OpenAI, etc.

# Iniciar em produção com PM2
pm2 start ecosystem.config.js
pm2 save
pm2 startup
```

## ⚙️ Variáveis de Ambiente (.env)

```env
PORT=3000
JWT_SECRET=sua-chave-secreta-jwt
OPENAI_API_KEY=sk-...          # Para IA
DEEPSEEK_API_KEY=...           # Alternativa ao OpenAI
SUPABASE_URL=...               # Para auth cloud
SUPABASE_PUBLISHABLE_KEY=...
TEST_PROMO_CODE=ZAPMRO2026     # Código de acesso
ADMIN_EMAIL=admin@seudominio.com
ADMIN_PASSWORD=suasenha
```

## 🔧 Gerenciamento PM2

```bash
pm2 status                 # Ver status
pm2 logs zapmro            # Ver logs em tempo real
pm2 restart zapmro         # Reiniciar
pm2 stop zapmro            # Parar
```

## 🔄 Atualizar no VPS

```bash
cd ~/kindred-connect
git pull origin main
pm2 restart zapmro
```

## 📱 Funcionalidades

- **WhatsApp Multi-sessão** - Múltiplas conexões simultâneas
- **CRM Kanban** - Pipeline de vendas visual
- **Fluxos de Automação** - Respostas automáticas por keyword
- **IA Integrada** - OpenAI / DeepSeek
- **Agendamentos** - Mensagens programadas
- **Campanhas WinBack** - Reativação de clientes
- **Histórico em Nuvem** - Persistência de conversas
- **Auth Supabase** - Login seguro com Google

## 📁 Estrutura

```
kindred-connect/
├── Server/
│   └── index.js         # Backend completo
├── Public/
│   ├── index.html       # Login
│   ├── dashboard.html   # CRM Dashboard
│   └── uploads/         # Arquivos enviados
├── data/
│   ├── users.json
│   ├── sessions.json
│   ├── flows.json
│   ├── ai_config.json
│   ├── kanban.json
│   ├── scheduled_messages.json
│   ├── winback_campaigns.json
│   └── history/         # Histórico de chats
├── .wwebjs_auth/        # Sessões WhatsApp
├── deploy.sh            # Script de deploy
├── ecosystem.config.js  # Config PM2
└── package.json
```

## 🔐 Acesso Padrão

- URL: `http://SEU_IP:3000`
- Email admin: `admin@zapmro.cloud`
- Senha: `admin123`
- Código de acesso: `ZAPMRO2026`

> ⚠️ **Importante:** Altere as credenciais padrão após o primeiro acesso!
