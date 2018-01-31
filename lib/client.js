'use strict'
// **Github:** https://github.com/toajs/quic
//
// **License:** MIT

const { createSocket } = require('dgram')
const { lookup, Visitor } = require('./internal/common')
const { parsePacket } = require('./internal/packet')
const { QuicError } = require('./internal/error')
const {
  ConnectionID,
  MaxReceivePacketSize,
  SocketAddress,
  QUIC_SERVER,
  QUIC_CLIENT,
  chooseVersion
} = require('./internal/protocol')
const {
  kSocket,
  kState,
  kVersion
} = require('./internal/symbol')

const { Session } = require('./session')
const debug = require('util').debuglog('quic')

//
// *************** Client ***************
//
class Client extends Session {
  constructor () {
    super(ConnectionID.random(), QUIC_CLIENT)
  }

  async connect (port, address) {
    if (this[kSocket]) throw new Error('Client connecting duplicated')

    let addr = await lookup(address || 'localhost')

    debug(`client connect: ${address || 'localhost'}, ${port}`, addr)
    this[kState].remotePort = port
    this[kState].remoteAddress = addr.address
    this[kState].remoteFamily = 'IPv' + addr.family
    this[kState].remoteAddr = SocketAddress.fromObject({ port: port, address: addr.address, family: 'IPv' + addr.family })

    this[kSocket] = createSocket(addr.family === 4 ? 'udp4' : 'udp6')
    this[kSocket]
      .on('error', (err) => this.emit('error', err))
      .on('close', () => clientOnClose(this))
      .on('message', (msg, rinfo) => clientOnMessage(this, msg, rinfo))

    let res = new Promise((resolve, reject) => {
      this[kSocket].once('listening', () => {
        this[kSocket].removeListener('error', reject)

        let addr = this[kSocket].address()
        this[kState].localFamily = addr.family
        this[kState].localAddress = addr.address
        this[kState].localPort = addr.port
        this[kState].localAddr = SocketAddress.fromObject(addr)
        // process.nextTick(emit, this, 'connect')
        resolve()
        this.emit('connect')
      })
      this[kSocket].once('error', reject)
    })
    this[kSocket].bind({ exclusive: true })
    return res
  }
}

function clientOnMessage (session, msg, rinfo) {
  debug(`client message: ${session.id}, ${msg.length} bytes`, rinfo)
  // The packet size should not exceed protocol.MaxReceivePacketSize bytes
  // If it does, we only read a truncated packet, which will then end up undecryptable
  if (msg.length > MaxReceivePacketSize) {
    debug(`receive too large data: ${msg.length} bytes`)
    msg = msg.slice(0, MaxReceivePacketSize)
  }

  let senderAddr = SocketAddress.fromObject(rinfo)
  let rcvTime = Date.Now()

  let bufv = Visitor.wrap(msg)
  let packet = null
  try {
    packet = parsePacket(bufv, QUIC_SERVER, session[kVersion])
  } catch (err) {
    debug(`error parsing packet for ${session.id.toString()} from ${JSON.stringify(rinfo)}: ${err.message}`)
    // drop this packet if we can't parse the Public Header
    return
  }
  // reject packets with the wrong connection ID
  if (!session.id.equals(packet.connectionID)) {
    return
  }

  if (packet.isReset()) {
    // check if the remote address and the connection ID match
    // otherwise this might be an attacker trying to inject a PUBLIC_RESET to kill the connection
    if (!this[kState].remoteAddr.equals(senderAddr)) {
      debug(`Received a spoofed Public Reset. Ignoring.`)
      return
    }

    session.closeRemote(new Error(`Received Public Reset, rejected packet number: ${packet.packetNumber}.`))
    return
  }

  if (packet.isNegotiation()) {
    // ignore delayed / duplicated version negotiation packets
    if (session[kState].receivedNegotiationPacket || session[kState].versionNegotiated) {
      return
    }

    if (session.version && packet.versions.includes(session.version)) {
      // the version negotiation packet contains the version that we offered
      // this might be a packet sent by an attacker (or by a terribly broken server implementation)
      // ignore it
      return
    }

    session[kState].receivedNegotiationPacket = true
    let newVersion = chooseVersion(packet.versions)
    if (!newVersion) {
      session.close(new QuicError('QUIC_INVALID_VERSION'))
    }

    // switch to negotiated version
    // let initialVersion = session.version
    session.version = newVersion
    // do some other...
    return
  }

  // this is the first packet after the client sent a packet with the VersionFlag set
  // if the server doesn't send a version negotiation packet, it supports the suggested version
  if (!session[kState].versionNegotiated) {
    session[kState].versionNegotiated = true
    session.emit('version', session.version)
  }

  session._handleRegularPacket(packet, rcvTime, bufv)
}

function clientOnClose (session) {

}

exports.Client = Client