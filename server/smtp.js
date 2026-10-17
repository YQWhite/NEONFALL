'use strict';
const net = require('node:net');
const tls = require('node:tls');
function mailbox(value) {
  if (typeof value !== 'string' || /[\r\n<>]/.test(value) || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) throw new Error('Invalid email address'); return value;
}
// Implicit TLS (465) or mandatory STARTTLS (587), certificate verification enabled.
async function sendVerificationMail(config, to, code) {
  const from = mailbox(config.from); mailbox(to); if (!/^\d{6}$/.test(code)) throw new Error('Invalid verification code');
  let socket, buffer = '', lines = [], pending, queued = [], failure;
  function fail(e) { failure = e; if (pending) { pending.reject(e); pending = null; } }
  function onData(chunk) {
    buffer += chunk.toString('utf8'); if (buffer.length > 65536) { fail(new Error('SMTP response too long')); socket.destroy(); return; } let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index).replace(/\r$/, ''); buffer = buffer.slice(index + 1); lines.push(line);
      if (/^\d{3} /.test(line)) { const response = { code: Number(line.slice(0, 3)), lines }; lines = []; if (pending) { const p = pending; pending = null; p.resolve(response); } else queued.push(response); }
    }
  }
  function attach(stream) { stream.setTimeout(20000); stream.on('data', onData); stream.on('timeout', () => { fail(new Error('SMTP timeout')); stream.destroy(); }); stream.on('error', fail); stream.on('close', () => fail(new Error('SMTP connection closed'))); }
  function receive() { if (queued.length) return Promise.resolve(queued.shift()); if (failure) return Promise.reject(failure); return new Promise((resolve, reject) => { pending = { resolve, reject }; }); }
  async function command(text, expected) { const next = receive(); socket.write(text + '\r\n'); const response = await next; if (!expected.includes(response.code)) throw new Error('SMTP rejected command (' + response.code + ')'); return response; }
  try {
    socket = config.secure ? tls.connect({ host: config.host, port: config.port, servername: config.host }) : net.connect({ host: config.host, port: config.port }); attach(socket);
    if ((await receive()).code !== 220) throw new Error('SMTP greeting failed'); await command('EHLO neonfall.local', [250]);
    if (!config.secure) {
      await command('STARTTLS', [220]); socket.removeListener('data', onData); socket.removeAllListeners('close'); socket.removeAllListeners('error'); socket.removeAllListeners('timeout');
      socket = tls.connect({ socket, servername: config.host }); buffer = ''; lines = []; queued = []; failure = undefined; attach(socket);
      await new Promise((resolve, reject) => { socket.once('secureConnect', resolve); socket.once('error', reject); }); await command('EHLO neonfall.local', [250]);
    }
    if (config.user) { await command('AUTH LOGIN', [334]); await command(Buffer.from(config.user).toString('base64'), [334]); await command(Buffer.from(config.pass || '').toString('base64'), [235]); }
    await command('MAIL FROM:<' + from + '>', [250]); await command('RCPT TO:<' + to + '>', [250, 251]); await command('DATA', [354]);
    const message = ['From: ' + from, 'To: ' + to, 'Subject: NEONFALL email verification', 'Date: ' + new Date().toUTCString(), 'MIME-Version: 1.0', 'Content-Type: text/plain; charset=utf-8', 'Content-Transfer-Encoding: 7bit', '', 'Your NEONFALL verification code is: ' + code, 'This code expires in 15 minutes.'].join('\r\n');
    await command(message + '\r\n.', [250]); await command('QUIT', [221]);
  } finally { socket?.destroy(); }
}
module.exports = { sendVerificationMail };
