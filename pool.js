'use strict'

const net = require('net'),
  debug = require('debug')

function throttle(fn, interval) {
  let timeout = 0
  return function() {
    timeout = timeout || setTimeout(_ => {
      timeout = 0
      fn.apply(this, arguments)
    }, interval)
  }
}

function createConn(id, sock) {
  const log = debug('c:' + id + '')
  log('init')

  if (typeof sock.on !== 'function') {
    log('connecting to %O', sock)
    sock = net.connect(sock)
  }

  let lastActive = Date.now(),
    netSentBytes = 0,
    netRecvBytes = 0,
    peerSentCount = { },
    peerRecvCount = { }

  const peers = [ ]
  function add(peer) {
    lastActive = Date.now()
    if (peers.indexOf(peer) === -1) {
      peers.push(peer)
    }
  }

  function remove(peer) {
    peers.splice(peers.indexOf(peer), 1)
  }

  function select() {
    return peers
      .map(peer => [peer, peer.client && peer.client.conn.writeBuffer.length || 0])
      .filter(data => data[1] >= 0)
      .sort((a, b) => a[1] - b[1])
      .map(data => data[0])[0]
  }

  let sockPaused = false
  const throttlePause = throttle(() => {
    const sizes = peers
        .map(peer => peer.client && peer.client.conn.writeBuffer.length || 0),
      sz = sizes.length ? sizes : [0],
      min = Math.min.apply(Math, sz),
      max = Math.max.apply(Math, sz)
    if (min > 20 && !sockPaused) {
      sockPaused = true
      sock.pause()
      log('pause (min %d)', min)
    }
    else if (max < 10 && sockPaused) {
      sockPaused = false
      sock.resume()
      log('resume (max %d)', max)
    }
    if (sockPaused) {
      throttlePause()
    }
  }, 20)

  const ioBuffer = [ ]
  const throttleFlush = throttle(() => {
    let start = 0, peer = select()
    for (; start < ioBuffer.length && peer; start ++) {
      const peerId = peer.usedPeerId = peer.usedPeerId || Math.random()
      peerSentCount[peerId] = (peerSentCount[peerId] || 0) + 1

      const buf = ioBuffer[start]
      peer.emit('conn-data', buf)
      peer = select()
    }
    ioBuffer.splice(0, start)
  }, 30)

  let ioBufIndex = 0
  function emit(data) {
    const index = ioBufIndex ++
    ioBuffer.push({ id, index, data })
    throttleFlush()
    throttlePause()
  }

  const netBuffer = { }
  let netBufIndex = 0
  function recv(index, buf, peer) {
    lastActive = Date.now()

    const peerId = peer.usedPeerId = peer.usedPeerId || Math.random()
    peerRecvCount[peerId] = (peerRecvCount[peerId] || 0) + 1

    netBuffer[index] = buf
    while (buf = netBuffer[netBufIndex]) {
      if (buf.length) {
        sock.write(buf)
        netSentBytes += buf.length
      }
      else {
        destroy()
        break
      }
      delete netBuffer[netBufIndex ++]
    }
  }

  let isDestroyed = false
  function destroy() {
    if (!isDestroyed) {
      isDestroyed = true
      log('destroy (sent %d [%s], recv %d [%s])',
        netSentBytes, Object.keys(peerRecvCount).map(id => peerRecvCount[id]).join('/'),
        netRecvBytes, Object.keys(peerSentCount).map(id => peerSentCount[id]).join('/'))
      sock.destroy()
    }
  }

  sock.on('data', buf => {
    lastActive = Date.now()
    netRecvBytes += buf.length
    emit(buf)
  })

  sock.on('close', evt => {
    emit(-1)
  })

  sock.on('error', evt => {
    emit(-1)
  })

  return {
    add,
    remove,
    recv,
    destroy,
    get lastActive() { return lastActive },
    get isDestroyed() { return isDestroyed },
  }
}

function createPool(opts) {
  const log = debug('c:POOL')
  log('init')

  const conns = { }

  function check() {
    const lastActive = Date.now() - (opts && opts.activeTimeout || 30 * 1000)
    Object.keys(conns).forEach(id => {
      const conn = conns[id]
      if (conn.isDestroyed || conn.lastActive < lastActive) {
        conn.destroy()
        delete conns[id]
        log('close %s (%d left)', id, Object.keys(conns).length)
      }
    })
  }

  function has(id) {
    return !!conns[id]
  }

  function open(id, sock) {
    if (!conns[id]) {
      conns[id] = createConn(id, sock)
      log('open %s (%d total)', id, Object.keys(conns).length)
    }
    return conns[id]
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
    all,
  }
}


module.exports = createPool

