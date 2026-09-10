/**
 * The Biomax BM70W receiver - a SEPARATE pm2 file on purpose.
 *
 * Nothing in the normal backend deploy references this file. The API deploy
 * (.github/workflows/deploy-backend.yml) reloads pm2 process 0 only, and
 * ecosystem.config.js deliberately does not list this app, so no generic
 * `pm2 start|reload|startOrReload ecosystem.config.js` can start the receiver
 * as a side effect.
 *
 * ACTIVATION is an explicit, approved production action, run once by an
 * operator as ec2-user on dnds-be:
 *
 *   cd ~/dailyneeds-store-backend
 *   pm2 start ecosystem.biomax.config.js
 *   pm2 save
 *
 * From then on pm2 supervises it like any other app: restart on crash
 * (exponential backoff), resurrect on reboot through the existing pm2
 * startup unit. It is NOT touched by later API deploys; to pick up new
 * receiver code an operator runs `pm2 reload biomax-receiver` deliberately.
 * A reload is lossless: a punch cut mid-flight gets no ACK and the device
 * retransmits it.
 *
 * RUNTIME (D1, amended): the same unpinned `node` the API runs on - Node
 * 14.21.3 under ec2-user. No second Node is installed and the receiver is
 * never run as root to borrow root's Node 18. biomax/ is written for Node 14
 * and refuses to start below it (exit code 78).
 *
 * The receiver listens on TCP 7005 directly (no nginx). Opening that port in
 * the Lightsail IPv4 Firewall is a further, separately approved step; until
 * then a started receiver idles and answers only local smoke tests.
 */
module.exports = {
  apps: [
    {
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
};
