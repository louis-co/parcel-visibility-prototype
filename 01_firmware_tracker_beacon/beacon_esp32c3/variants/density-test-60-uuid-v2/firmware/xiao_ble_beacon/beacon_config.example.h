#pragma once

// Human-readable BLE device name. It is not included in the advertising packet.
static constexpr char BEACON_NAME[] = "PT-BEACON-01";

// Must match BLE_COMPANY_ID on the Pi scanner.
static constexpr uint16_t BLE_COMPANY_ID = 0xFFFF;

// Base UUID-like beacon token advertised as raw manufacturer-data bytes.
// The density-test firmware derives 60 distinct IDs by replacing the last byte
// with values 0x01..0x3C.
// First string form: 7f3c2d1a-9b4e-4c22-a8f0-251011020001
static constexpr uint8_t BLE_BEACON_UUID_BASE[16] = {
  0x7F, 0x3C, 0x2D, 0x1A,
  0x9B, 0x4E,
  0x4C, 0x22,
  0xA8, 0xF0,
  0x25, 0x10, 0x11, 0x02, 0x00, 0x01,
};

// Payload format version: version 2 means company-id prefix + 128-bit beacon UUID.
static constexpr uint8_t BLE_PAYLOAD_FORMAT_VERSION = 2;

// Density-test profile: rotate through 60 simulated beacon UUIDs every minute.
// Each UUID is advertised once per 60-second cycle at a fixed pseudo-random
// offset. Power consumption is intentionally not optimized for this profile.
static constexpr uint16_t ADV_INTERVAL_MS = 80;
static constexpr uint32_t DENSITY_ADV_WINDOW_MS = 450;
static constexpr uint32_t DENSITY_CYCLE_MS = 60000;
static constexpr uint8_t DENSITY_BEACON_COUNT = 60;

// Keep ADV non-connectable for lower overhead and fewer accidental connection attempts.
static constexpr bool USE_NON_CONNECTABLE_ADV = true;

// Keep packet small: flags + manufacturer data only.
static constexpr bool INCLUDE_DEVICE_NAME_IN_ADV = false;

// Use normal power for the density test; it is powered from a power bank.
static constexpr bool USE_LOW_TX_POWER = false;
