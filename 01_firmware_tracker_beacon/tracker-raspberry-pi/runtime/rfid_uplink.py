#!/usr/bin/env python3
"""RFID reader uplink that forwards normalized raw events to Convex /ingest."""

from __future__ import annotations

import json
import os
import socket
import time
import uuid
from urllib import error as urlerror
from urllib import request as urlrequest


def new_event_id() -> str:
    if hasattr(uuid, "uuid7"):
        return str(uuid.uuid7())
    return str(uuid.uuid4())


DEVICE = os.environ.get("RFID_DEVICE", "/dev/rfid_reader")
FRAME_SIZE = int(os.environ.get("RFID_FRAME_SIZE", "64"))
INGEST_URL = os.environ.get("INGEST_URL", os.environ.get("RFID_INGEST_URL", ""))
TRACKER_ID = os.environ.get("TRACKER_ID", os.environ.get("RFID_DEVICE_ID", "pi-5-gateway-01"))
CONTRACT_VERSION = os.environ.get("CONTRACT_VERSION", "1.0.0")
AUTH_TOKEN = os.environ.get("INGEST_AUTH_TOKEN", os.environ.get("RFID_AUTH_TOKEN", ""))
COOLDOWN_SECONDS = int(os.environ.get("RFID_COOLDOWN_SECONDS", "60"))

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


def extract_epc(frame: bytes) -> str | None:
    try:
        start = frame.index(0xE2)
    except ValueError:
        return None
    epc = frame[start : start + 12]
    if len(epc) < 12:
        return None
    return epc.hex().upper()


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


def main() -> None:
    if not INGEST_URL:
        raise SystemExit("INGEST_URL (or RFID_INGEST_URL) is required")

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

    with open(DEVICE, "rb", buffering=0) as handle:
        print(f"RFID uplink started on {DEVICE}", flush=True)
        while True:
            frame = handle.read(FRAME_SIZE)
            if not frame:
                time.sleep(0.01)
                kick_watchdog()
                continue

            epc = extract_epc(frame)
            kick_watchdog()
            if not epc:
                continue

            beacon_id = f"rfid:{epc}"
            now = time.monotonic()
            last_sent = last_sent_by_beacon.get(beacon_id)
            if last_sent is not None and (now - last_sent) < COOLDOWN_SECONDS:
                continue

            ts_ms = int(time.time() * 1000)
            payload = {
                "eventId": new_event_id(),
                "contractVersion": CONTRACT_VERSION,
                "trackerId": TRACKER_ID,
                "eventType": "rfid_scan",
                "trackerTsMs": ts_ms,
                "seq": ts_ms,
                "beaconId": beacon_id,
                "sourcePayload": {
                    "epc": epc,
                    "source": "rfid",
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


if __name__ == "__main__":
    main()
