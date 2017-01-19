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
  .option('--idle-timeout <integer>', 'seconds to wait before closing idle connection, default 30s', parseFloat, 30)
  .option('--ping-interval <integer>', 'seconds to periodically update peer ping, default 10s', parseFloat, 10)
  .option('--io-path <string>', 'socket.io path, default "/iompt/socket.io"', x => x, '/iompt/socket.io')
  .option('--io-flush-interval <integer>', 'milliseconds to flush data, default 30ms', parseFloat, 30)
  .option('--io-max-buffer-size <integer>', 'default 40', parseFloat, 40)
  .option('--io-min-buffer-size <integer>', 'default 30', parseFloat, 30)
  .option('--sock-throttle-interval <integer>', 'milliseconds to pause/resume socket stream, default 20ms', parseFloat, 20)
  .option('--sock-resume-buffer-size <integer>', 'default 10', parseFloat, 10)
  .option('--sock-pause-buffer-size <integer>', 'default 20', parseFloat, 20)
  .parse(process.argv)

if (program.peer.length && program.forward.length) {
  const pool = createPool(program)

  const peers = [ ]
  program.peer.forEach((url, i) => {
    let concurrency = 1
    if (url.match(/^\d+\*/)) {
      concurrency = parseInt(url)
      url = url.substr(url.indexOf('*') + 1)
    }

    Array(concurrency).fill(0).forEach((_, j) => {
      const peer = ioClient(url, { path: program.ioPath })

      peer.on('connect', evt => {
        console.log('[C] connected to ' + url)
        peers.indexOf(peer) === -1 && peers.push(peer)
        pool.eachConn((conn, id) => conn.add(peer).emit('conn-open', forwarding[id]))
      })
      peer.on('error', evt => {
        console.log('[C] error from ' + url)
        peers.splice(peers.indexOf(peer), 1)
        pool.eachConn(conn => conn.remove(peer))
      })
      peer.on('disconnect', evt => {
        console.log('[C] disconnected from ' + url)
        peers.splice(peers.indexOf(peer), 1)
        pool.eachConn(conn => conn.remove(peer))
      })
      peer.on('conn-ping', evt => {
        peer.emit('conn-pong', evt)
      })
      peer.on('conn-pong', evt => {
        peer.lastPings = (peer.lastPings || [ ]).concat(Date.now() - evt.tick).slice(-5)
        peer.averagePing = peer.lastPings.reduce((a, b) => a + b, 0) / peer.lastPings.length
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
      forwarding[id] = { id, opts }
      peers.forEach(peer => conn.add(peer).emit('conn-open', forwarding[id]))
    })

    console.log('[C] forwarding ' + forward)
    st.length > 1 ? server.listen(+st[1], st[0]) : server.listen(+st[0])
  })

  setInterval(_ => {
    peers.forEach(peer => peer.emit('conn-ping', { tick: Date.now() }))
  }, program.pingInterval * 1000)
}

if (program.listen.length) {
  const pool = createPool(program)

  const peers = [ ]
  program.listen.forEach(listen => {
    const server = http.createServer(),
      io = ioServer(server, { path: program.ioPath }),
      st = listen.split(':')

    io.on('connection', peer => {
      const addr = peer.handshake.address
      console.log('[S] peer connected', addr)
      peers.indexOf(peer) === -1 && peers.push(peer)

      peer.on('error', evt => {
        console.log('[C] error from ' + url)
        peers.splice(peers.indexOf(peer), 1)
        pool.eachConn(conn => conn.remove(peer))
      })
      peer.on('disconnect', evt => {
        console.log('[S] peer disconnected', addr)
        peers.splice(peers.indexOf(peer), 1)
        pool.eachConn(conn => conn.remove(peer))
      })
      peer.on('conn-ping', evt => {
        peer.emit('conn-pong', evt)
      })
      peer.on('conn-pong', evt => {
        peer.lastPings = (peer.lastPings || [ ]).concat(Date.now() - evt.tick).slice(-5)
        peer.averagePing = peer.lastPings.reduce((a, b) => a + b, 0) / peer.lastPings.length
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

    console.log('[S] listening at ' + listen)
    st.length > 1 ? server.listen(+st[1], st[0]) : server.listen(+st[0])
  })

  setInterval(_ => {
    peers.forEach(peer => peer.emit('conn-ping', { tick: Date.now() }))
  }, program.pingInterval * 1000)
}

if (!program.listen.length && !(program.peer.length && program.forward.length)) {
  program.outputHelp()
  process.exit(-1)
}
