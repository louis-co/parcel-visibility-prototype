#include <Arduino.h>
#include <BLEAdvertising.h>
#include <BLEDevice.h>
#include <BLEUtils.h>

#include "beacon_config.h"

namespace {

struct DensitySlot {
  uint32_t offset_ms;
  uint8_t id_suffix;
};

// Fixed pseudo-random schedule across one 60 s cycle. Offsets are sorted so the
// same UUID repeats once per minute while inter-ping spacing remains irregular.
static constexpr DensitySlot DENSITY_SCHEDULE[DENSITY_BEACON_COUNT] = {
  {  210, 0x01}, {  740, 0x02}, { 1560, 0x03}, { 2190, 0x04}, { 3010, 0x05},
  { 3830, 0x06}, { 4620, 0x07}, { 5340, 0x08}, { 6210, 0x09}, { 6880, 0x0A},
  { 7770, 0x0B}, { 8410, 0x0C}, { 9440, 0x0D}, {10170, 0x0E}, {10980, 0x0F},
  {11890, 0x10}, {12640, 0x11}, {13710, 0x12}, {14330, 0x13}, {15260, 0x14},
  {16120, 0x15}, {16970, 0x16}, {17740, 0x17}, {18880, 0x18}, {19520, 0x19},
  {20460, 0x1A}, {21390, 0x1B}, {22110, 0x1C}, {23270, 0x1D}, {24020, 0x1E},
  {24980, 0x1F}, {25830, 0x20}, {26790, 0x21}, {27630, 0x22}, {28550, 0x23},
  {29480, 0x24}, {30420, 0x25}, {31290, 0x26}, {32340, 0x27}, {33180, 0x28},
  {34110, 0x29}, {35160, 0x2A}, {36070, 0x2B}, {37190, 0x2C}, {38010, 0x2D},
  {38960, 0x2E}, {39990, 0x2F}, {40920, 0x30}, {41880, 0x31}, {42950, 0x32},
  {43830, 0x33}, {44970, 0x34}, {45840, 0x35}, {47010, 0x36}, {47920, 0x37},
  {48980, 0x38}, {50160, 0x39}, {51640, 0x3A}, {53780, 0x3B}, {57420, 0x3C},
};

uint16_t clamp_adv_interval_units(uint16_t interval_ms) {
  // BLE advertising interval unit is 0.625 ms.
  uint32_t units = (static_cast<uint32_t>(interval_ms) * 1000UL) / 625UL;
  if (units < 0x20) {
    units = 0x20;
  }
  if (units > 0x4000) {
    units = 0x4000;
  }
  return static_cast<uint16_t>(units);
}

std::string build_manufacturer_data(uint8_t id_suffix) {
  // Layout:
  // [0..1]   company id LE
  // [2]      payload format version
  // [3..18]  UUID-like beacon token bytes
  uint8_t payload[19];
  payload[0] = static_cast<uint8_t>(BLE_COMPANY_ID & 0xFF);
  payload[1] = static_cast<uint8_t>((BLE_COMPANY_ID >> 8) & 0xFF);
  payload[2] = BLE_PAYLOAD_FORMAT_VERSION;

  for (size_t i = 0; i < sizeof(BLE_BEACON_UUID_BASE); ++i) {
    payload[3 + i] = BLE_BEACON_UUID_BASE[i];
  }
  payload[18] = id_suffix;

  return std::string(reinterpret_cast<char*>(payload), sizeof(payload));
}

BLEAdvertising* configure_ble() {
  BLEDevice::init(BEACON_NAME);
  if (USE_LOW_TX_POWER) {
    BLEDevice::setPower(ESP_PWR_LVL_N12);
  }

  BLEAdvertising* advertising = BLEDevice::getAdvertising();
  if (USE_NON_CONNECTABLE_ADV) {
#if defined(ADV_TYPE_NONCONN_IND)
    advertising->setAdvertisementType(ADV_TYPE_NONCONN_IND);
#endif
  }

  const uint16_t min_units = clamp_adv_interval_units(ADV_INTERVAL_MS);
  const uint16_t max_units = static_cast<uint16_t>(min<uint32_t>(0x4000, min_units + 0x10));
  advertising->setScanResponse(false);
  advertising->setMinInterval(min_units);
  advertising->setMaxInterval(max_units);
  return advertising;
}

void advertise_slot(BLEAdvertising* advertising, uint8_t id_suffix) {
  BLEAdvertisementData adv_data;
  adv_data.setFlags(0x06);  // LE General Discoverable + BR/EDR not supported
  if (INCLUDE_DEVICE_NAME_IN_ADV) {
    adv_data.setName(BEACON_NAME);
  }
  adv_data.setManufacturerData(build_manufacturer_data(id_suffix));
  advertising->setAdvertisementData(adv_data);
  advertising->start();
  delay(DENSITY_ADV_WINDOW_MS);
  advertising->stop();
}

}  // namespace

void setup() {
  BLEAdvertising* advertising = configure_ble();
  uint32_t cycle_start_ms = millis();

  while (true) {
    for (const auto& slot : DENSITY_SCHEDULE) {
      const uint32_t now_ms = millis();
      const uint32_t elapsed_ms = now_ms - cycle_start_ms;
      if (slot.offset_ms > elapsed_ms) {
        delay(slot.offset_ms - elapsed_ms);
      }
      advertise_slot(advertising, slot.id_suffix);
    }

    const uint32_t elapsed_ms = millis() - cycle_start_ms;
    if (elapsed_ms < DENSITY_CYCLE_MS) {
      delay(DENSITY_CYCLE_MS - elapsed_ms);
    }
    cycle_start_ms += DENSITY_CYCLE_MS;
  }
}

void loop() {
  // The density schedule runs inside setup.
}
