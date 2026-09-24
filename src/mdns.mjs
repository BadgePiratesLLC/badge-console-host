// A minimal, dependency-free mDNS (RFC 6762) query client — just enough to
// browse for `_badgeconsole._tcp.local` PTR records and resolve the SRV/A
// records that come back in the same response, which is how every mDNS
// responder (including ESPmDNS on the badge) answers a browse query.
//
// Written from the DNS message format (RFC 1035 §4.1) rather than any
// existing library, specifically to keep this repo dependency-free per the
// "inspectable" requirement in the ticket — a buyer auditing this code
// should not have to also audit a bundled third-party mDNS stack.
//
// Scope note: this is inert until the badge firmware advertises a
// `_badgeconsole._tcp` service (it does not yet, as of this repo's first
// commit — see docs/DECISIONS.md). Typed-IP pairing is the path that works
// today; this becomes useful the moment firmware adds MDNS.begin() +
// service advertisement, with no host-side changes needed.

import dgram from 'node:dgram';

const MDNS_ADDR = '224.0.0.251';
const MDNS_PORT = 5353;

function encodeName(name) {
  const parts = name.replace(/\.$/, '').split('.');
  const bufs = parts.map((p) => {
    const b = Buffer.from(p, 'utf8');
    return Buffer.concat([Buffer.from([b.length]), b]);
  });
  return Buffer.concat([...bufs, Buffer.from([0])]);
}

function encodeQuery(qname, qtype = 12 /* PTR */) {
  const header = Buffer.alloc(12);
  header.writeUInt16BE(0, 0); // ID
  header.writeUInt16BE(0, 2); // flags: standard query
  header.writeUInt16BE(1, 4); // QDCOUNT
  header.writeUInt16BE(0, 6);
  header.writeUInt16BE(0, 8);
  header.writeUInt16BE(0, 10);
  const q = Buffer.concat([encodeName(qname), Buffer.alloc(4)]);
  q.writeUInt16BE(qtype, q.length - 4);
  q.writeUInt16BE(1, q.length - 2); // QCLASS IN
  return Buffer.concat([header, q]);
}

function readName(buf, offset) {
  const labels = [];
  let jumped = false;
  let cur = offset;
  let guard = 0;
  let end = offset;
  while (guard++ < 128) {
    const len = buf[cur];
    if (len === 0) { if (!jumped) end = cur + 1; break; }
    if ((len & 0xc0) === 0xc0) {
      const pointer = ((len & 0x3f) << 8) | buf[cur + 1];
      if (!jumped) end = cur + 2;
      jumped = true;
      cur = pointer;
      continue;
    }
    labels.push(buf.toString('utf8', cur + 1, cur + 1 + len));
    cur += len + 1;
  }
  return { name: labels.join('.'), end };
}

function decodeMessage(buf) {
  const qd = buf.readUInt16BE(4);
  const an = buf.readUInt16BE(6);
  const ns = buf.readUInt16BE(8);
  const ar = buf.readUInt16BE(10);
  let offset = 12;
  for (let i = 0; i < qd; i++) {
    const { end } = readName(buf, offset);
    offset = end + 4; // QTYPE + QCLASS
  }
  const records = [];
  const total = an + ns + ar;
  for (let i = 0; i < total; i++) {
    const { name, end } = readName(buf, offset);
    offset = end;
    const type = buf.readUInt16BE(offset);
    offset += 2;
    offset += 2; // class
    offset += 4; // ttl
    const rdlength = buf.readUInt16BE(offset);
    offset += 2;
    const rdata = buf.subarray(offset, offset + rdlength);
    const record = { name, type };
    if (type === 12) { // PTR
      record.ptr = readName(buf, offset).name;
    } else if (type === 33) { // SRV
      record.port = rdata.readUInt16BE(4);
      record.target = readName(buf, offset + 6).name;
    } else if (type === 1) { // A
      record.address = Array.from(rdata).join('.');
    } else if (type === 16) { // TXT
      const txt = [];
      let p = 0;
      while (p < rdata.length) {
        const l = rdata[p];
        txt.push(rdata.toString('utf8', p + 1, p + 1 + l));
        p += l + 1;
      }
      record.txt = txt;
    }
    offset += rdlength;
    records.push(record);
  }
  return records;
}

/**
 * Browse for a service type (e.g. "_badgeconsole._tcp.local") for
 * `timeoutMs` and return any resolved instances: [{ name, host, port, txt }]
 */
export function browse(serviceType, { timeoutMs = 3000 } = {}) {
  return new Promise((resolve) => {
    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    const found = new Map(); // target -> partial record

    socket.on('message', (msg) => {
      let records;
      try { records = decodeMessage(msg); } catch { return; }
      for (const r of records) {
        if (r.type === 33) { // SRV
          const entry = found.get(r.target) || {};
          entry.host = entry.host || null;
          entry.port = r.port;
          entry.name = r.name;
          found.set(r.target, entry);
        } else if (r.type === 1) { // A
          for (const entry of found.values()) {
            // Any A record whose owner name matches an already-seen SRV
            // target resolves that instance's IP.
          }
          found.set(`__A__${r.name}`, r.address);
        } else if (r.type === 16) {
          const entry = found.get(r.name) || {};
          entry.txt = r.txt;
          found.set(r.name, entry);
        }
      }
    });

    socket.bind(0, () => {
      try { socket.setMulticastTTL(255); } catch { /* not fatal */ }
      const query = encodeQuery(serviceType, 12);
      socket.send(query, MDNS_PORT, MDNS_ADDR);
    });

    setTimeout(() => {
      socket.close();
      const results = [];
      for (const [target, entry] of found.entries()) {
        if (target.startsWith('__A__')) continue;
        const aKey = `__A__${target}`;
        const address = found.get(aKey);
        if (address && entry.port) {
          results.push({ name: entry.name, host: address, port: entry.port, txt: entry.txt || [] });
        }
      }
      resolve(results);
    }, timeoutMs);
  });
}

export const __testing = { encodeName, encodeQuery, decodeMessage, readName };
