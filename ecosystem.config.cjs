module.exports = {
  apps: [{
    name: 'xxb-ts',
    script: './dist/index.js',
    node_args: '--max-old-space-size=512',
    instances: 1,
    exec_mode: 'fork',
    autorestart: true,
    max_memory_restart: '500M',
    env_production: {
      NODE_ENV: 'production',
    },
    error_file: './logs/error.log',
    out_file: './logs/out.log',
    time: true,
  }],
};
