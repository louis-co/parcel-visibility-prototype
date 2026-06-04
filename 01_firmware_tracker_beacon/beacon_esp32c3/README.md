# XIAO ESP32-C3 BLE Beacon Firmware

This folder contains the BLE beacon firmware variants for the thesis prototype.
Both variants target the Seeed Studio XIAO ESP32-C3 and use the newer UUID v2
manufacturer-payload contract used by the Raspberry Pi BLE receiver.

## Variants

| Folder | Purpose | Publish intent |
| --- | --- | --- |
| `variants/single-beacon-uuid-v2/` | Normal field-style beacon firmware. One physical beacon advertises one stable UUID-like token. | Keep for ordinary prototype operation. |
| `variants/density-test-60-uuid-v2/` | Stress-test firmware. One physical beacon rotates through 60 UUID-like identities per minute. | Keep as technical test firmware for density/radio-coexistence evidence. |

## Payload Contract

Both variants use a 19-byte BLE manufacturer payload:

| Byte range | Meaning |
| --- | --- |
| `0..1` | BLE company ID, little endian |
| `2` | payload format version, currently `2` |
| `3..18` | 128-bit UUID-like beacon token |

The Raspberry Pi BLE scanner converts payload version `2` into backend-facing
beacon IDs shaped as `ble:<beaconUuid>`.

## Build

Each variant is self-contained and has its own `platformio.ini`.

```bash
cd variants/single-beacon-uuid-v2
pio run -e seeed_xiao_esp32c3
```

```bash
cd variants/density-test-60-uuid-v2
pio run -e seeed_xiao_esp32c3
```

## Binary Artifacts

`variants/density-test-60-uuid-v2/build-artifacts-candidates/` contains optional
compiled binaries copied from the local PlatformIO build. They are review
candidates only; a source-only public repository may remove them.

