'use strict'

const net = require('net'),
  debug = require('debug')

function createConn(id, sock) {
  const log = debug('c:' + id + '')
  log('init')

  if (typeof sock.on !== 'function') {
    log('connecting to %O', sock)
    sock = net.connect(sock)
  }

  let netByteSent = 0,
    netByteRecv = 0,
    peerSentCount = { },
    peerRecvCount = { }

  const peers = [ ]
  function select() {
    return peers[Math.floor(Math.random() * peers.length)]
  }

  const ioBuffer = [ ]
  function flush() {
    let start = 0, peer = select()
    for (; start < ioBuffer.length && peer; start ++) {
      const peerId = peer.usedPeerId = peer.usedPeerId || Math.random()
      peerSentCount[peerId] = (peerSentCount[peerId] || 0) + 1

      const buf = ioBuffer[start]
      peer.emit(buf.evt, buf.data)
      peer = select()
    }
    ioBuffer.splice(0, start)
  }

  let flushTimeout = 0
  function emit(evt, data) {
    ioBuffer.push({ evt, data })
    flushTimeout = flushTimeout || setTimeout(_ => {
      flushTimeout = 0
      flush()
    }, 50)
  }

  const netBuffer = { }
  let netBufIndex = 0
  function recv(index, buf, peer) {
    lastActive = Date.now()

    const peerId = peer.usedPeerId = peer.usedPeerId || Math.random()
    peerRecvCount[peerId] = (peerRecvCount[peerId] || 0) + 1

    netBuffer[index] = buf
    while (buf = netBuffer[netBufIndex]) {
      // log('[net:%d] %O', netBufIndex, netBuffer[netBufIndex])
      sock.write(buf)
      netByteSent += buf.length
      delete netBuffer[netBufIndex ++]
    }
  }

  function destroy() {
    log('destroy (sent %d [%s], recv %d [%s])',
      netByteSent, Object.keys(peerRecvCount).map(id => peerRecvCount[id]).join('/'),
      netByteRecv, Object.keys(peerSentCount).map(id => peerSentCount[id]).join('/'))
    sock.destroy()
  }

  let ioBufIndex = 0
  sock.on('data', data => {
    lastActive = Date.now()
    netByteRecv += data.length
    emit('conn-data', { id, index: ioBufIndex ++, data })
  })

  sock.on('close', evt => {
    isClosed = true
    emit('conn-close', { id })
  })

  sock.on('error', evt => {
    isClosed = true
    emit('conn-close', { id })
  })

  function add(peer) {
    lastActive = Date.now()
    if (peers.indexOf(peer) === -1) {
      peers.push(peer)
    }
  }

  function remove(peer) {
    peers.splice(peers.indexOf(peer), 1)
  }

  let isClosed = false,
    lastActive = Date.now()

  return {
    add,
    remove,
    recv,
    destroy,
    get isClosed() { return isClosed },
    get lastActive() { return lastActive },
  }
}

function createPool(opts) {
  const log = debug('c:pool')
  log('init')

  const conns = {
    // id: conn
  }

  function check() {
    const lastActive = Date.now() - (opts && opts.activeTimeout || 30 * 1000)
    Object.keys(conns).forEach(id => {
      const conn = conns[id]
      if (conn.isClosed || conn.lastActive < lastActive) {
        destroy(id)
      }
    })
  }

  function open(id, sock) {
    if (!conns[id]) {
      log('open %s (total %d)', id, Object.keys(conns).length)
      conns[id] = createConn(id, sock)
    }
    return conns[id]
  }

  function has(id) {
    return !!conns[id]
  }

  function destroy(id) {
    const conn = conns[id]
    if (conn) {
      log('close %s', id)
      conn.destroy()
      delete conns[id]
    }
  }

  function all() {
    return {
      add(peer) {
        Object.keys(conns).forEach(id => conns[id].add(peer))
      },
      remove(peer) {
        Object.keys(conns).forEach(id => conns[id].remove(peer))
      },
    }
  }

  setInterval(check, 5000)

  return {
    has,
    open,
    destroy,
    all,
  }
}


module.exports = createPool

