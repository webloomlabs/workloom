import { lookup } from 'node:dns/promises'
import { BlockList, isIP } from 'node:net'

/**
 * SSRF protection for webhook URLs.
 *
 * Workloom is usually self-hosted inside a private network, beside databases,
 * admin panels, and a cloud metadata service. A webhook URL is a request the
 * server makes on a user's behalf, so without this anyone who can create a
 * webhook can make the server fetch `http://169.254.169.254/` or
 * `http://postgres:5432/` and read the answer back from the delivery log.
 *
 * Checked twice: when the URL is saved, for a clear error, and again at every
 * connection, inside the DNS lookup the HTTP client uses. The second check is
 * the one that matters -- a hostname can resolve to a public address when saved
 * and a private one when delivered (DNS rebinding).
 */

const blocked = new BlockList()

for (const [network, prefix] of [
  ['0.0.0.0', 8], // "this" network
  ['10.0.0.0', 8], // private
  ['100.64.0.0', 10], // carrier-grade NAT
  ['127.0.0.0', 8], // loopback
  ['169.254.0.0', 16], // link-local, including cloud metadata endpoints
  ['172.16.0.0', 12], // private
  ['192.0.0.0', 24], // IETF protocol assignments
  ['192.0.2.0', 24], // documentation
  ['192.88.99.0', 24], // 6to4 relay
  ['192.168.0.0', 16], // private
  ['198.18.0.0', 15], // benchmarking
  ['198.51.100.0', 24], // documentation
  ['203.0.113.0', 24], // documentation
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved, including broadcast
] as const) {
  blocked.addSubnet(network, prefix, 'ipv4')
}

for (const [network, prefix] of [
  ['::', 128], // unspecified
  ['::1', 128], // loopback
  ['100::', 64], // discard
  ['2001:db8::', 32], // documentation
  ['fc00::', 7], // unique local
  ['fe80::', 10], // link-local
  ['ff00::', 8], // multicast
] as const) {
  blocked.addSubnet(network, prefix, 'ipv6')
}

/**
 * IPv6 forms that embed an IPv4 address. `::ffff:127.0.0.1` is loopback in a
 * trench coat; so is `64:ff9b::7f00:1` behind a NAT64 gateway.
 */
function embeddedIpv4(address: string): string | null {
  const lower = address.toLowerCase()
  const dotted = lower.match(/^(?:::ffff:|64:ff9b::)(\d+\.\d+\.\d+\.\d+)$/)
  if (dotted) return dotted[1]!
  const hex = lower.match(/^(?:::ffff:|64:ff9b::)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/)
  if (hex) {
    const n = (parseInt(hex[1]!, 16) << 16) | parseInt(hex[2]!, 16)
    return [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.')
  }
  return null
}

export function isPublicAddress(address: string): boolean {
  const family = isIP(address)
  if (family === 4) return !blocked.check(address, 'ipv4')
  if (family === 6) {
    const v4 = embeddedIpv4(address)
    if (v4) return !blocked.check(v4, 'ipv4')
    return !blocked.check(address, 'ipv6')
  }
  return false
}

export class UnsafeWebhookUrlError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UnsafeWebhookUrlError'
  }
}

/** Validates a URL's shape. Does not resolve it; see `assertResolvesPublicly`. */
export function parseWebhookUrl(raw: string, options: { allowPrivate: boolean }): URL {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new UnsafeWebhookUrlError('Enter a full URL, including https://.')
  }
  if (url.protocol !== 'https:' && !(options.allowPrivate && url.protocol === 'http:')) {
    throw new UnsafeWebhookUrlError('Webhook URLs must use https://.')
  }
  if (url.username || url.password) {
    // Credentials in a URL end up in logs and in the delivery log UI.
    throw new UnsafeWebhookUrlError(
      'Remove the username and password from the URL; verify deliveries with the signing secret instead.',
    )
  }
  return url
}

/** Resolves a hostname and requires every address it resolves to be public. */
export async function assertResolvesPublicly(url: URL): Promise<void> {
  const host = url.hostname.replace(/^\[|\]$/g, '')
  const addresses = isIP(host)
    ? [{ address: host }]
    : await lookup(host, { all: true, verbatim: true }).catch(() => {
        throw new UnsafeWebhookUrlError(`Could not resolve ${host}.`)
      })
  const bad = addresses.find((a) => !isPublicAddress(a.address))
  if (bad) {
    throw new UnsafeWebhookUrlError(
      `${host} resolves to ${bad.address}, a private or reserved address. Webhooks can only ` +
        'be delivered to the public internet.',
    )
  }
}
