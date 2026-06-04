#pragma once

// Human-readable BLE device name shown by scanners.
static constexpr char BEACON_NAME[] = "PT-BEACON-01";

// Must match BLE_COMPANY_ID on the Pi scanner (default there is 65535 / 0xFFFF).
static constexpr uint16_t BLE_COMPANY_ID = 0xFFFF;

// UUID-like beacon token advertised as raw manufacturer-data bytes.
// Replace these bytes per physical beacon during provisioning.
static constexpr uint8_t BLE_BEACON_UUID[16] = {
  0x7F, 0x3C, 0x2D, 0x1A,
  0x9B, 0x4E,
  0x4C, 0x22,
  0xA8, 0xF0,
  0x25, 0x10, 0x11, 0x02, 0x00, 0x01,
};

// Payload format version: version 2 means company-id prefix + 128-bit beacon UUID.
static constexpr uint8_t BLE_PAYLOAD_FORMAT_VERSION = 2;

// BLE advertising interval (ms). 100-300ms is a good balance for detection + battery.
static constexpr uint16_t ADV_INTERVAL_MS = 250;

// Keep ADV non-connectable for lower overhead and fewer accidental connection attempts.
static constexpr bool USE_NON_CONNECTABLE_ADV = true;

// Include local name in advertising packet. Disable to keep packet small and improve detection reliability.
static constexpr bool INCLUDE_DEVICE_NAME_IN_ADV = false;

// Enable max BLE TX power for stronger signal/range.
static constexpr bool USE_MAX_TX_POWER = true;

// Periodic serial status log interval (ms). Set to 0 to disable serial heartbeat logs.
static constexpr uint32_t STATUS_LOG_PERIOD_MS = 15000;
