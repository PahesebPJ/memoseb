import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import dgram from 'node:dgram'
import fs from 'node:fs'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { resolvePeerBindHosts, startAutoSyncLoop } from '../src/core/auto-sync.ts'
import { computeMemoryContentHash } from '../src/core/p2p-contract.ts'
import { renderSystemdUnit, renderWindowsLauncher } from '../src/core/service.ts'
import { computeSnapshotChecksum } from '../src/core/snapshot.ts'
import {
  acceptCallbackUrl,
  challengeEndpoint,
  computeChallengeTag,
  DISCOVERY_MAGIC_REQUEST,
  DISCOVERY_MAGIC_RESPONSE,
  discoverLanNodes,
  isAllowedHostHeader,
  probeP2PNodes,
  registerDiscoveredPeers,
  sendHttpRequest,
  startSyncServer,
  syncAllPeers,
  syncWithPeer,
  udpRequestTag,
  udpResponseTag,
  verifyChallengeTag
} from '../src/core/sync.ts'
import { locateTailscaleBinary } from '../src/core/tailscale.ts'
import { MemoryVault } from '../src/core/vault.ts'

function rawRequest(
  port: number,
  options: { method?: string; path: string; headers?: Record<string, string>; body?: string }
): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, method: options.method ?? 'GET', path: options.path, headers: options.headers },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c) => chunks.push(c))
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf-8')
          let body: any = text
          try {
            body = JSON.parse(text)
          } catch {
            // cuerpo no JSON
          }
          resolve({ status: res.statusCode ?? 0, body })
        })
      }
    )
    req.on('error', reject)
    if (options.body) req.write(options.body)
    req.end()
  })
}

async function listen(handler: http.RequestListener): Promise<{ server: http.Server; port: number }> {
  const server = http.createServer(handler)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  return { server, port: (server.address() as AddressInfo).port }
}

