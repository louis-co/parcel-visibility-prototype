# Density-Test 60-UUID v2 Firmware

BLE stress-test firmware for the Seeed XIAO ESP32-C3.

## Purpose

Use this firmware to simulate many distinct BLE identifiers with one physical
beacon. It was staged for the thesis density/radio-coexistence tests where the
backend and tracker had to preserve many unique BLE identities while RFID,
GNSS, LTE upload, and heartbeat traffic were also active.

## Behavior

- Rotates through 60 UUID-like beacon identities.
- Each identity is emitted once per 60-second cycle.
- The last UUID byte is replaced with values `0x01..0x3C`.
- Uses payload format version `2`, matching the UUID v2 parser path.
- Optimized for test evidence, not battery life.

## Files

- `firmware/xiao_ble_beacon/xiao_ble_beacon.ino` - density scheduler and advertising runtime.
- `firmware/xiao_ble_beacon/beacon_config.h` - active density-test config.
- `platformio.ini` - Seeed XIAO ESP32-C3 PlatformIO environment.

## Flash

```bash
pio run -e seeed_xiao_esp32c3 -t upload
```

