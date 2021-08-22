module.exports = {
  apps: [{
    script: "server.js",
    env: {
      NODE_ENV: "production",
    },
  },],

  deploy: {
    production: {
      user: 'SSH_USERNAME',
      host: 'SSH_HOSTMACHINE',
      ref: 'origin/master',
      repo: 'GIT_REPOSITORY',
      path: 'DESTINATION_PATH',
      'pre-deploy-local': '',
      "post-deploy":
        "npm install && cd migrations/mysql && db-migrate up && cd ../../ && pm2 reload ecosystem.config.js --env production",
      'pre-setup': ''
    }
  }
};
