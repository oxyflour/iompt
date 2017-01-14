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
  .parse(process.argv)

if (program.peer.length && program.forward.length) {
  const pool = createPool()

  const peers = { }
  program.peer.forEach((url, i) => {
    let concurrency = 1
    if (url.match(/^\d+\*/)) {
      concurrency = parseInt(url)
      url = url.substr(url.indexOf('*') + 1)
    }

    Array(concurrency).fill(0).forEach((_, j) => {
      const peer = ioClient(url),
        id = i + '#' + j
      peer.on('connect', evt => {
        console.log('[C] connected to ' + url)
        pool.all().add(peer)
        peers[id] = peer
      })
      peer.on('disconnect', evt => {
        console.log('[C] disconnected from ' + url)
        pool.all().remove(peer)
        delete peers[id]
      })
      peer.on('conn-open', evt => {
        pool.has(evt.id) && pool.open(evt.id).add(peer)
      })
      peer.on('conn-data', evt => {
        pool.has(evt.id) && pool.open(evt.id).recv(evt.index, evt.data, peer)
      })
      peer.on('conn-close', evt => {
        pool.destroy(evt.id)
      })
    })
  })

  program.forward.forEach(forward => {
    const st = forward.split(':'),
      opts = { port: +st.pop(), host: st.pop() }

    const server = net.createServer(sock => {
      const id = (0x100000000 + Math.floor(Math.random() * 0xffffffff)).toString(16).substr(1),
        conn = pool.open(id, sock)
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
  const pool = createPool()

  program.listen.forEach(listen => {
    const server = http.createServer(),
      io = ioServer(server)

    io.on('connection', peer => {
      console.log('[S] peer connected')
      peer.on('error', evt => {
        console.log('[S] peer disconnected')
        pool.all().remove(peer)
      })
      peer.on('close', evt => {
        console.log('[S] peer disconnected')
        pool.all().remove(peer)
      })
      peer.on('conn-open', evt => {
        pool.open(evt.id, evt.opts).add(peer)
      })
      peer.on('conn-data', evt => {
        pool.has(evt.id) && pool.open(evt.id).recv(evt.index, evt.data, peer)
      })
      peer.on('conn-close', evt => {
        pool.destroy(evt.id)
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
