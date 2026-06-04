#include <Arduino.h>
#include <BLEAdvertising.h>
#include <BLEDevice.h>
#include <BLEUtils.h>

#include "beacon_config.h"

namespace {
BLEAdvertising* g_advertising = nullptr;
unsigned long g_last_status_log_ms = 0;

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

std::string build_manufacturer_data() {
  // Layout:
  // [0..1]   company id LE
  // [2]      payload format version
  // [3..18]  UUID-like beacon token bytes
  uint8_t payload[19];
  payload[0] = static_cast<uint8_t>(BLE_COMPANY_ID & 0xFF);
  payload[1] = static_cast<uint8_t>((BLE_COMPANY_ID >> 8) & 0xFF);
  payload[2] = BLE_PAYLOAD_FORMAT_VERSION;

  for (size_t i = 0; i < sizeof(BLE_BEACON_UUID); ++i) {
    payload[3 + i] = BLE_BEACON_UUID[i];
  }

  return std::string(reinterpret_cast<char*>(payload), sizeof(payload));
}

void start_advertising() {
  BLEAdvertisementData adv_data;
  adv_data.setFlags(0x06);  // LE General Discoverable + BR/EDR not supported
  if (INCLUDE_DEVICE_NAME_IN_ADV) {
    adv_data.setName(BEACON_NAME);
  }
  adv_data.setManufacturerData(build_manufacturer_data());

  g_advertising->setAdvertisementData(adv_data);
  g_advertising->start();
}
}  // namespace

void setup() {
  Serial.begin(115200);
  delay(200);

  BLEDevice::init(BEACON_NAME);
  if (USE_MAX_TX_POWER) {
#if defined(ESP_PWR_LVL_P9)
    BLEDevice::setPower(ESP_PWR_LVL_P9);
#endif
  }

  g_advertising = BLEDevice::getAdvertising();
  if (USE_NON_CONNECTABLE_ADV) {
#if defined(ADV_TYPE_NONCONN_IND)
    g_advertising->setAdvertisementType(ADV_TYPE_NONCONN_IND);
#endif
  }

  const uint16_t min_units = clamp_adv_interval_units(ADV_INTERVAL_MS);
  const uint16_t max_units = static_cast<uint16_t>(min<uint32_t>(0x4000, min_units + 0x10));

  g_advertising->setScanResponse(false);
  g_advertising->setMinInterval(min_units);
  g_advertising->setMaxInterval(max_units);

  start_advertising();
  g_last_status_log_ms = millis();

  Serial.println("XIAO ESP32-C3 Parcel Tracker BLE beacon started.");
  Serial.print("Beacon name: ");
  Serial.println(BEACON_NAME);
  Serial.print("Company ID: 0x");
  Serial.println(BLE_COMPANY_ID, HEX);
  Serial.print("Payload format version: ");
  Serial.println(BLE_PAYLOAD_FORMAT_VERSION);
  Serial.print("Include name in ADV: ");
  Serial.println(INCLUDE_DEVICE_NAME_IN_ADV ? "yes" : "no");
  Serial.print("Non-connectable ADV: ");
  Serial.println(USE_NON_CONNECTABLE_ADV ? "yes" : "no");
}

void loop() {
  const unsigned long now = millis();
  if (STATUS_LOG_PERIOD_MS > 0 && (now - g_last_status_log_ms >= STATUS_LOG_PERIOD_MS)) {
    g_last_status_log_ms = now;
    Serial.print("BLE beacon alive, uptime_ms=");
    Serial.println(now);
  }

  delay(50);
}
