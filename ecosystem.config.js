module.exports = {
  apps: [{
    name: 'hms-mileage',
    script: 'server.js',
    cwd: '/var/www/hms-mileage-server',
    restart_delay: 3000,
    max_restarts: 10,
  }]
};
