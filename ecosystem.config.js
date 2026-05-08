export default {
  apps: [{
    name: 'zapmro',
    script: './Server/index.js',
    instances: 1,
    autorestart: true,
    watch: false,
    max_memory_restart: '800M',
    restart_delay: 3000,
    env: {
      NODE_ENV: 'production',
      PORT: 3000
    },
    error_file: '~/.pm2/logs/zapmro-error.log',
    out_file: '~/.pm2/logs/zapmro.log',
    log_file: '~/.pm2/logs/zapmro-combined.log',
    time: true
  }]
};
