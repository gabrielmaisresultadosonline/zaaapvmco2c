/**
 * ZAPMRO CLOUD - App.js
 * Funções compartilhadas da aplicação
 */

const APP = {
  API_BASE: '',
  TOKEN: localStorage.getItem('token'),
  USER: JSON.parse(localStorage.getItem('user') || '{}'),

  // ═══════════════════════════════════════════════════════════════════
  // INICIALIZAÇÃO
  // ═══════════════════════════════════════════════════════════════════
  init() {
    this.setupAuth();
    this.setupErrorHandling();
    this.setupNotifications();
  },

  // ═══════════════════════════════════════════════════════════════════
  // AUTENTICAÇÃO
  // ═══════════════════════════════════════════════════════════════════
  setupAuth() {
    if (!this.TOKEN) {
      // Redirecionar para login se necessário
      if (!window.location.pathname.includes('index.html')) {
        window.location.href = '/index.html';
      }
    }
  },

  setAuth(data) {
    this.TOKEN = data.token;
    this.USER = data.user;
    localStorage.setItem('token', data.token);
    localStorage.setItem('user', JSON.stringify(data.user));
  },

  logout() {
    localStorage.removeItem('token');
    localStorage.removeItem('user');
    window.location.href = '/index.html';
  },

  // ═══════════════════════════════════════════════════════════════════
  // API CALLS
  // ═══════════════════════════════════════════════════════════════════
  async fetch(endpoint, options = {}) {
    const defaultOptions = {
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.TOKEN}`
      }
    };

    const finalOptions = { ...defaultOptions, ...options };
    if (options.headers) {
      finalOptions.headers = { ...defaultOptions.headers, ...options.headers };
    }

    try {
      const response = await fetch(`${this.API_BASE}${endpoint}`, finalOptions);
      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || `HTTP ${response.status}`);
      }

      return data;
    } catch (error) {
      this.showError('Erro de conexão: ' + error.message);
      throw error;
    }
  },

  // ═══════════════════════════════════════════════════════════════════
  // NOTIFICAÇÕES & ALERTAS
  // ═══════════════════════════════════════════════════════════════════
  setupNotifications() {
    // Verificar suporte a notificações
    if ('Notification' in window && Notification.permission === 'granted') {
      console.log('Notificações ativadas');
    }
  },

  showSuccess(message, duration = 3000) {
    this.showAlert(message, 'success', duration);
  },

  showError(message, duration = 5000) {
    this.showAlert(message, 'error', duration);
  },

  showAlert(message, type = 'info', duration = 3000) {
    // Criar elemento de alerta
    const alertDiv = document.createElement('div');
    alertDiv.className = `alert alert-${type}`;
    alertDiv.style.cssText = `
      position: fixed;
      top: 20px;
      right: 20px;
      padding: 15px 20px;
      border-radius: 8px;
      box-shadow: 0 4px 12px rgba(0,0,0,0.15);
      z-index: 9999;
      max-width: 400px;
      animation: slideIn 0.3s ease-out;
    `;

    if (type === 'success') {
      alertDiv.style.background = '#e8f8f0';
      alertDiv.style.color = '#27ae60';
      alertDiv.style.border = '1px solid #c3e6cb';
    } else if (type === 'error') {
      alertDiv.style.background = '#fff0f0';
      alertDiv.style.color = '#c0392b';
      alertDiv.style.border = '1px solid #f5c6cb';
    }

    alertDiv.textContent = message;
    document.body.appendChild(alertDiv);

    setTimeout(() => {
      alertDiv.style.animation = 'slideOut 0.3s ease-out';
      setTimeout(() => alertDiv.remove(), 300);
    }, duration);
  },

  // ═══════════════════════════════════════════════════════════════════
  // MANIPULAÇÃO DE DADOS
  // ═══════════════════════════════════════════════════════════════════
  formatDate(date) {
    return new Date(date).toLocaleDateString('pt-BR', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });
  },

  formatTime(date) {
    return new Date(date).toLocaleTimeString('pt-BR');
  },

  formatCurrency(value) {
    return new Intl.NumberFormat('pt-BR', {
      style: 'currency',
      currency: 'BRL'
    }).format(value);
  },

  escapeHtml(text) {
    const map = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#039;'
    };
    return text.replace(/[&<>"']/g, m => map[m]);
  },

  // ═══════════════════════════════════════════════════════════════════
  // VALIDAÇÕES
  // ═══════════════════════════════════════════════════════════════════
  isValidEmail(email) {
    const regex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    return regex.test(email);
  },

  isValidPhone(phone) {
    return phone.length >= 10;
  },

  // ═══════════════════════════════════════════════════════════════════
  // TRATAMENTO DE ERROS
  // ═══════════════════════════════════════════════════════════════════
  setupErrorHandling() {
    window.addEventListener('error', (event) => {
      console.error('Erro não capturado:', event.error);
    });

    window.addEventListener('unhandledrejection', (event) => {
      console.error('Promise rejeitada:', event.reason);
    });
  },

  // ═══════════════════════════════════════════════════════════════════
  // UTILS
  // ═══════════════════════════════════════════════════════════════════
  generateId() {
    return '_' + Math.random().toString(36).substr(2, 9);
  },

  debounce(func, delay) {
    let timeout;
    return function executedFunction(...args) {
      const later = () => {
        clearTimeout(timeout);
        func(...args);
      };
      clearTimeout(timeout);
      timeout = setTimeout(later, delay);
    };
  },

  throttle(func, delay) {
    let lastCall = 0;
    return function(...args) {
      const now = Date.now();
      if (now - lastCall >= delay) {
        lastCall = now;
        return func(...args);
      }
    };
  },

  // ═══════════════════════════════════════════════════════════════════
  // STORAGE
  // ═══════════════════════════════════════════════════════════════════
  getStorage(key) {
    try {
      return JSON.parse(localStorage.getItem(key));
    } catch {
      return null;
    }
  },

  setStorage(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch (e) {
      console.warn('Storage cheio ou indisponível');
    }
  },

  removeStorage(key) {
    localStorage.removeItem(key);
  },

  // ═══════════════════════════════════════════════════════════════════
  // DOM UTILITIES
  // ═══════════════════════════════════════════════════════════════════
  $(selector) {
    return document.querySelector(selector);
  },

  $$(selector) {
    return document.querySelectorAll(selector);
  },

  createElement(tag, className = '', innerHTML = '') {
    const el = document.createElement(tag);
    if (className) el.className = className;
    if (innerHTML) el.innerHTML = innerHTML;
    return el;
  },

  // ═══════════════════════════════════════════════════════════════════
  // REQUESTANIMATIONFRAME
  // ═══════════════════════════════════════════════════════════════════
  ready(callback) {
    if (document.readyState !== 'loading') {
      callback();
    } else {
      document.addEventListener('DOMContentLoaded', callback);
    }
  }
};

// ═══════════════════════════════════════════════════════════════════
// DASHBOARD API
// ═══════════════════════════════════════════════════════════════════
const DASHBOARD = {
  async getStats() {
    return APP.fetch('/api/dashboard/stats');
  },

  async getChats() {
    return APP.fetch('/api/chats');
  },

  async sendMessage(chatId, message) {
    return APP.fetch(`/api/chats/${chatId}/messages`, {
      method: 'POST',
      body: JSON.stringify({ message })
    });
  },

  async getMessages(chatId) {
    return APP.fetch(`/api/chats/${chatId}/messages`);
  },

  // CRM
  async getLeads() {
    return APP.fetch('/api/crm/leads');
  },

  async createLead(data) {
    return APP.fetch('/api/crm/leads', {
      method: 'POST',
      body: JSON.stringify(data)
    });
  },

  async updateLead(id, data) {
    return APP.fetch(`/api/crm/leads/${id}`, {
      method: 'PUT',
      body: JSON.stringify(data)
    });
  },

  // IA
  async getAIConfig() {
    return APP.fetch('/api/ai/config');
  },

  async saveAIConfig(config) {
    return APP.fetch('/api/ai/config', {
      method: 'POST',
      body: JSON.stringify(config)
    });
  },

  async chatAI(message) {
    return APP.fetch('/api/ai/chat', {
      method: 'POST',
      body: JSON.stringify({ message })
    });
  },

  // Fluxos
  async getFlows() {
    return APP.fetch('/api/flows');
  },

  async createFlow(data) {
    return APP.fetch('/api/flows', {
      method: 'POST',
      body: JSON.stringify(data)
    });
  },

  // Eventos
  async getEvents() {
    return APP.fetch('/api/events');
  },

  async createEvent(data) {
    return APP.fetch('/api/events', {
      method: 'POST',
      body: JSON.stringify(data)
    });
  }
};

// ═══════════════════════════════════════════════════════════════════
// INICIALIZAR APP
// ═══════════════════════════════════════════════════════════════════
APP.init();
