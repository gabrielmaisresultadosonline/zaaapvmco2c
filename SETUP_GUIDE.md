# 🚀 ZAPMRO CLOUD v2.0 - Guia de Setup

## 📋 Visão Geral

ZAPMRO CLOUD é uma plataforma profissional de CRM com integração WhatsApp e IA integrada. A plataforma agora possui:

✅ **Landing Page** - Página de vendas responsiva  
✅ **Autenticação** - Login e Registro integrados  
✅ **Dashboard** - Interface responsiva (mobile, tablet, desktop)  
✅ **Chat em Tempo Real** - Sistema de mensagens  
✅ **CRM Kanban** - Gerenciador de leads com drag-and-drop  
✅ **Fluxos de Automação** - Criar automações sem código  
✅ **IA Agente** - Assistente inteligente para respostas automáticas  
✅ **Eventos & Lembretes** - Agenda integrada  

## 🛠️ Pré-requisitos

- **Node.js** v16+
- **npm** ou **yarn**
- **WhatsApp Web** (para integração)
- **Navegador moderno** (Chrome, Firefox, Safari, Edge)

## 📦 Instalação

### 1. Clone ou acesse o projeto
```bash
cd kindred-connect
```

### 2. Instale as dependências
```bash
npm install
```

### 3. Configure as variáveis de ambiente

Crie um arquivo `.env` na raiz do projeto:

```env
# PORT
PORT=3000

# JWT Secret
JWT_SECRET=zapmro-2024-secret-change-this

# OpenAI API Key (opcional, para IA)
OPENAI_API_KEY=sk-xxxxxx

# Banco de Dados (se usar)
DATABASE_URL=sqlite://./data/db.sqlite

# Email (para notificações)
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USER=seu-email@gmail.com
SMTP_PASS=sua-senha-app

# Modo
NODE_ENV=production
```

### 4. Inicie o servidor

**Desenvolvimento (com auto-reload):**
```bash
npm run dev
```

**Produção:**
```bash
npm start
```

O servidor estará rodando em: **http://localhost:3000**

## 📝 Primeira Execução

1. Acesse `http://localhost:3000`
2. Na landing page, clique em **"Começar Grátis"**
3. Preencha o formulário de cadastro:
   - **Nome:** Seu nome completo
   - **E-mail:** seu@email.com
   - **Senha:** Mínimo 6 caracteres
   - **Código de acesso:** `ZAPMRO2026` (padrão para trial)
4. Clique em **"Criar Conta Grátis"**
5. Será redirecionado ao dashboard

## 🎯 Principais Funcionalidades

### 📊 Dashboard
- Stats em tempo real (mensagens, contatos, conversas)
- Atividades recentes
- Interface responsiva para mobile, tablet e desktop

### 💬 Chats
- Lista de conversas com seus clientes
- Interface WhatsApp-like
- Envio de mensagens em tempo real
- Suporte a mídia (imagens, vídeos, documentos)

### 🎴 CRM Kanban
- Organize seus leads em colunas (Novos, Em Negociação, Fechados)
- Drag-and-drop para mover cards
- Visão clara do pipeline de vendas

### 🤖 IA Agente
- Configure instruções para sua IA
- Respostas automáticas inteligentes
- Histórico de interações
- Integração com OpenAI

### 🔄 Fluxos de Automação
- Crie fluxos sem código
- Automações de follow-up
- Agendamento de mensagens
- Integração com eventos

### 📅 Eventos & Lembretes
- Agende compromissos e lembretes
- Notificações automáticas
- Integração com calendário

### ⚙️ Configurações
- Gerencie seu perfil
- Notificações
- Integrações com APIs
- Segurança e privacidade

## 🔐 Sistema de Autenticação

### Registro
- Email, senha e nome obrigatórios
- Código de acesso para validação
- Armazenamento seguro com bcrypt

### Login
- Login com email e senha
- Token JWT para autenticação
- Sessão persistente com localStorage

### Endpoints de Autenticação
```
POST /api/auth/register  - Criar conta
POST /api/auth/login     - Fazer login
POST /api/me            - Obter usuário atual
POST /api/auth/logout   - Fazer logout
```

## 📱 Responsividade

A plataforma é totalmente responsiva:

| Dispositivo | Breakpoint | Comportamento |
|-------------|-----------|---------------|
| **Desktop** | > 1024px | Sidebar completo, chat lado a lado |
| **Tablet** | 768px - 1024px | Sidebar colapsado, chat responsivo |
| **Mobile** | < 768px | Sidebar em topo, chat em coluna |

## 🎨 Customização

### Cores Principais
Edite o arquivo HTML/CSS para mudar as cores:

```css
:root {
  --primary: #128c7e;       /* Cor principal (verde WhatsApp) */
  --primary-dark: #075e54;  /* Cor escura */
  --primary-light: #25d366; /* Cor clara */
  --accent: #34b7f1;        /* Cor de destaque */
  --dark: #111b21;          /* Cor do texto escuro */
}
```

### Fontes
A plataforma usa:
- **Corpo:** Segoe UI, -apple-system, BlinkMacSystemFont
- **Fallback:** Sans-serif padrão

## 🐛 Troubleshooting

### Erro: "Cannot find module"
```bash
rm -rf node_modules
npm install
```

### Porta 3000 já em uso
```bash
# Usar outra porta
PORT=3001 npm start
```

### WhatsApp não conecta
- Escaneie o QR code novamente
- Verifique se o WhatsApp Web está acessível
- Limpe o cache do navegador

### Problemas de CORS
Adicione à configuração de servidor:
```javascript
app.use(cors());
```

## 📊 Estrutura de Pastas

```
kindred-connect/
├── Server/
│   └── index.js          # Servidor principal
├── Public/
│   ├── index.html        # Landing page + Login
│   └── dashboard.html    # Dashboard responsivo
├── data/
│   ├── users.json        # Dados de usuários
│   ├── chats.json        # Histórico de chats
│   └── ...
├── package.json
└── SETUP_GUIDE.md        # Este arquivo
```

## 🔧 Endpoints da API

### Autenticação
```
POST /api/auth/register      - Registrar novo usuário
POST /api/auth/login         - Fazer login
POST /api/auth/supabase      - Login via Supabase
GET  /api/me                 - Obter usuário atual
```

### Dashboard
```
GET /api/dashboard/stats     - Obter estatísticas
GET /api/chats               - Listar chats
POST /api/chats/:id/messages - Enviar mensagem
```

### CRM
```
GET  /api/crm/leads          - Listar leads
POST /api/crm/leads          - Criar lead
PUT  /api/crm/leads/:id      - Atualizar lead
```

### IA
```
GET  /api/ai/config          - Obter configuração
POST /api/ai/config          - Salvar configuração
POST /api/ai/chat            - Chat com IA
```

## 🚀 Deploy

### Heroku
```bash
git push heroku main
```

### Vercel
```bash
vercel deploy --prod
```

### Docker
```bash
docker build -t zapmro-cloud .
docker run -p 3000:3000 zapmro-cloud
```

## 📞 Suporte

Para dúvidas ou problemas:
- Abra uma issue no repositório
- Envie email para suporte@zapmro.com
- Visite nossa documentação em docs.zapmro.com

## 📄 Licença

© 2026 ZAPMRO CLOUD. Todos os direitos reservados.

---

**Última atualização:** 08 de Maio de 2026  
**Versão:** 2.0.0  
**Status:** ✅ Produção
