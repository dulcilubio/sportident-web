# sportident-web

Talk to SPORTident stations from a web browser over Web Serial. This is a port
of [`sireader2.py`](https://github.com/per-magnusson/sportident-python) by Per
Magnusson, which itself extends `sireader.py` by Gaudenz Steinlin, Simon
Harston and Jan Vorwerk. Same licence: GPL-3.0-or-later.

No build step, no dependencies. Plain ES modules that run straight from a
`<script type="module">`.

```js
import { requestPort, SIReadout } from './src/index.js';

const port = await requestPort();            // must be called from a click
const station = await SIReadout.open(port);

station.addEventListener('card', (event) => {
  const { cardNumber, punches } = event.detail;
  console.log(cardNumber, punches.map((p) => `${p.code} at ${p.time.toLocaleTimeString()}`));
});
```

That is the whole loop. Put a card in, get a decoded card out. The station is
acknowledged so it beeps, and the next card is picked up automatically.

## What changed in the port

The Python library is built around blocking reads: it asks for a byte and waits
for the operating system to hand one over. A browser cannot work that way, and
neither can a page that has to stay responsive. So the shape of the library is
different even though the protocol handling is the same.

| Python | Here |
| --- | --- |
| `serial.read(n)` blocks until n bytes arrive | a read loop feeds bytes into `FrameParser`, which emits whole frames |
| `poll_sicard()` in a `while` loop with `sleep(1)` | `cardInserted` / `card` / `cardRemoved` events |
| card insert during a command raises `SIReaderCardChanged` | the event is delivered and the command carries on (`strictCardChanged: true` restores the old behaviour) |
| one command at a time, by convention | commands are queued, so concurrent callers cannot interleave on the wire |
| a timeout on the port | a timeout per command, with an automatic retry that sends a wakeup byte |
| `datetime`, `bytes` | `Date`, `Uint8Array` |
| serial port guessing by platform | the browser's port picker, filtered to the SPORTident USB identifiers |

Four bugs in the original are fixed, and the fixes are commented in place:

- **Punch codes above 255 on a card.** `_decode_carddata` passes the leftover
  check/clear day byte into `_decode_station_code` for every punch instead of
  that punch's own day byte, so the two high code bits come from the wrong
  place. `protocol.js` passes `ptd`.
- **Legacy backup weekday.** `((punch[BUL_PTD] & 0x0E)>>1 - 1) % 7` shifts by
  zero, because in Python `-` binds tighter than `>>`. Every weekday in a
  legacy backup readout comes out wrong.
- **Legacy backup card numbers.** The same function concatenates a `str` with
  `bytes`, which raises `TypeError` on Python 3 the moment you read a legacy
  station.
- **`poll_punch` in control mode.** The `while ... else` never runs, and the
  punch is appended even for frames that are not punch records.

One behavioural difference worth knowing about: `set_station_code` in Python
writes `0b00111111` into the low bits of the feedback byte as a side effect,
which switches the beeper and lamp on whatever they were set to before.
`setStationCode` keeps the existing settings; pass `{ preserveFeedback: false }`
if you want the old behaviour.

## Install

Copy `src/` into your project, or install from npm and import from
`sportident-web`. Both APIs need a secure context, so serve over https or
localhost.

## Platforms

There are two ways to reach a station and no single one covers everything, so
`requestStation()` tries Web Serial first and falls back to WebUSB:

```js
import { requestStation, SIReadout } from 'sportident-web';

const source = await requestStation();       // needs a click
const station = await SIReadout.open(source);
```

| Platform | Reached by | Needs |
| --- | --- | --- |
| Windows | Web Serial | [SPORTident USB driver](https://www.sportident.com/products/usb-driver) |
| Linux | Web Serial | in-kernel `cp210x`, and your user in the `dialout` group |
| macOS | WebUSB | nothing, see below |
| macOS | Web Serial | Silicon Labs CP210x VCP driver, if you would rather use it |
| Android | WebUSB | an OTG cable |
| iOS | neither | not possible in any browser |

The rule underneath the table is not really which browser you are in, it is
whether a kernel driver has claimed the device. If one has, it owns the
endpoints and WebUSB cannot touch them, so Web Serial is the only way in. If
none has, the station never appears as a serial port and WebUSB is the only way
in.

macOS is the interesting case. It ships a Silicon Labs driver, but that driver
binds only to the stock product ids `0xEA60` and `0xEA70`, and SPORTident
flashes its bridges as `0x800A`. Nothing claims the device, no `/dev/cu.*`
appears, and the Web Serial picker comes up empty -- which is exactly the
condition WebUSB needs. So on macOS this works with no driver installed at all.

Firefox and Safari implement neither API. On iOS every browser is Safari
underneath, so there is no way round it there.

One thing to know about WebUSB: claiming a device is exclusive. While a tab has
the station open, nothing else on the machine can talk to it, and the tab has
to disconnect before another program can.

## The configuration tool

`config/` is a working tool, not a toy: station identity and settings, every
operating mode including the Air+ beacon and SIAC special ones, control code,
punch feedback, awake time, card readouts with splits, backup memory export,
relaying to a station on the coupling stick, and a byte-level trace of the
serial line. Serve the repository root and open `/config/`:

```
npm run serve        # python3 -m http.server 8080
```

It keeps working when the network does not. Nothing about talking to a station
needs the internet, so the page loads no fonts or scripts from anywhere else
and a service worker caches everything it is built from: once opened, it opens
again with no connection at all. The one networked feature, the SIAC battery
lookup, is skipped and says so.

A reload does not cost you the station either. The open device is thrown away
with the page, but the browser keeps the permission, so the tool reopens a
single granted station by itself.

The "Simulator" button swaps the serial port for `SimulatedTransport`, a fake
BSM8 that answers the same frames, hands out card dumps and can send autosend
punches. It is also what the test suite runs against, so it stays honest.

## API

Everything is exported from the package root. `src/index.d.ts` types all 109
exports, so an editor will complete them.

| | |
| --- | --- |
| **Connect** | `requestStation` · `getGrantedStations` · `transportSupport` · `toTransport` |
| **Transports** | `WebSerialTransport` · `WebUsbTransport` · `SimulatedTransport` |
| **Stations** | `SIStation` · `SIReadout` · `SIControl` |
| **Identity** | `readInfo` · `refreshSysval` · `getTime` · `setTime` · `getClockOffset` |
| **Modes** | `setOperatingMode` · `setSiacFunction` · `setModeByte` · `mode` · `modeName` · `siacFunction` |
| **Settings** | `setStationCode` · `setFeedback` · `setActiveTime` · `setExtendedProtocol` · `setAutoSend` |
| **Remote** | `setTarget` · `withRemote` · `wake` · `powerOffRemote` |
| **Cards** | `detectCard` · `readCard` · `readCardRaw` · `readCardImage` · `ackCard` · `waitForCard` |
| **Card decoding** | `decodeCardData` · `decodeCardHolder` · `decodeCardHardware` · `decodeCardText` |
| **Backup** | `readBackup` · `eraseBackup` · `backupToCsv` · `sysvalToCsv` |
| **SIAC battery** | `fetchSiacBattery` · `isSiacNumber` · `describeBattery` |
| **Errors** | `SIError` · `SITimeoutError` · `SIProtocolError` · `SINakError` · `SIConnectionError` · `SICardChangedError` · `SIBatteryLookupError` |

Events on a station: `card` · `cardInserted` · `cardRemoved` · `cardError` ·
`punch` · `waking` · `wake` · `open` · `close` · `error` · `nak` · `frame` ·
`unexpectedFrame` · `tx` · `rx`.

### Connecting

```js
import {
  requestStation, getGrantedStations, transportSupport,
  SIReadout, SIControl, SIStation,
} from 'sportident-web';

const source = await requestStation();          // Web Serial, else WebUSB
const any = await requestStation({ anyPort: true });   // drop the id filter
const usb = await requestStation({ prefer: 'usb' });   // force one API
const remembered = await getGrantedStations();  // no click needed on a revisit

const station = await SIReadout.open(source, { debug: true });
```

`open()` takes a Web Serial port, a WebUSB device or a transport, so the same
call works everywhere. It opens at 38400 baud, falls back to 4800 if nothing
answers, sends the direct-mode handshake and reads the station configuration.

`transportSupport()` reports `{ webSerial, webUsb, any }` if you would rather
show the right button than catch a failure. The single-API entry points are
still there: `requestPort()`/`getGrantedPorts()` for Web Serial and
`requestUsbDevice()`/`getGrantedUsbDevices()` for WebUSB.

Options: `debug`, `wakeup` (send 0xFF before commands, default true), `timeout`
(ms, default 2000), `retries` (default 1), `strictCardChanged`, and for
`SIReadout` also `autoRead` and `autoAck` (both default true).

### Reading cards — `SIReadout`

| Event | Detail |
| --- | --- |
| `cardInserted` | `{ cardNumber, cardType }` |
| `card` | the decoded card, see below |
| `cardRemoved` | – |
| `cardError` | `{ error, cardNumber }` |

```js
const card = await station.readCard();   // if you would rather drive it yourself
await station.ackCard();                 // beep

await station.waitForCard({ timeout: 30000 });
```

A decoded card:

```js
{
  cardNumber: 8100999,
  cardType: 'SI10',
  start: Date | null,   startCode: 1,
  finish: Date | null,  finishCode: 2,
  check: Date | null,   checkCode: null,
  clear: Date | null,   clearCode: null,
  punchCount: 6,
  punches: [{ code: 31, time: Date }, ...],
  raw: Uint8Array,
}
```

SI-Card 5, 6, 8, 9, 10, 11, pCard, tCard and SIAC are handled, each with the
read sequence that works for it: one command for SI-Card 5, three frames for
SI-Card 6, block by block for 8/9/pCard, and all blocks at once for the 10
family because reading those block by block is slow and unreliable.

### A card that is already in the station

Stations announce a card when it goes in, and say nothing afterwards. Connect to
a station that already holds a card and it looks broken: right mode, card in,
nothing happens. `SIReadout` therefore probes for one when it connects, and the
card arrives as a normal `card` event:

```js
const station = await SIReadout.open(source);   // finds a card already in
station.addEventListener('card', (e) => console.log(e.detail.cardNumber));
```

Ask at any time with `detectCard()`, which resolves to `null` when the slot is
empty rather than throwing. Pass `detectOnConnect: false` to skip the probe.

### Reading cards or streaming punches, not both

The protocol byte ties handshake and auto-send together as opposites, so a
station does one or the other:

| | handshake | auto-send | what you get |
| --- | --- | --- | --- |
| `setAutoSend(false)` | on | off | cards read on insertion |
| `setAutoSend(true)` | off | on | punches sent as they happen |

A station in readout mode with neither bit set stays silent when a card goes
in, which is the usual cause of "readout mode does not read out".

### Controls in autosend mode — `SIControl`

```js
const control = new SIControl(new WebSerialTransport(port));
await control.connect();
control.assertAutosendMode();
control.addEventListener('punch', (e) => {
  const { cardNumber, time, recovered } = e.detail;
});
```

Every autosend record carries its address in the station's backup memory. If a
punch is lost on the wire the address jumps, and this class reads the missing
records back out of memory and emits them in order with `recovered: true`.

### Operating mode

```js
await station.setOperatingMode('start');   // by name
await station.setOperatingMode(MODE.START); // or by constant
await station.setCheckMode();               // or by shorthand

station.mode;      // 3
station.modeName;  // 'Start'
```

The settable modes are `control`, `start`, `finish`, `readout`, `clear` and
`check`, plus the Air+ beacon modes `beacon-control`, `beacon-start`,
`beacon-finish` and `beacon-readout`. Anything else is refused before a byte
goes down the wire.

Beacon modes come in two encodings. Older Air+ stations take `0x12` to `0x15`;
newer ones (BSF9 and later, and some BSF8s) want the same modes `0x20` higher
and answer the old form with a NAK. There is no capability bit to read, so
`setOperatingMode()` tries the old form and falls back to the new one, and
returns whichever byte the station accepted:

```js
const accepted = await station.setOperatingMode('beacon-control');
// 0x12 on an older station, 0x32 on a newer one
```

Both encodings decode to the same name, so `modeName` reads `BC control`
either way. `sireader2.py` documents only the older set, which is why a station
in this mode shows up there as an unknown byte.

A beacon station keeps taking contact punches as well: Air+ is added to classic
punching, not swapped for it. Note that in Air+ mode a contactless punch does
not restart the station's awake time -- only a direct punch does -- so set it
long enough to cover the whole event.

#### SIAC special functions

SPORTident stations can be set to one of five SIAC functions, and a station in
one of these does nothing else.

```js
await station.setSiacFunction('off');
station.modeName;       // 'SIAC OFF'
station.siacFunction;   // 'SIAC OFF'
```

| Function | Mode | Code |
| --- | --- | --- |
| SIAC battery test | `0x01` | 123 |
| SIAC ON | `0x01` | 124 |
| SIAC OFF | `0x01` | 125 |
| SIAC radio readout | `0x01` | 127 |
| SIAC test | `0x11` | 124 |

A function is identified by **both** bytes, not either alone: code 124 means
SIAC ON at mode `0x01` and SIAC test at `0x11`. Matching on the code by itself
silently confuses the two. That pairing is also why Config+ will not let you
edit the code in these modes -- it owns that field -- and why setting the mode
byte alone is worth avoiding: the station lands in the SIAC family with
whatever code it already had, quite likely the wrong function.
`setSiacFunction()` writes the code first and the mode second, so a
half-finished change leaves a harmless station rather than one doing the wrong
job.

These numbers were read off five BSF8s (firmware 656) set with Config+, the
surprising one twice. SPORTident document the functions but publish none of the
values, and `sireader2.py` has only mode `0x01` with the comment "SIAC special
(ON, OFF, Radio_ReadOut, etc.)".

Two loose ends, recorded rather than guessed at:

- Code 126 at mode `0x01` is unused by any station seen here. One found sitting
  there reports as `SIAC special (mode 0x1, code 126)` rather than being given
  an invented meaning.
- The SIAC test station also carried `PROGRAM` `0x30` where the other four had
  `0x38`. Whether that bit matters to how the station behaves is unknown, so
  nothing here writes it -- worth checking against a real SIAC if you rely on
  this function.

#### Modes nobody has published

SPORTident documents four SIAC special modes -- SIAC ON, SIAC OFF, Radio
Readout and Battery Test -- and says the code number does not apply to them, so
each has to be its own mode byte. The values are not published anywhere, and
`sireader2.py` has only `0x01`, vaguely, as "SIAC special (ON, OFF,
Radio_ReadOut, etc.)".

`setModeByte()` writes the mode byte unchecked for exactly this case:

```js
await station.setModeByte(0x01);
station.modeName;              // 'SIAC special'
```

The way to find a value is to set a station to the mode in Config+ and read the
byte back -- `readInfo().mode`, or the mode byte shown in the tool's facts
panel. That is how the two beacon encodings were pinned down.

### Direct and remote

A cabled station can relay to a second one standing on its coupling stick, which
is how Config+ configures a station without plugging it in. `direct` means the
station on the cable, `remote` means the one on top.

```js
const info = await station.withRemote(() => station.readInfo());
```

`withRemote()` is the safe way to do it: it switches, runs your function and
returns to direct whatever happens.

A station on the stick is almost always asleep, and rousing it takes far longer
than seems reasonable. Measured on a BSF8 coming out of a real sleep:

```
  t=  0.7s  attempt   1  NAK
  t=  7.2s  attempt  10  NAK
  t= 15.3s  attempt  21  NAK
  t= 22.8s  attempt  31  ANSWER
```

Thirty-one attempts over 22.8 seconds of continuous traffic before it answered
at all. `WAKE_TIMEOUT` is therefore 30 seconds, and `withRemote()` spends up to
that waking the station before running your function, throwing `SITimeoutError`
if it never answers rather than failing obscurely later:

```js
await station.withRemote(fn, { wake: 60000 });   // a longer budget
await station.withRemote(fn, { wake: false });   // skip it
```

Half a minute is a long time to show nothing, so a `waking` event is dispatched
on every attempt with `{ attempts, elapsed, timeout }`, and a `wake` event when
it finally answers:

```js
station.addEventListener('waking', (e) => {
  const { elapsed, timeout } = e.detail;
  progress.value = elapsed / timeout;
});
```

`wake()` is available on its own, and nothing about it blocks: each attempt is
awaited and the gaps are timers, so the page stays responsive and card events
keep arriving while it runs. Pass an `AbortSignal` to stop early.

```js
await station.setRemote();
if (await station.wake({ timeout: 5000, signal })) {
  const info = await station.readInfo();
}
``` That matters, because while remote is
selected *every* command goes to the station on top, including `powerOff()` and
`eraseBackup()`. If the switch back fails it is raised and also dispatched as an
`error` event rather than quietly ignored.

The lower-level calls are there if you want them:

```js
await station.setTarget('remote');   // or setRemote()
station.target;                       // 'remote'
await station.setTarget('direct');   // or setDirect()
```

The cabled station has to be in extended protocol mode to relay at all;
`setRemote()` throws if it is not. Switching target clears the cached system
data, since it described the other station.

### Subsecond times

The start, finish, check and clear slots usually carry a station code beside
the time, but not always: when bit 7 of the day byte is set that byte holds a
subsecond count in 1/256 of a second instead, and the record has no code. The
code then comes back as `null` and the `Date` carries the fraction.

```js
card.finishCode;               // null on a record that stores a subsecond
card.finish.getMilliseconds(); // 578
```

Read off two cards: a SIAC finish with day byte `0x8d` and `0x94` beside it,
which Config+ reports as an empty code at 20:47:46.578, and an SI-Card 8 finish
with day byte `0x0c` and `0x0d` beside it, which is station code 13. Treating
that byte as a code either way is what produced impossible codes such as 660.

Punch records are not read this way: there the top bits of the day byte really
are the top bits of the code, which is how codes above 255 are stored.

### SIAC battery dates

A SIAC runs on a battery that cannot be replaced by the user and lasts a few
years, and the card does not carry its own battery date. SPORTident publish a
lookup, which this wraps:

```js
import { fetchSiacBattery, isSiacNumber } from 'sportident-web';

if (isSiacNumber(card.cardNumber)) {
  const battery = await fetchSiacBattery(card.cardNumber);
  // { batteryDate, replaceBefore, status, daysRemaining, raw }
}
```

`status` is `ok`, `due` (within 90 days), `overdue`, or `unknown`. A card
SPORTident have no record of resolves to `null` rather than throwing. Only SIAC
numbers (8000001 to 8999999) have a battery to ask about; anything else is
refused before a request goes out.

This is the one part of the library that needs the network, and it is entirely
optional -- nothing else calls it. Two things to plan for:

- **The CORS allowlist is narrow.** At the time of writing the API answers
  browsers on `http://localhost:8080` and not much else: `localhost:3000`,
  `127.0.0.1:8080` and a `github.io` origin were all refused. From another
  origin the request fails with an opaque CORS error that looks exactly like
  being offline. Ask SPORTident to allowlist your origin, pass `baseUrl` to
  point at your own proxy, or call it from a server. Node has no CORS and just
  works.
- **Failures are normal.** A laptop at a finish tent often has no signal, so
  every failure arrives as `SIBatteryLookupError` for you to ignore. Never let
  it hold up showing a card that read perfectly well.

SPORTident ask for a client id, which `support@sportident.com` issues:

```js
await fetchSiacBattery(8549150, { clientId: 'your-id' });
```

### Backup memory

```js
await station.setRemote();            // or setDirect() for the cabled station
const punches = await station.readBackup({
  onProgress: (done, total) => console.log(done / total),
});
// [{ time: Date, cardNumber: 1234567, error: '' }, ...]

import { backupToCsv, backupFilename, downloadText } from 'sportident-web';
const info = await station.readInfo();
downloadText(
  backupFilename(info.code, info.modeName, info.serialNumber),
  backupToCsv(punches, { code: info.code, mode: info.modeName })
);
```

The CSV has the same columns and separator as the one SPORTident Config+
writes, so anything that already reads those files reads these. Both the
extended and the legacy record formats are decoded. Legacy records only store a
weekday, so the date is filled in on the assumption the punch happened within
the last seven days.

### Configuration

`readInfo()` returns everything the `sysval_*` functions in Python return, in
one object:

```js
{
  serialNumber, firmware, modelId, modelName, buildDate, batteryDate,
  memorySizeKb, voltage, batteryCapacityMah, batteryUsedPercent, memoryOverflow,
  code, mode, modeName, activeTimeMinutes, activeTime,
  protocolByte, extendedProtocol, autoSend,
  feedbackByte, opticalFeedback, audibleFeedback, si6With192Punches,
}
```

Writing:

```js
await station.setOperatingMode(MODE.CONTROL);
await station.setStationCode(131);
await station.setFeedback({ audible: true, optical: true });
await station.setActiveTime(4 * 60);
await station.setSi6With192Punches(false);
await station.setExtendedProtocol(true);
await station.setAutoSend(false);
await station.setTime(new Date());
await station.setBaudRateHigh();      // or setBaudRateLow(), the port follows
await station.eraseBackup();
await station.beep(2);
await station.powerOff();
await station.powerOffRemote();       // the odd byte sequence Config+ uses
```

Preparing a batch of stations, the equivalent of `si_normalize_station.py`:

```js
await station.setDirect();
await station.setBaudRateHigh();
await station.setRemote();            // now talking to the station on top

for (;;) {
  const before = await station.readInfo();
  const offset = await station.getClockOffset();
  log.push(stationLogRow(before, offset));

  await station.setTime(new Date());
  await station.eraseBackup();
  await station.setFeedback({ audible: true, optical: true });
  await station.setActiveTime(4 * 60);
  await station.setSi6With192Punches(before.modeName === 'Clear');
  if (before.modeName === 'Readout') await station.setAutoSend(false);

  log.push(stationLogRow(await station.readInfo(), await station.getClockOffset()));
  await station.powerOff();
}
```

### Lower level

```js
import { CMD, O } from 'sportident-web';

const data = await station.sendCommand(CMD.GET_SYS_VAL, [0x00, 0x80]);
const frames = await station.sendCommandFrames(CMD.GET_SI9, [0x08], { frames: 5 });
await station.sendRaw(bytes);
```

Diagnostic events on every station object: `tx`, `rx`, `frame`,
`unexpectedFrame`, `garbage`, `nak`, `error`, `open`, `close`.

The decoding functions are exported on their own and have no browser
dependencies, so you can run them over captured data in Node:
`decodeCardData`, `decodeCardNumber`, `decodeTime`, `decodeStationCode`,
`decodeBackupExtended`, `decodeBackupLegacy`, `extractSysval`, `crc16`,
`buildCommand`, `FrameParser`.

## TypeScript

`src/index.d.ts` ships with the package and `package.json` points at it, so
editors and TypeScript projects get completion and checking with no extra
install. The declarations are self-contained: the port argument is typed as a
structural `SISerialPort`, which a real `SerialPort` satisfies whether or not
you have `@types/w3c-web-serial`.

```ts
import { SIReadout, type SICardData } from 'sportident-web';

const station = await SIReadout.open(port, { autoAck: false });
station.addEventListener('card', (event) => {
  const card = (event as CustomEvent<SICardData>).detail;
});
```

## Tests

```
npm test
```

The CRC vectors in `test/crc-vectors.json` were generated by running the
original Python implementation, so a green run means this port computes exactly
the same checksums. The rest of the suite covers frame reassembly across
arbitrary chunk boundaries, resynchronisation after noise and bad checksums,
card number and time decoding, the CSV layout, and three end-to-end runs
against the simulator: a card readout, a backup memory dump and autosend
punches with a recovered gap.

## What is not settled

Much of what this library knows about cards and stations was worked out by
reading real hardware and matching it against Config+, because SPORTident do
not publish it. That leaves things that are verified, and things that are not.
The difference matters, so it is written down rather than left to be
discovered at an event.

Verified against hardware here: the SI-Card 8 and SIAC layouts, all five SIAC
special functions, both beacon encodings, the holder text area, card hardware
and battery dates, the subsecond rule, control codes including above 255,
punch feedback, and reading a station over WebUSB with no driver.

Not verified, and worth treating with care:

- **SI-Card 5, 6 and 9 layouts** have never been read here. SI-Card 9 is
  documented by SPORTident as 12 hour format where 8, 10, 11 and SIAC use 24
  hour with a weekday, but the table in `constants.js` gives it a day byte like
  the others. If you have one, read it and check.
- **The subsecond rule** comes from two cards: a SIAC finish with the flag set
  and an SI-Card 8 finish without it. It has not been seen on start, check or
  clear records.
- **A SIAC test station** carries `PROGRAM` 0x30 where the other four SIAC
  functions carry 0x38. That bit is undocumented and nothing here writes it, so
  a station configured through this library may differ from a Config+ one in
  that byte. Check against a real SIAC before relying on it.
- **Mode 0x01 with control code 126** is a gap between SIAC OFF and radio
  readout. Nothing seen here sits there.
- **Card battery voltage, clear count, character set and feedback signal** are
  in the card image, and Config+ reports them, but their offsets have not been
  found.
- **The clear time on SI-Card 8 and later** is reported by Config+ but this
  library returns null, since the layout table has no offset for it.
- **`config/app.js` has no tests.** The library is covered thoroughly; the tool
  built on it is not, and two functions once shipped a `ReferenceError` because
  of that.

## Known limits

- BS11 stations (SIAC / Air+) are not supported, the same as in the Python
  library.
- Reading and writing SI-Card contents (`C_SI5_WRITE`, `C_SI9_WRITE`,
  `C_CLEAR_CARD`) is not implemented; the constants are there.
- The ShortRangeRadio commands are defined but unused.
- Web Serial cannot change the line speed on an open port, so
  `setBaudRateLow()` and `setBaudRateHigh()` close and reopen it. The port
  drops for a few hundred milliseconds.
- Times are local-time `Date` objects with no time zone attached, matching the
  naive `datetime` values the Python library returns. Card times carry no date,
  only a half-day offset and sometimes a weekday, so they are always resolved
  relative to a reference time you can pass in.

## Licence

GPL-3.0-or-later, inherited from the Python original. This is a derivative
work of [`sireader2.py`](https://github.com/per-magnusson/sportident-python),
so it cannot be relicensed under anything more permissive.

Copyright on the protocol work that this port is based on stays with the
original authors — Gaudenz Steinlin, Simon Harston, Jan Vorwerk and Per
Magnusson. The full notice is in [NOTICE](NOTICE); the licence text is in
[LICENSE](LICENSE).

What that means if you use this: you may run, study, modify and redistribute
it, including commercially. If you distribute it, or a modified version, you
have to pass on the same freedoms — ship the source, keep it under GPL-3.0,
keep the copyright notices, and state your changes. Using it inside a service
you host is not distribution and triggers none of that.
