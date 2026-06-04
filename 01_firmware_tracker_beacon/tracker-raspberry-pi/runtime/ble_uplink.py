#!/usr/bin/env python3
"""BLE scanner that forwards normalized raw events to Convex /ingest."""

from __future__ import annotations

import asyncio
import json
import os
import socket
import struct
import time
import uuid
from urllib import error as urlerror
from urllib import request as urlrequest

from bleak import BleakScanner


def new_event_id() -> str:
    if hasattr(uuid, "uuid7"):
        return str(uuid.uuid7())
    return str(uuid.uuid4())


COMPANY_ID = int(os.environ.get("BLE_COMPANY_ID", "65535"))
INGEST_URL = os.environ.get("INGEST_URL", os.environ.get("BLE_INGEST_URL", ""))
TRACKER_ID = os.environ.get("TRACKER_ID", os.environ.get("BLE_DEVICE_ID", "pi-5-gateway-01"))
CONTRACT_VERSION = os.environ.get("CONTRACT_VERSION", "1.0.0")
AUTH_TOKEN = os.environ.get("INGEST_AUTH_TOKEN", os.environ.get("BLE_AUTH_TOKEN", ""))
COOLDOWN_SECONDS = int(os.environ.get("BLE_COOLDOWN_SECONDS", "60"))

last_sent_by_beacon: dict[str, float] = {}
_notify_sock: socket.socket | None = None
_notify_addr: str | None = None


def _init_sd_notify() -> None:
    global _notify_sock, _notify_addr
    notify_socket = os.environ.get("NOTIFY_SOCKET")
    if not notify_socket:
        return
    _notify_addr = notify_socket
    if notify_socket.startswith("@"):
        _notify_addr = "\0" + notify_socket[1:]
    _notify_sock = socket.socket(socket.AF_UNIX, socket.SOCK_DGRAM)


def _sd_notify(message: str) -> None:
    if not _notify_sock or _notify_addr is None:
        return
    try:
        _notify_sock.sendto(message.encode("utf-8"), _notify_addr)
    except OSError:
        pass


def parse_parcel_id(manufacturer_data: dict[int, bytes]) -> int | None:
    if COMPANY_ID not in manufacturer_data:
        return None
    raw = manufacturer_data[COMPANY_ID]
    if len(raw) < 4:
        return None
    return struct.unpack("<I", raw[:4])[0]


def post_event(payload: dict) -> tuple[int, str]:
    data = json.dumps(payload, separators=(",", ":")).encode("utf-8")
    headers = {"Content-Type": "application/json"}
    if AUTH_TOKEN:
        headers["Authorization"] = f"Bearer {AUTH_TOKEN}"

    req = urlrequest.Request(INGEST_URL, data=data, headers=headers, method="POST")
    try:
        with urlrequest.urlopen(req, timeout=8) as resp:
            body = resp.read().decode("utf-8", "ignore")
            return resp.status, body
    except urlerror.HTTPError as exc:
        body = exc.read().decode("utf-8", "ignore") if exc.fp else ""
        return exc.code, body


async def main() -> None:
    if not INGEST_URL:
        raise SystemExit("INGEST_URL (or BLE_INGEST_URL) is required")

    _init_sd_notify()
    _sd_notify("READY=1")

    watchdog_usec = int(os.environ.get("WATCHDOG_USEC", "0"))
    watchdog_interval = (watchdog_usec / 1_000_000) / 2 if watchdog_usec else 0
    last_watchdog = time.monotonic()

    def kick_watchdog() -> None:
        nonlocal last_watchdog
        if not watchdog_interval:
            return
        now_mono = time.monotonic()
        if (now_mono - last_watchdog) >= watchdog_interval:
            _sd_notify("WATCHDOG=1")
            last_watchdog = now_mono

    def detection_callback(device, advertisement_data):
        parcel_id = parse_parcel_id(advertisement_data.manufacturer_data)
        kick_watchdog()
        if parcel_id is None:
            return

        beacon_id = f"ble:{parcel_id}"
        now = time.monotonic()
        last_sent = last_sent_by_beacon.get(beacon_id)
        if last_sent is not None and (now - last_sent) < COOLDOWN_SECONDS:
            return

        ts_ms = int(time.time() * 1000)
        payload = {
            "eventId": new_event_id(),
            "contractVersion": CONTRACT_VERSION,
            "trackerId": TRACKER_ID,
            "eventType": "ble_scan",
            "trackerTsMs": ts_ms,
            "seq": ts_ms,
            "beaconId": beacon_id,
            "signal": {"rssi": device.rssi} if device.rssi is not None else {},
            "sourcePayload": {
                "parcelId": parcel_id,
                "source": "ble",
                "companyId": COMPANY_ID,
            },
        }

        try:
            status, body = post_event(payload)
            if 200 <= status < 300:
                last_sent_by_beacon[beacon_id] = now
                print(f"sent beaconId={beacon_id} status={status}", flush=True)
            else:
                print(f"send failed beaconId={beacon_id} status={status} body={body[:160]}", flush=True)
        except Exception as exc:
            print(f"send error beaconId={beacon_id} error={exc}", flush=True)

    scanner = BleakScanner(detection_callback)
    await scanner.start()
    print("BLE uplink scanner started", flush=True)

    while True:
        await asyncio.sleep(1)
        kick_watchdog()


if __name__ == "__main__":
    asyncio.run(main())
