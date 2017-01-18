#!/usr/bin/env node
'use strict'

const net = require('net'),
  ioClient = require('socket.io-client'),
  ioServer = require('socket.io'),
  http = require('http'),
  program = require('commander'),
  packageJson = require('./package.json'),
  createPool = require('./pool')

program
  .version(packageJson)
  .option('-P, --peer <[concurrency*]url>', 'iompt server url, required as client', (r, p) => p.concat(r), [ ])
  .option('-F, --forward <[host:]port:remoteHost:remotePort>', 'forward host:port to remoteHost:remotePort, required as client', (r, p) => p.concat(r), [ ])
  .option('-l, --listen <[host:]port>', 'listen port, required as server', (r, p) => p.concat(r), [ ])
  .option('--io-path <string>', 'socket.io path, default "/iompt/socket.io"', x => x, '/iompt/socket.io')
  .option('--io-flush-interval <integer>', 'milliseconds to flush data, default 30ms', parseFloat, 30)
  .option('--io-max-buffer-size <integer>', 'default 40', parseFloat, 40)
  .option('--io-min-buffer-size <integer>', 'default 30', parseFloat, 30)
  .option('--idle-timeout <integer>', 'seconds to wait before closing idle connection, default 30s', parseFloat, 30)
  .option('--sock-throttle-interval <integer>', 'milliseconds to pause/resume socket stream, default 20ms', parseFloat, 20)
  .option('--sock-resume-buffer-size <integer>', 'default 10', parseFloat, 10)
  .option('--sock-pause-buffer-size <integer>', 'default 20', parseFloat, 20)
  .parse(process.argv)

if (program.peer.length && program.forward.length) {
  const pool = createPool(program)

  const peers = { }
  program.peer.forEach((url, i) => {
    let concurrency = 1
    if (url.match(/^\d+\*/)) {
      concurrency = parseInt(url)
      url = url.substr(url.indexOf('*') + 1)
    }

    Array(concurrency).fill(0).forEach((_, j) => {
      const peer = ioClient(url, { path: program.ioPath }),
        id = i + '#' + j
      peer.on('connect', evt => {
        console.log('[C] connected to ' + url)
        peers[id] = peer
        pool.all().forEach((id, conn) => {
          conn.add(peer)
          const opts = forwarding[id]
          opts && peer.emit('conn-open', { id, opts })
        })
      })
      peer.on('disconnect', evt => {
        console.log('[C] disconnected from ' + url)
        delete peers[id]
        pool.all().remove(peer)
      })
      peer.on('conn-open', evt => {
        pool.has(evt.id) && pool.open(evt.id).add(peer)
      })
      peer.on('conn-data', evt => {
        pool.has(evt.id) && pool.open(evt.id).recv(evt.index, evt.data, peer)
      })
      peer.on('conn-request', evt => {
        pool.has(evt.id) && pool.open(evt.id).rescue(evt.index)
      })
    })
  })

  const forwarding = { }
  program.forward.forEach(forward => {
    const st = forward.split(':'),
      opts = { port: +st.pop(), host: st.pop() }

    const server = net.createServer(sock => {
      const id = (0x100000000 + Math.floor(Math.random() * 0xffffffff)).toString(16).substr(1),
        conn = pool.open(id, sock)
      forwarding[id] = opts
      Object.keys(peers).map(id => peers[id]).forEach(peer => {
        conn.add(peer)
        peer.emit('conn-open', { id, opts })
      })
    })

    console.log('[C] forwarding ' + forward)
    st.length > 1 ? server.listen(+st[1], st[0]) : server.listen(+st[0])
  })
}

if (program.listen.length) {
  const pool = createPool(program)

  program.listen.forEach(listen => {
    const server = http.createServer(),
      io = ioServer(server, { path: program.ioPath })

    io.on('connection', peer => {
      const addr = peer.handshake.address
      console.log('[S] peer connected', addr)
      peer.on('error', evt => {
        console.log('[S] peer disconnected', addr)
        pool.all().remove(peer)
      })
      peer.on('disconnect', evt => {
        console.log('[S] peer disconnected', addr)
        pool.all().remove(peer)
      })
      peer.on('conn-open', evt => {
        pool.open(evt.id, evt.opts).add(peer)
      })
      peer.on('conn-data', evt => {
        pool.has(evt.id) && pool.open(evt.id).recv(evt.index, evt.data, peer)
      })
      peer.on('conn-request', evt => {
        pool.has(evt.id) && pool.open(evt.id).rescue(evt.index)
      })
    })

    const st = listen.split(':')
    console.log('[S] listening at ' + listen)
    st.length > 1 ? server.listen(+st[1], st[0]) : server.listen(+st[0])
  })
}

if (!program.listen.length && !(program.peer.length && program.forward.length)) {
  program.outputHelp()
  process.exit(-1)
}
