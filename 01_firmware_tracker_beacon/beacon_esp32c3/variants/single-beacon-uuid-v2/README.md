# Single-Beacon UUID v2 Firmware

Normal BLE beacon firmware for one physical Seeed XIAO ESP32-C3 beacon.

## Purpose

Use this firmware when one beacon should advertise one stable UUID-like token.
The Raspberry Pi BLE receiver interprets the token as `ble:<beaconUuid>` and
forwards it as a `ble_scan` raw event.

## Payload Contract

The manufacturer payload is 19 bytes:

| Byte range | Meaning |
| --- | --- |
| `0..1` | BLE company ID, little endian |
| `2` | payload format version, currently `2` |
| `3..18` | 128-bit UUID-like beacon token |

## Files

- `firmware/xiao_ble_beacon/xiao_ble_beacon.ino` - Arduino/PlatformIO runtime.
- `firmware/xiao_ble_beacon/beacon_config.h` - active beacon identity and radio config.
- `firmware/xiao_ble_beacon/beacon_config.example.h` - provisioning template.
- `platformio.ini` - Seeed XIAO ESP32-C3 PlatformIO environment.

## Flash

```bash
pio run -e seeed_xiao_esp32c3 -t upload
```

