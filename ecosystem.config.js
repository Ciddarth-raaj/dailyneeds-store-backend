module.exports = {
  apps: [
    {
      // The API. Unnamed historically; the deploy reloads it as `pm2 reload 0`.
      script: "server.js",
      env: {
        NODE_ENV: "production",
      },
    },
    // The Biomax BM70W receiver is deliberately NOT declared in this file.
    // It has its own ecosystem.biomax.config.js so that no generic
    // `pm2 start|reload|startOrReload ecosystem.config.js` - the deploy
    // workflow's, the unused `deploy.production.post-deploy` below, or an
    // operator's - can start it as a side effect. Activating the receiver is
    // a separate, approved production action.
  ],

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
