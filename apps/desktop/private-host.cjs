// Which server hosts a plain-http address may use. Plain http sends the password and
// session in clear text, so it is allowed only for this computer and private networks;
// everything else, public IPv6 included, needs https.
const { BlockList, isIP } = require("node:net");

/** Loopback, private and link-local ranges as [network, prefix length, family]. */
const PRIVATE_RANGES = [
  ["127.0.0.0", 8, "ipv4"], // this computer
  ["10.0.0.0", 8, "ipv4"],
  ["172.16.0.0", 12, "ipv4"],
  ["192.168.0.0", 16, "ipv4"],
  ["169.254.0.0", 16, "ipv4"], // link-local: one network segment, never routed
  ["::1", 128, "ipv6"], // this computer
  ["fc00::", 7, "ipv6"], // unique local addresses, IPv6's private networks
  ["fe80::", 10, "ipv6"], // link-local
];
const PRIVATE_ADDRESSES = new BlockList();
for (const [network, prefix, family] of PRIVATE_RANGES) PRIVATE_ADDRESSES.addSubnet(network, prefix, family);
/** Names without an address: localhost, one label (a home-network name) or a .local (mDNS) name.
 * Colons and brackets are excluded, so an IPv6 literal never passes as a name. */
const LOCAL_NAME_PATTERN = /^(localhost|[^.:[\]]+|[^:[\]]+\.local)$/i;

/**
 * Whether a server host is on this computer or a private network.
 *
 * Parameters
 * ----------
 * hostname : string
 *     `URL.hostname`: IPv6 literals in brackets (`[fd00::1]`), IPv4 already normalized
 *     by the URL parser (`0x7f.1` becomes `127.0.0.1`).
 *
 * Returns
 * -------
 * boolean
 *     true for an IP literal in `PRIVATE_RANGES` (IPv4-mapped IPv6 such as
 *     `[::ffff:c0a8:101]` counts as its IPv4 address) or a local name; false for every
 *     other address, malformed brackets included.
 */
function isPrivateHost(hostname) {
  const bracketed = /^\[(.*)\]$/.exec(hostname);
  const address = bracketed ? bracketed[1] : hostname;
  const family = isIP(address);
  // IP literals are classified by address first: the name pattern must never decide them.
  if (family === 6) return Boolean(bracketed) && PRIVATE_ADDRESSES.check(address, "ipv6");
  if (family === 4) return !bracketed && PRIVATE_ADDRESSES.check(address, "ipv4");
  return !bracketed && LOCAL_NAME_PATTERN.test(hostname);
}

module.exports = { isPrivateHost };
