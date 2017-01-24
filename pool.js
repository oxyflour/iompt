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

function debounce(fn, delay) {
  let timeout = 0
  return function() {
    timeout && clearTimeout(timeout)
    timeout = setTimeout(_ => {
      timeout = 0
      fn.apply(this, arguments)
    }, delay)
  }
}

function createConn(id, sock, opts) {
  const log = debug('iompt:' + id + '')
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
    return peer
  }

  function remove(peer) {
    peers.splice(peers.indexOf(peer), 1)
  }

  const bufferSizeOf = peer => peer.client && peer.client.conn.writeBuffer.length || 0
  function select() {
    peers.forEach(peer => peer.selectOrder = (bufferSizeOf(peer) + 1 + Math.random() * 0.1) * (peer.averagePing || 1000))
    return peers.sort((a, b) => a.selectOrder - b.selectOrder)[0]
  }

  const ioBuffer = [ ]
  let ioBufStart = 0
  const throttleFlush = throttle(() => {
    let peer = select()
    for (; ioBufStart < ioBuffer.length && peer; ioBufStart ++) {
      const peerId = peer.usedPeerId = peer.usedPeerId || Math.random()
      peerSentCount[peerId] = (peerSentCount[peerId] || 0) + 1

      const buf = ioBuffer[ioBufStart]
      peer.emit('conn-data', buf)
      peer = select()
    }

    if (ioBuffer.length > opts.ioMaxBufferSize) {
      const delta = opts.ioMaxBufferSize - opts.ioMinBufferSize
      ioBuffer.splice(0, delta)
      ioBufStart -= delta
    }
  }, opts.ioFlushInterval)

  function rescue(index) {
    const buf = ioBuffer.find(buf => buf.index === index),
      peer = buf && select()
    if (buf && peer) {
      log('rescue ' + index)
      peer.emit('conn-data', buf)
    }
    else {
      const indices = ioBuffer.map(buf => buf.index)
      if (index < indices[0]) {
        const start = indices[0], end = indices[indices.length - 1]
        log('can not rescue ' + index + ' (' + start + ' ~ ' + end + ')')
      }
    }
  }

  let isPaused = false
  function checkAcknowledge() {
    if (!(ioBufIndex < ioMaxAckIndex + opts.sockMaxAcknowledgeOffset) && !isPaused) {
      log('paused at ' + ioBufIndex)
      isPaused = true
      sock.pause()
    }
  }

  let ioBufIndex = 0
  function emit(data) {
    const index = ioBufIndex ++
    ioBuffer.push({ id, index, data })
    throttleFlush()
    checkAcknowledge()
  }

  function sendAcknowledge(index) {
    const peer = select()
    if (peer && !isDestroyed) {
      peer.emit('conn-ack', { id, index })
    }
  }

  const debounceRequest = debounce((index) => {
    const peer = select()
    if (peer && !isDestroyed) {
      log('request ' + netBufIndex)
      peer.emit('conn-request', { id, index })
    }
  }, 3000)

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
        delete netBuffer[netBufIndex ++]
        debounceRequest(netBufIndex)
        if (netBufIndex % opts.sockAcknowledgeInterval === 0) {
          sendAcknowledge(netBufIndex)
        }
      }
      else {
        destroy()
        break
      }
    }
  }

  let ioMaxAckIndex = 0
  function acknowledge(index) {
    ioMaxAckIndex = Math.max(index, ioMaxAckIndex)
    if (ioBufIndex < ioMaxAckIndex + opts.sockMaxAcknowledgeOffset && isPaused) {
      log('resumed at ' + ioBufIndex)
      isPaused = false
      sock.resume()
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
    rescue,
    acknowledge,
    destroy,
    get lastActive() { return lastActive },
    get isDestroyed() { return isDestroyed },
  }
}

function createPool(opts) {
  const log = debug('iompt:POOL')
  log('init')

  const conns = { }

  function check() {
    const lastActive = Date.now() - opts.idleTimeout * 1000
    Object.keys(conns).forEach(id => {
      const conn = conns[id]
      if (conn.isDestroyed || conn.lastActive < lastActive) {
        const reason = conn.isDestroyed ? 'close' : 'timeout'
        conn.destroy()
        delete conns[id]
        log(reason + ' %s (%d left)', id, Object.keys(conns).length)
      }
    })
  }

  function has(id) {
    return !!conns[id]
  }

  function open(id, sock) {
    if (!conns[id]) {
      conns[id] = createConn(id, sock, opts)
      log('open %s (%d total)', id, Object.keys(conns).length)
    }
    return conns[id]
  }

  function eachConn(fn) {
    Object.keys(conns).forEach(id => fn(conns[id], id))
  }

  setInterval(check, 5000)

  return {
    has,
    open,
    eachConn,
  }
}


module.exports = createPool

