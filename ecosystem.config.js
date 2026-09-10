module.exports = {
  apps: [
    {
      // The API. Unnamed historically; the deploy reloads it as `pm2 reload 0`.
      script: "server.js",
      env: {
        NODE_ENV: "production",
      },
    },
    {
      // The Biomax BM70W receiver - a separate always-on process so an API
      // deploy or restart never drops a punch (and a receiver restart loses
      // nothing either: an unacknowledged punch is retransmitted by the
      // device). Started once by hand, then `pm2 save`; the deploy workflow
      // reloads it with `pm2 startOrReload ecosystem.config.js --only
      // biomax-receiver`. Listens on TCP 7005 directly (no nginx); open that
      // port in the Lightsail IPv4 Firewall only when parallel testing is
      // approved.
      //
      // RUNTIME (D1, amended): the same unpinned `node` the API runs on -
      // Node 14.21.3 under ec2-user on dnds-be. No second Node is installed
      // and the receiver is never run as root to borrow root's Node 18.
      // biomax/ is written for Node 14 and refuses to start below it.
      name: "biomax-receiver",
      script: "biomax/receiver.js",
      exec_mode: "fork",
      instances: 1,
      autorestart: true,
      exp_backoff_restart_delay: 1000,
      max_restarts: 50,
      kill_timeout: 6000,
      env: {
        NODE_ENV: "production",
        BIOMAX_PORT: "7005",
      },
    },
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
