import { test } from 'node:test';
import assert from 'node:assert/strict';
import { __testing } from '../src/mdns.mjs';

const { encodeName, encodeQuery, decodeMessage } = __testing;

test('encodeName produces length-prefixed labels terminated by a zero byte', () => {
  const buf = encodeName('_badgeconsole._tcp.local');
  assert.equal(buf[0], '_badgeconsole'.length);
  assert.equal(buf.subarray(1, 1 + 13).toString('utf8'), '_badgeconsole');
  assert.equal(buf[buf.length - 1], 0);
});

test('encodeQuery produces a well-formed 12-byte header + one question', () => {
  const buf = encodeQuery('_badgeconsole._tcp.local', 12);
  assert.equal(buf.readUInt16BE(4), 1); // QDCOUNT
  assert.equal(buf.readUInt16BE(6), 0); // ANCOUNT
});

test('decodeMessage round-trips a hand-built PTR+SRV+A+TXT response', () => {
  // Build a minimal mDNS response by hand: one PTR answer pointing at an
  // instance name, then SRV/A/TXT records for that instance, using name
  // compression pointers the way real responders do.
  const header = Buffer.alloc(12);
  header.writeUInt16BE(0x8400, 2); // response, authoritative
  header.writeUInt16BE(0, 4);
  header.writeUInt16BE(4, 6); // ANCOUNT = 4

  const svcName = encodeName('_badgeconsole._tcp.local');
  const svcOffset = 12;

  const instanceLabel = Buffer.concat([Buffer.from([13]), Buffer.from('deskA1b2c3d4', 'utf8').subarray(0, 13)]);
  // Simplify: instance name is "inst._badgeconsole._tcp.local" but reuse
  // the service name via a compression pointer for the suffix.
  const instPrefix = Buffer.concat([Buffer.from([4]), Buffer.from('inst', 'utf8')]);
  const pointerToSvc = Buffer.from([0xc0, svcOffset]);
  const instName = Buffer.concat([instPrefix, pointerToSvc]);
  const instOffset = svcOffset + svcName.length;

  function record(nameBuf, type, rdata) {
    const head = Buffer.alloc(2 + 2 + 4 + 2);
    let o = 0;
    head.writeUInt16BE(type, o); o += 2;
    head.writeUInt16BE(1, o); o += 2; // class IN
    head.writeUInt32BE(120, o); o += 4; // ttl
    head.writeUInt16BE(rdata.length, o);
    return Buffer.concat([nameBuf, head, rdata]);
  }

  const ptrAnswer = record(svcName, 12, Buffer.concat([instPrefix, pointerToSvc, Buffer.from([0])]));

  const srvRdata = Buffer.alloc(6);
  srvRdata.writeUInt16BE(0, 0); // priority
  srvRdata.writeUInt16BE(0, 2); // weight
  srvRdata.writeUInt16BE(4173, 4); // port
  const targetName = encodeName('deskA1.local');
  const srvAnswer = record(instName, 33, Buffer.concat([srvRdata, targetName]));

  const aAnswer = record(encodeName('deskA1.local'), 1, Buffer.from([192, 168, 1, 42]));

  const txtRdata = Buffer.concat([Buffer.from([2]), Buffer.from('v=1', 'utf8').subarray(0, 2)]);
  const txtAnswer = record(instName, 16, txtRdata);

  const packet = Buffer.concat([header, ptrAnswer, srvAnswer, aAnswer, txtAnswer]);
  const records = decodeMessage(packet);

  const ptr = records.find((r) => r.type === 12);
  const srv = records.find((r) => r.type === 33);
  const a = records.find((r) => r.type === 1);

  assert.ok(ptr, 'PTR record decoded');
  assert.equal(ptr.ptr, 'inst._badgeconsole._tcp.local');
  assert.ok(srv, 'SRV record decoded');
  assert.equal(srv.port, 4173);
  assert.equal(srv.target, 'deskA1.local');
  assert.ok(a, 'A record decoded');
  assert.equal(a.address, '192.168.1.42');
});
