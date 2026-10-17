'use strict';
// Local SMTP protocol checks. TLS transport is stubbed; no external mailbox is contacted.
const assert = require('node:assert/strict');
const net = require('node:net');
const tls = require('node:tls');
const { sendVerificationMail } = require('../server/smtp.js');
async function mockServer(rejectAuth = false) {
  const received = { commands: [], message: '' }, sockets = new Set();
  const server = net.createServer(socket => {
    sockets.add(socket); socket.on('close', () => sockets.delete(socket));
    socket.write('220 local.test ESMTP\r\n'); let buffer = '', data = false, auth = 0;
    socket.on('data', bytes => {
      buffer += bytes.toString('utf8'); let pos;
      while ((pos = buffer.indexOf('\r\n')) >= 0) {
        const line = buffer.slice(0, pos); buffer = buffer.slice(pos + 2);
        if (data) { if (line === '.') { data = false; socket.write('250 accepted\r\n'); } else received.message += line + '\n'; continue; }
        if (auth) { if (auth === 1) { assert.equal(Buffer.from(line, 'base64').toString(), 'smtp-user'); auth = 2; socket.write('334 UGFzc3dvcmQ6\r\n'); } else { assert.equal(Buffer.from(line, 'base64').toString(), 'smtp-pass'); auth = 0; socket.write(rejectAuth ? '535 denied\r\n' : '235 authenticated\r\n'); } continue; }
        received.commands.push(line);
        if (line.startsWith('EHLO ')) socket.write('250-local.test\r\n250 AUTH LOGIN\r\n');
        else if (line === 'AUTH LOGIN') { auth = 1; socket.write('334 VXNlcm5hbWU6\r\n'); }
        else if (line === 'STARTTLS') socket.write('454 TLS unavailable\r\n');
        else if (line.startsWith('MAIL FROM:') || line.startsWith('RCPT TO:')) socket.write('250 ok\r\n');
        else if (line === 'DATA') { data = true; socket.write('354 send data\r\n'); }
        else if (line === 'QUIT') socket.end('221 goodbye\r\n');
        else socket.write('500 unexpected\r\n');
      }
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { received, port: server.address().port, stop: () => new Promise(resolve => { for (const socket of sockets) socket.destroy(); server.close(resolve); }) };
}
async function run() {
  const realConnect = tls.connect;
  const config = { host: '127.0.0.1', port: 0, secure: true, user: 'smtp-user', pass: 'smtp-pass', from: 'from@example.test' };
  let mock;
  try {
    tls.connect = options => { assert.notEqual(options.rejectUnauthorized, false); return net.connect({ host: options.host, port: options.port }); };
    mock = await mockServer(); config.port = mock.port;
    await sendVerificationMail(config, 'to@example.test', '123456');
    assert.match(mock.received.message, /Your NEONFALL verification code is: 123456/);
    assert.deepEqual(mock.received.commands.map(s => s.split(' ')[0]), ['EHLO', 'AUTH', 'MAIL', 'RCPT', 'DATA', 'QUIT']); await mock.stop();
    mock = await mockServer(true); config.port = mock.port;
    await assert.rejects(sendVerificationMail(config, 'to@example.test', '123456'), /535/); await mock.stop();
    mock = await mockServer(); config.port = mock.port;
    await assert.rejects(sendVerificationMail({ ...config, secure: false }, 'to@example.test', '123456'), /454/);
    assert.equal(mock.received.commands.some(line => line.startsWith('AUTH')), false, 'never authenticate without TLS'); await mock.stop();
    await assert.rejects(sendVerificationMail(config, 'to@example.test\r\nBcc: victim@example.test', '123456'), /Invalid email/);
    await assert.rejects(sendVerificationMail(config, 'to@example.test', 'invalid'), /Invalid verification/);
    console.log('SMTP protocol: delivery, AUTH rejection, mandatory STARTTLS and header validation passed; external delivery and TLS handshake require configured SMTP.');
  } finally { tls.connect = realConnect; await mock?.stop(); }
}
run().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
