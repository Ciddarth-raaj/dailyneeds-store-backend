#!/usr/bin/env node
/**
 * Tells a Biomax device where to push its punches.
 *
 * UNVERIFIED. The SDK sends cs_serverinfo_set through FK_ConnectNet
 * (device password handshake) + FK_HS_ExecJsonCmd, not as bare JSON on
 * port 5005. Prefer the device menu. Record the current DigiSME settings
 * before using this.
 *
 * Sends the SDK's cs_serverinfo_set command to the device's command port
 * (5005 by default). Equivalent to setting the server IP/port in the
 * device's own menu — use whichever works.
 *
 *   DEVICE=192.168.1.50 SERVER=192.168.1.10 node set-server.js
 *
 * Env:
 *   DEVICE        device IP            (required)
 *   DEVICE_PORT   default 5005
 *   SERVER        this machine's LAN IP (required)
 *   SERVER_PORT   default 7005
 *   FRAMING       bare | len32         default bare
 */

const net = require('net');

const DEVICE = process.env.DEVICE;
const SERVER = process.env.SERVER;
const DEVICE_PORT = parseInt(process.env.DEVICE_PORT || '5005', 10);
const SERVER_PORT = process.env.SERVER_PORT || '7005';
const FRAMING = process.env.FRAMING || 'bare';

if (!DEVICE || !SERVER) {
  console.error('Set DEVICE and SERVER. Example:');
  console.error('  DEVICE=192.168.1.50 SERVER=192.168.1.10 node set-server.js');
  process.exit(1);
}

const cmd = JSON.stringify({
  cmd: 'cs_serverinfo_set',
  param: { server_ip: SERVER, server_port: String(SERVER_PORT) },
});

let out = Buffer.from(cmd, 'utf8');
if (FRAMING === 'len32') {
  const hdr = Buffer.alloc(4);
  hdr.writeUInt32BE(out.length);
  out = Buffer.concat([hdr, out]);
}

console.log(`-> ${DEVICE}:${DEVICE_PORT}  framing=${FRAMING}`);
console.log(`   ${cmd}`);

const sock = net.connect(DEVICE_PORT, DEVICE, () => sock.write(out));

sock.on('data', d => {
  console.log('device replied:');
  console.log('  utf8:', JSON.stringify(d.toString('utf8')));
  console.log('  hex :', d.toString('hex').match(/.{1,2}/g).join(' '));
  sock.end();
});
sock.on('error', e => {
  console.error('error:', e.message);
  console.error('If this times out, set the server IP/port from the device menu instead.');
});
sock.on('close', () => process.exit(0));
setTimeout(() => { console.log('no reply after 8s — try the device menu.'); sock.destroy(); }, 8000);
