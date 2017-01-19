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

  let isPaused = false
  const throttlePause = throttle(() => {
    const sizes = peers.length ? peers.map(bufferSizeOf) : [0],
      min = Math.min.apply(Math, sizes),
      max = Math.max.apply(Math, sizes)
    if (min > opts.sockPauseBufferSize && !isPaused) {
      isPaused = true
      sock.pause()
      log('pause (min %d)', min)
    }
    else if (max < opts.sockResumeBufferSize && isPaused) {
      isPaused = false
      sock.resume()
      log('resume (max %d)', max)
    }
    if (isPaused) {
      throttlePause()
    }
  }, opts.sockThrottleInterval)

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

  let ioBufIndex = 0
  function emit(data) {
    const index = ioBufIndex ++
    ioBuffer.push({ id, index, data })
    throttleFlush()
    throttlePause()
  }

  const debounceRequest = debounce(() => {
    const peer = select()
    if (peer && !isDestroyed) {
      log('request ' + netBufIndex)
      const index = netBufIndex
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
      }
      else {
        destroy()
        break
      }
    }

    if (!isDestroyed) {
      debounceRequest()
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
    destroy,
    get lastActive() { return lastActive },
    get isDestroyed() { return isDestroyed },
    get isPaused() { return isPaused },
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