describe('Security hardening of the P2P node', () => {
  let tmpDir: string
  const vaults: MemoryVault[] = []
  const open = (name: string) => {
    const v = new MemoryVault({ dbPath: path.join(tmpDir, `${name}.sqlite`) })
    vaults.push(v)
    return v
  }

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memoseb-security-'))
  })
  afterEach(() => {
    for (const v of vaults.splice(0)) {
      try {
        v.close()
      } catch {
        // ya cerrada
      }
    }
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('answers the status challenge with HMAC(token, nonce|host:port) and no stats when unauthenticated', async () => {
    const vault = open('challenge')
    vault.enableNodeMode({ role: 'peer', authToken: 'secret-token' })
    vault.storeMemory({ projectId: 'den', category: 'domain', content: 'Never leaked to anonymous probes.' })
    const server = await startSyncServer(vault, { host: '127.0.0.1', port: 0, enableUdpDiscovery: false })
    try {
      const nonce = crypto.randomBytes(16).toString('hex')
      const endpoint = `127.0.0.1:${server.port}`
      const expected = crypto
        .createHmac('sha256', 'secret-token')
        .update(`${nonce}|${endpoint}`)
        .digest('hex')
      assert.equal(computeChallengeTag('secret-token', nonce, endpoint), expected)
      assert.equal(challengeEndpoint('::ffff:127.0.0.1', server.port), endpoint)

      const viaQuery = await rawRequest(server.port, { path: `/api/v1/p2p/status?nonce=${nonce}` })
      assert.equal(viaQuery.status, 200)
      assert.equal(viaQuery.body.authTag, expected)
      assert.equal(viaQuery.body.data.authTag, expected)
      assert.equal(viaQuery.body.stats, undefined)
      assert.equal(viaQuery.body.data.stats, undefined)
      assert.equal(viaQuery.body.nodeId, undefined)

      // Relay: el tag ligado a este endpoint no sirve para otro host
      assert.equal(
        verifyChallengeTag('secret-token', nonce, `100.64.0.9:${server.port}`, viaQuery.body.authTag),
        false
      )
      assert.equal(verifyChallengeTag('secret-token', nonce, endpoint, viaQuery.body.authTag), true)

      const viaHeader = await rawRequest(server.port, {
        path: '/api/v1/p2p/status',
        headers: { 'X-P2P-Nonce': nonce }
      })
      assert.equal(viaHeader.body.authTag, expected)

      const bad = await rawRequest(server.port, { path: '/api/v1/p2p/status?nonce=short' })
      assert.equal(bad.status, 400)

      const anonymous = await rawRequest(server.port, { path: '/api/v1/p2p/status' })
      assert.equal(anonymous.status, 401)

      const authed = await rawRequest(server.port, {
        path: `/api/v1/p2p/status?nonce=${nonce}`,
        headers: { Authorization: 'Bearer secret-token' }
      })
      assert.equal(authed.status, 200)
      assert.equal(authed.body.nodeId, vault.getNodeId())
      assert.equal(authed.body.authTag, expected)
    } finally {
      await server.close()
    }
  })

  it('never sends the token to a prober target that fails the challenge', async () => {
    const seenAuth: (string | undefined)[] = []
    const impostor = await listen((req, res) => {
      seenAuth.push(req.headers.authorization)
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(
        JSON.stringify({
          ok: true,
          authTag: crypto.createHmac('sha256', 'other-token').update('x').digest('hex'),
          nodeId: 'impostor',
          supportedContracts: ['p2p-memory-contract']
        })
      )
    })
    try {
      const found = await probeP2PNodes(['127.0.0.1'], { port: impostor.port, token: 'real-token' })
      assert.deepEqual(found, [])
      assert.equal(seenAuth.length, 1)
      assert.equal(seenAuth[0], undefined, 'the token is not sent before the challenge succeeds')
    } finally {
      impostor.server.close()
    }
  })

  it('accepts a callbackUrl only from its own Tailscale or loopback source address', async () => {
    assert.equal(acceptCallbackUrl('http://100.64.1.2:7432', '100.64.1.2'), 'http://100.64.1.2:7432')
    assert.equal(acceptCallbackUrl('http://100.64.1.2:7432', '::ffff:100.64.1.2'), 'http://100.64.1.2:7432')
    assert.equal(acceptCallbackUrl('http://127.0.0.1:9', '::1'), 'http://127.0.0.1:9')
    assert.equal(acceptCallbackUrl('http://100.64.1.3:7432', '100.64.1.2'), undefined)
    assert.equal(acceptCallbackUrl('http://192.168.1.4:7432', '192.168.1.4'), undefined)
    assert.equal(acceptCallbackUrl('http://evil.example:7432', '127.0.0.1'), undefined)
    assert.equal(acceptCallbackUrl('file:///etc/passwd', '127.0.0.1'), undefined)

    const server = open('callback-server')
    const client = open('callback-client')
    server.enableNodeMode({ role: 'peer', authToken: 'tok' })
    client.enableNodeMode({ role: 'peer', authToken: 'tok' })
    const handle = await startSyncServer(server, { host: '127.0.0.1', port: 0, enableUdpDiscovery: false })
    try {
      await syncWithPeer(client, {
        peerUrl: `http://127.0.0.1:${handle.port}`,
        peerRole: 'peer',
        token: 'tok',
        callbackUrl: 'http://100.64.9.9:7432'
      })
      assert.equal(server.listPeers().length, 0, 'a spoofed callbackUrl registers no peer')
    } finally {
      await handle.close()
    }
  })

  it('does not send the global token to a peer registered without its own token', async () => {
    const seenAuth: (string | undefined)[] = []
    const target = await listen((req, res) => {
      seenAuth.push(req.headers.authorization)
      res.writeHead(401, { 'Content-Type': 'application/json' })
      res.end('{"ok":false,"error":"UNAUTHORIZED"}')
    })
    try {
      const vault = open('no-fallback')
      vault.enableNodeMode({ role: 'peer', authToken: 'global-secret' })
      vault.upsertPeer({ role: 'peer', url: `http://127.0.0.1:${target.port}` })
      const summary = await syncAllPeers(vault)
      assert.equal(summary.errors.length, 1)
      assert.ok(seenAuth.length > 0)
      assert.ok(seenAuth.every((h) => h === undefined))
    } finally {
      target.server.close()
    }
  })

  it('builds LAN URLs from the datagram source and ignores announced urls', async () => {
    const socket = dgram.createSocket('udp4')
    await new Promise<void>((resolve) => socket.bind(0, '127.0.0.1', () => resolve()))
    const port = socket.address().port
    socket.on('message', (msg, rinfo) => {
      const req = JSON.parse(msg.toString('utf-8'))
      if (req.magic !== DISCOVERY_MAGIC_REQUEST) return
      const reply = Buffer.from(
        JSON.stringify({
          magic: DISCOVERY_MAGIC_RESPONSE,
          nonce: req.nonce,
          nodeId: 'lan-peer',
          nodeName: 'LAN',
          role: 'peer',
          port: 7432,
          urls: ['http://evil.example:80'],
          requiresAuth: true,
          authTags: { '127.0.0.1': udpResponseTag('lan-token', req.nonce, `127.0.0.1:${port}`) }
        })
      )
      socket.send(reply, rinfo.port, rinfo.address)
    })
    try {
      const nodes = await discoverLanNodes({
        port,
        timeoutMs: 300,
        token: 'lan-token',
        broadcastAddresses: ['127.0.0.1']
      })
      assert.equal(nodes.length, 1)
      assert.deepEqual(nodes[0]!.urls, ['http://127.0.0.1:7432'])
      // La petición va ligada al destino y la respuesta a su origen, con dominios distintos
      assert.notEqual(
        udpResponseTag('lan-token', 'n', '127.0.0.1:1'),
        udpRequestTag('lan-token', 'n', '127.0.0.1:1')
      )
      assert.notEqual(udpRequestTag('lan-token', 'n', '127.0.0.1:1'), udpRequestTag('lan-token', 'n', '127.0.0.2:1'))
      assert.notEqual(
        udpRequestTag('lan-token', 'n', '127.0.0.1:1'),
        computeChallengeTag('lan-token', 'n', '127.0.0.1:1')
      )
    } finally {
      socket.close()
    }
  })

  it('ignores a UDP announce whose tag is bound to another source address', async () => {
    const socket = dgram.createSocket('udp4')
    await new Promise<void>((resolve) => socket.bind(0, '127.0.0.1', () => resolve()))
    const port = socket.address().port
    socket.on('message', (msg, rinfo) => {
      const req = JSON.parse(msg.toString('utf-8'))
      const reply = Buffer.from(
        JSON.stringify({
          magic: DISCOVERY_MAGIC_RESPONSE,
          nonce: req.nonce,
          nodeId: 'relayed',
          nodeName: 'R',
          role: 'peer',
          port: 7432,
          requiresAuth: true,
          authTags: { '127.0.0.1': udpResponseTag('lan-token', req.nonce, `100.64.0.5:${port}`) }
        })
      )
      socket.send(reply, rinfo.port, rinfo.address)
    })
    try {
      const nodes = await discoverLanNodes({ port, timeoutMs: 300, token: 'lan-token', broadcastAddresses: ['127.0.0.1'] })
      assert.equal(nodes.length, 0)
    } finally {
      socket.close()
    }
  })

  it('caps the response size and enforces a total deadline', async () => {
    const big = await listen((_req, res) => {
      res.writeHead(200)
      res.end(Buffer.alloc(4096, 'a'))
    })
    const slow = await listen((_req, res) => {
      res.writeHead(200)
      const timer = setInterval(() => res.write('a'), 50)
      res.on('close', () => clearInterval(timer))
    })
    try {
      await assert.rejects(
        sendHttpRequest(`http://127.0.0.1:${big.port}/`, { method: 'GET', maxBytes: 1024 }),
        /exceeded 1024 bytes/
      )
      const started = Date.now()
      await assert.rejects(
        sendHttpRequest(`http://127.0.0.1:${slow.port}/`, { method: 'GET', timeoutMs: 300 }),
        /timed out/
      )
      assert.ok(Date.now() - started < 2000, 'a trickling response cannot outlive the deadline')
    } finally {
      big.server.closeAllConnections()
      big.server.close()
      slow.server.closeAllConnections()
      slow.server.close()
    }
  })

  it('takes group membership from the registered peer, never from the declared nodeId', async () => {
    const parent = open('acl-parent')
    parent.enableNodeMode({ role: 'parent', listenPort: 0 })
    parent.storeMemory({ projectId: 'secret', category: 'domain', content: 'Only for the trusted child.' })
    parent.upsertGroup({ name: 'trusted', projects: ['secret'], permissions: 'readwrite' })
    parent.addNodeToGroup('trusted', 'trusted-child-id')
    parent.upsertPeer({ role: 'child', url: 'http://100.64.0.7:7432', peerNodeId: 'trusted-child-id' })

    // El atacante declara el nodeId del hijo de confianza
    const attackerDb = path.join(tmpDir, 'acl-attacker.sqlite')
    const seed = new MemoryVault({ dbPath: attackerDb })
    seed.enableNodeMode({ role: 'child', listenPort: 0 })
    seed.close()
    const raw = new DatabaseSync(attackerDb)
    raw.prepare(`UPDATE node_meta SET value = 'trusted-child-id' WHERE key = 'node.id'`).run()
    raw.close()
    const attacker = new MemoryVault({ dbPath: attackerDb })
    vaults.push(attacker)
    assert.equal(attacker.getNodeId(), 'trusted-child-id')

    const handle = await startSyncServer(parent, { host: '127.0.0.1', port: 0, enableUdpDiscovery: false })
    try {
      const spoofed = await syncWithPeer(attacker, {
        peerUrl: `http://127.0.0.1:${handle.port}`,
        peerRole: 'parent'
      })
      assert.equal(spoofed.pulled.memoriesCreated, 0, 'declared nodeId from another address gets nothing')
      assert.equal(parent.getGroup('trusted')?.memberNodeIds.length, 1)

      // Control: registrado en loopback, el mismo nodeId sí recibe su proyecto
      parent.upsertPeer({ role: 'child', url: 'http://127.0.0.1:41009', peerNodeId: 'trusted-child-id' })
      const legit = await syncWithPeer(attacker, {
        peerUrl: `http://127.0.0.1:${handle.port}`,
        peerRole: 'parent',
        full: true
      })
      assert.equal(legit.pulled.memoriesCreated, 1)
    } finally {
      await handle.close()
    }
  })

  it('applies an update or tombstone by id only when the local project is allowed', () => {
    const vault = open('canapply')
    const stored = vault.storeMemory({
      projectId: 'secret',
      category: 'domain',
      content: 'Local secret memory.'
    }).memory
    const snap = vault.exportSnapshot()
    const moved = {
      ...snap,
      memories: snap.memories.map((m: any) => ({
        ...m,
        projectId: 'open',
        content: 'Hijacked into the open project.',
        contentHash: computeMemoryContentHash('open', m.category, 'Hijacked into the open project.'),
        updatedAt: new Date(Date.now() + 60_000).toISOString()
      })),
      projects: [...snap.projects, { id: 'open', name: 'open', rootPath: 'open', updatedAt: snap.exportedAt }]
    }
    const { checksum: _c, ...rest } = moved
    const movedSnap = { ...rest, checksum: computeSnapshotChecksum(rest as any) }
    const canApply = (projectId: string) => projectId === 'open'
    const result = vault.importSnapshot(movedSnap, { strategy: 'merge', canApply })
    assert.equal(result.memoriesUpdated, 0)
    const after = vault.exportSnapshot({ projectId: 'secret' }).memories
    assert.equal(after.length, 1)
    assert.equal(after[0]!.content, 'Local secret memory.')

    const tomb = {
      ...snap,
      memories: [],
      tombstones: [
        {
          memoryId: stored.id,
          projectId: 'open',
          contentHash: stored.contentHash,
          deletedAt: new Date(Date.now() + 60_000).toISOString(),
          originNodeId: 'attacker'
        }
      ]
    }
    const { checksum: _t, ...tombRest } = tomb
    const tombSnap = { ...tombRest, checksum: computeSnapshotChecksum(tombRest as any) }
    const deleted = vault.importSnapshot(tombSnap, { strategy: 'merge', canApply })
    assert.equal(deleted.tombstonesApplied, 0)
    assert.equal(vault.getStats().memoryCount, 1)
  })

  it('validates the Host header and requires JSON on POST', async () => {
    const vault = open('host')
    vault.enableNodeMode({ role: 'peer', authToken: 'tok' })
    const handle = await startSyncServer(vault, { host: '127.0.0.1', port: 0, enableUdpDiscovery: false })
    const auth = { Authorization: 'Bearer tok' }
    try {
      const rebinding = await rawRequest(handle.port, {
        path: '/api/v1/p2p/status',
        headers: { ...auth, Host: 'attacker.example:7432' }
      })
      assert.equal(rebinding.status, 403)
      assert.equal(rebinding.body.error, 'INVALID_HOST')
      const lanIp = await rawRequest(handle.port, {
        path: '/api/v1/p2p/status',
        headers: { ...auth, Host: '192.168.1.10:7432' }
      })
      assert.equal(lanIp.status, 403, 'a peer node only accepts loopback, Tailscale or *.ts.net hosts')
      for (const host of ['100.100.1.1:7432', 'laptop.tail1234.ts.net', 'localhost:7432']) {
        const ok = await rawRequest(handle.port, { path: '/api/v1/p2p/status', headers: { ...auth, Host: host } })
        assert.equal(ok.status, 200, host)
      }
      const form = await rawRequest(handle.port, {
        method: 'POST',
        path: '/api/v1/p2p/exchange',
        headers: { ...auth, 'Content-Type': 'text/plain' },
        body: '{}'
      })
      assert.equal(form.status, 415)
    } finally {
      await handle.close()
    }
    assert.equal(isAllowedHostHeader('192.168.1.10:7432', 'parent'), true)
    assert.equal(isAllowedHostHeader('evil.ts.net.attacker.com', 'peer'), false)
    assert.equal(isAllowedHostHeader(undefined, 'peer'), false)
  })

  it('ignores relative PATH entries and escapes service files', () => {
    const found = locateTailscaleBinary(
      { platform: 'linux', env: { PATH: '.:bin::/opt/ts/bin' } },
      null,
      () => true
    )
    assert.equal(found, '/opt/ts/bin/tailscale')
    const win = locateTailscaleBinary(
      { platform: 'win32', env: { PATH: '.;tools;\\rooted;C:\\Tailscale' } },
      null,
      () => true
    )
    assert.equal(win, 'C:\\Tailscale\\tailscale.exe')

    const unit = renderSystemdUnit({ executable: '/usr/bin/node', args: ['/home/$USER/100%/m.js'] }, '/tmp/$x.log')
    assert.ok(unit.includes('"/home/$$USER/100%%/m.js"'))
    assert.ok(unit.includes('append:/tmp/$$x.log'))
    const cmd = renderWindowsLauncher({ executable: 'C:\\node.exe', args: ['C:\\%TEMP%\\m.js'] })
    assert.ok(cmd.includes('"C:\\%%TEMP%%\\m.js"'))
  })

  it('binds a Tailscale-enabled peer to its Tailscale IP plus loopback instead of 0.0.0.0', async () => {
    const runtime = { platform: 'linux' as const, env: {}, execProcess: async () => ({ exitCode: 0, stdout: '', stderr: '' }) }
    const interfaces = {
      tailscale0: [{ address: '100.101.1.1', family: 'IPv4', internal: false } as os.NetworkInterfaceInfo]
    }
    const running = async () =>
      ({ state: 'running', binary: 'tailscale', status: { backendState: 'Running', selfIps: ['100.101.1.1', 'fd7a::1'], peers: [] } }) as any
    const absent = async () => ({ state: 'absent' }) as any
    const base = { role: 'peer' as const, listenHost: '0.0.0.0', tailscaleBin: null }
    assert.deepEqual(
      await resolvePeerBindHosts(runtime, base, { probeTailscale: running, interfaces }),
      ['100.101.1.1', '127.0.0.1']
    )
    assert.deepEqual(await resolvePeerBindHosts(runtime, base, { probeTailscale: absent, interfaces }), [])
    assert.deepEqual(
      await resolvePeerBindHosts(runtime, { ...base, listenHost: '127.0.0.1' }, { probeTailscale: running, interfaces }),
      []
    )
    assert.deepEqual(
      await resolvePeerBindHosts(runtime, { ...base, role: 'parent' }, { probeTailscale: running, interfaces }),
      []
    )
    assert.deepEqual(
      await resolvePeerBindHosts(runtime, base, { probeTailscale: running, interfaces: {} }),
      [],
      'an IP not present locally is never bound'
    )
  })

  it('runs discovery only for role peer, under the same mutex as sync, and stops between peers on close', async () => {
    const parent = open('loop-parent')
    parent.enableNodeMode({ role: 'parent', authToken: 'tok' })
    let parentDiscoveries = 0
    const parentLoop = startAutoSyncLoop(parent, {
      intervalMs: 60_000,
      discoveryIntervalMs: 20,
      changePollMs: 60_000,
      discover: async () => {
        parentDiscoveries++
        return []
      }
    })
    await new Promise((r) => setTimeout(r, 120))
    await parentLoop.close()
    assert.equal(parentDiscoveries, 0)
    assert.deepEqual(registerDiscoveredPeers(parent, [
      { nodeId: 'x', nodeName: 'x', role: 'peer', port: 1, urls: ['http://127.0.0.1:1'], address: '127.0.0.1', requiresAuth: true }
    ]), [])

    let discovering = false
    const overlaps: boolean[] = []
    const target = await listen((_req, res) => {
      overlaps.push(discovering)
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end('{"ok":false}')
    })
    try {
      const peer = open('loop-peer')
      peer.enableNodeMode({ role: 'peer', authToken: 'tok' })
      peer.upsertPeer({ role: 'peer', url: `http://127.0.0.1:${target.port}`, authToken: 'tok' })
      let first = true
      const loop = startAutoSyncLoop(peer, {
        intervalMs: 60_000,
        discoveryIntervalMs: 60_000,
        changePollMs: 60_000,
        discover: async () => {
          if (!first) return []
          first = false
          discovering = true
          await new Promise((r) => setTimeout(r, 150))
          discovering = false
          return []
        }
      })
      await new Promise((r) => setTimeout(r, 30))
      await loop.syncNow('manual')
      await loop.close()
      assert.ok(overlaps.length > 0)
      assert.ok(overlaps.every((o) => o === false), 'sync never overlaps a running discovery')
    } finally {
      target.server.close()
    }

    const aborted = await syncAllPeers(open('aborted'), { signal: AbortSignal.abort() })
    assert.equal(aborted.results.length + aborted.errors.length, 0)
  })

  it('migrates legacy content hashes once, skipping rows that would collide', () => {
    const dbPath = path.join(tmpDir, 'legacy.sqlite')
    const seed = new MemoryVault({ dbPath })
    const store = (content: string) =>
      seed.storeMemory({ projectId: 'den', category: 'domain', content }).memory
    const a = store('Alpha legacy.')
    const b = store('Beta legacy.')
    const c = store('Gamma legacy.')
    seed.close()
    const hash = (content: string) => computeMemoryContentHash('den', 'domain', content)
    const raw = new DatabaseSync(dbPath)
    raw.prepare(`DELETE FROM node_meta WHERE key = 'migration.content_hash_v1'`).run()
    const set = raw.prepare(`UPDATE memories SET content_hash = ? WHERE id = ?`)
    set.run('legacy-c', c.id)
    set.run('legacy-b', b.id)
    set.run(hash('Beta legacy.'), a.id)
    set.run(hash('Alpha legacy.'), b.id)
    raw.close()

    const migrated = new MemoryVault({ dbPath })
    vaults.push(migrated)
    const byId = new Map(migrated.exportSnapshot().memories.map((m) => [m.id, m.contentHash]))
    // A y B tienen el hash del otro: cada uno chocaría, así que se saltan; C migra
    assert.equal(byId.get(a.id), hash('Beta legacy.'))
    assert.equal(byId.get(b.id), hash('Alpha legacy.'))
    assert.equal(byId.get(c.id), hash('Gamma legacy.'))
    migrated.close()
    const raw2 = new DatabaseSync(dbPath)
    raw2.prepare(`UPDATE memories SET content_hash = 'legacy-again' WHERE id = ?`).run(a.id)
    raw2.close()
    const reopened = new MemoryVault({ dbPath })
    vaults.push(reopened)
    assert.equal(
      reopened.exportSnapshot().memories.find((m) => m.id === a.id)?.contentHash,
      'legacy-again',
      'the migration runs only once'
    )
  })

  it('migrates a non-colliding legacy hash to the contract formula', () => {
    const dbPath = path.join(tmpDir, 'legacy2.sqlite')
    const seed = new MemoryVault({ dbPath })
    const a = seed.storeMemory({ projectId: 'den', category: 'domain', content: 'Gamma legacy.' }).memory
    seed.close()
    const raw = new DatabaseSync(dbPath)
    raw.prepare(`DELETE FROM node_meta WHERE key = 'migration.content_hash_v1'`).run()
    raw.prepare(`UPDATE memories SET content_hash = ? WHERE id = ?`).run('legacy-g', a.id)
    raw.close()
    const migrated = new MemoryVault({ dbPath })
    vaults.push(migrated)
    assert.equal(
      migrated.exportSnapshot().memories[0]!.contentHash,
      computeMemoryContentHash('den', 'domain', 'Gamma legacy.')
    )
  })

  it('excludes removed peers from discovery, bounds the interval and restricts the vault file', () => {
    const vault = open('exclusions')
    vault.enableNodeMode({ role: 'peer', authToken: 'tok' })
    const node = {
      nodeId: 'removed-node',
      nodeName: 'R',
      role: 'peer' as const,
      port: 7432,
      urls: ['http://100.64.0.3:7432'],
      address: '100.64.0.3',
      requiresAuth: true,
      authVerified: true
    }
    assert.equal(registerDiscoveredPeers(vault, [node], { token: 'tok' }).length, 1)
    assert.equal(vault.removePeer('removed-node', { exclude: true }), true)
    assert.deepEqual(vault.getExcludedPeerIds(), ['removed-node'])
    assert.equal(registerDiscoveredPeers(vault, [node], { token: 'tok' }).length, 0)
    vault.includePeer('removed-node')
    assert.equal(registerDiscoveredPeers(vault, [node], { token: 'tok' }).length, 1)

    assert.throws(() => vault.updateNodeConfig({ syncIntervalMinutes: 0 }), /between 1 and 1440/)
    assert.throws(() => vault.updateNodeConfig({ syncIntervalMinutes: 1441 }), /between 1 and 1440/)
    assert.equal(vault.updateNodeConfig({ syncIntervalMinutes: 1440 }).syncIntervalMinutes, 1440)

    if (process.platform !== 'win32') {
      const mode = fs.statSync(path.join(tmpDir, 'exclusions.sqlite')).mode & 0o777
      assert.equal(mode, 0o600)
    }
  })
})
