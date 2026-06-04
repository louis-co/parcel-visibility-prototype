#!/usr/bin/env python3
"""Location uplink with GNSS primary + SIM7670 native LBS fallback.

Behavior:
- Emit `gps_fix` when GNSS has a valid position.
- Emit `gps_cell_fallback` when GNSS fails and LBS succeeds within configured accuracy.
- Emit `gps_no_fix` when neither source can provide an acceptable coordinate.
- Emit periodic `heartbeat` with `status.locationMode`.
- Queue outbound events in SQLite for durable retries.
"""

from __future__ import annotations

import json
import os
import socket
import sqlite3
import time
import uuid
from typing import Callable, Optional
from urllib import error as urlerror
from urllib import request as urlrequest

import serial


def env_bool(name: str, default: bool) -> bool:
    raw = os.environ.get(name)
    if raw is None:
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


def now_ms() -> int:
    return int(time.time() * 1000)


def new_event_id() -> str:
    if hasattr(uuid, "uuid7"):
        return str(uuid.uuid7())
    return str(uuid.uuid4())


CONTRACT_VERSION = os.environ.get("CONTRACT_VERSION", "1.0.0")
INGEST_URL = os.environ.get("INGEST_URL", "")
TRACKER_ID = os.environ.get("TRACKER_ID", os.environ.get("DEVICE_ID", "pi-001"))
INGEST_AUTH_TOKEN = os.environ.get("INGEST_AUTH_TOKEN", "")

LOCATION_INTERVAL_SEC = int(os.environ.get("LOCATION_INTERVAL_SEC", "30"))
HEARTBEAT_INTERVAL_SEC = int(os.environ.get("HEARTBEAT_INTERVAL_SEC", "30"))

AT_PORT = os.environ.get(
    "AT_PORT", "/dev/serial/by-id/usb-QualComm_QualComm_Compo_000000000001-if06"
)
AT_PORT_FALLBACKS = [
    p.strip()
    for p in os.environ.get("AT_PORT_FALLBACKS", "/dev/ttyACM2,/dev/ttyACM0").split(",")
    if p.strip()
]
BAUD = int(os.environ.get("AT_BAUD", "115200"))
AT_READ_WINDOW_SEC = float(os.environ.get("AT_READ_WINDOW_SEC", "3"))

LBS_ENABLED = env_bool("LBS_ENABLED", True)
LBS_MAX_ACCURACY_M = float(os.environ.get("LBS_MAX_ACCURACY_M", "1000"))
LBS_QUERY_TIMEOUT_SEC = float(os.environ.get("LBS_QUERY_TIMEOUT_SEC", "4"))
LBS_ALLOW_ZERO_COORDS = env_bool("LBS_ALLOW_ZERO_COORDS", False)

NOFIX_GNSS_POWER_REASSERT_EVERY = int(
    os.environ.get("NOFIX_GNSS_POWER_REASSERT_EVERY", "2")
)
NOFIX_COLDSTART_AFTER = int(os.environ.get("NOFIX_COLDSTART_AFTER", "3"))

QUEUE_DB_PATH = os.environ.get("QUEUE_DB_PATH", "/var/lib/parcel-tracker/location_uplink.db")
MAX_FLUSH_BATCH = int(os.environ.get("MAX_FLUSH_BATCH", "25"))
MAX_BACKOFF_SEC = float(os.environ.get("MAX_BACKOFF_SEC", "300"))

_notify_sock: Optional[socket.socket] = None
_notify_addr: Optional[str] = None


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


def ensure_db(path: str) -> sqlite3.Connection:
    parent = os.path.dirname(path)
    if parent:
        os.makedirs(parent, exist_ok=True)

    conn = sqlite3.connect(path)
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS outbox (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          event_id TEXT NOT NULL UNIQUE,
          payload TEXT NOT NULL,
          attempts INTEGER NOT NULL DEFAULT 0,
          next_attempt_ms INTEGER NOT NULL,
          created_ts_ms INTEGER NOT NULL
        )
        """
    )
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_outbox_next ON outbox(next_attempt_ms, id)"
    )
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS state (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        )
        """
    )
    conn.commit()
    return conn


def next_seq(conn: sqlite3.Connection) -> int:
    row = conn.execute("SELECT value FROM state WHERE key = 'seq'").fetchone()
    current = int(row[0]) if row else 0
    nxt = current + 1
    conn.execute(
        "INSERT INTO state(key, value) VALUES('seq', ?) "
        "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        (str(nxt),),
    )
    conn.commit()
    return nxt


def queue_event(conn: sqlite3.Connection, event: dict) -> None:
    payload = json.dumps(event, separators=(",", ":"), ensure_ascii=True)
    try:
        conn.execute(
            "INSERT INTO outbox(event_id, payload, attempts, next_attempt_ms, created_ts_ms) "
            "VALUES(?, ?, 0, ?, ?)",
            (event["eventId"], payload, now_ms(), now_ms()),
        )
        conn.commit()
    except sqlite3.IntegrityError:
        # Duplicate event_id is already persisted; keep first copy.
        pass


def retry_backoff_ms(attempts: int) -> int:
    seconds = min(MAX_BACKOFF_SEC, 2 ** min(attempts, 8))
    return int(seconds * 1000)


def post_payload(payload: str) -> tuple[int, str]:
    headers = {"Content-Type": "application/json"}
    if INGEST_AUTH_TOKEN:
        headers["Authorization"] = f"Bearer {INGEST_AUTH_TOKEN}"

    req = urlrequest.Request(
        INGEST_URL,
        data=payload.encode("utf-8"),
        headers=headers,
        method="POST",
    )

    try:
        with urlrequest.urlopen(req, timeout=10) as resp:
            body = resp.read().decode("utf-8", "ignore")
            return resp.status, body
    except urlerror.HTTPError as exc:
        body = exc.read().decode("utf-8", "ignore") if exc.fp else ""
        return exc.code, body


def flush_outbox(
    conn: sqlite3.Connection, watchdog_kick: Optional[Callable[[], None]] = None
) -> None:
    rows = conn.execute(
        "SELECT id, event_id, payload, attempts FROM outbox "
        "WHERE next_attempt_ms <= ? ORDER BY id ASC LIMIT ?",
        (now_ms(), MAX_FLUSH_BATCH),
    ).fetchall()

    for row_id, event_id, payload, attempts in rows:
        if watchdog_kick is not None:
            watchdog_kick()
        try:
            status, body = post_payload(payload)
            if 200 <= status < 300:
                conn.execute("DELETE FROM outbox WHERE id = ?", (row_id,))
                conn.commit()
                print(f"sent eventId={event_id} status={status}", flush=True)
            else:
                new_attempts = attempts + 1
                next_attempt = now_ms() + retry_backoff_ms(new_attempts)
                conn.execute(
                    "UPDATE outbox SET attempts = ?, next_attempt_ms = ? WHERE id = ?",
                    (new_attempts, next_attempt, row_id),
                )
                conn.commit()
                print(
                    f"retry eventId={event_id} status={status} body={body[:160]}",
                    flush=True,
                )
        except Exception as exc:
            new_attempts = attempts + 1
            next_attempt = now_ms() + retry_backoff_ms(new_attempts)
            conn.execute(
                "UPDATE outbox SET attempts = ?, next_attempt_ms = ? WHERE id = ?",
                (new_attempts, next_attempt, row_id),
            )
            conn.commit()
            print(f"retry eventId={event_id} error={exc}", flush=True)


def build_event(
    conn: sqlite3.Connection,
    event_type: str,
    beacon_id: Optional[str] = None,
    location: Optional[dict] = None,
    signal: Optional[dict] = None,
    status: Optional[dict] = None,
    source_payload: Optional[dict] = None,
) -> dict:
    event = {
        "eventId": new_event_id(),
        "contractVersion": CONTRACT_VERSION,
        "trackerId": TRACKER_ID,
        "eventType": event_type,
        "trackerTsMs": now_ms(),
        "seq": next_seq(conn),
    }
    if beacon_id is not None:
        event["beaconId"] = beacon_id
    if location is not None:
        event["location"] = location
    if signal is not None:
        event["signal"] = signal
    if status is not None:
        event["status"] = status
    if source_payload is not None:
        event["sourcePayload"] = source_payload
    return event


def at_cmd(ser: serial.Serial, cmd: str, window: float = AT_READ_WINDOW_SEC) -> str:
    ser.reset_input_buffer()
    ser.write((cmd + "\r\n").encode("ascii", "ignore"))
    ser.flush()

    out = ""
    started = time.time()
    while time.time() - started < window:
        waiting = ser.in_waiting
        if waiting:
            out += ser.read(waiting).decode("ascii", "ignore")
        time.sleep(0.05)
    return out


def parse_cgpsinfo(resp: str):
    line = None
    for item in resp.splitlines():
        if "+CGPSINFO:" in item:
            line = item.strip()
            break
    if not line:
        return None, None

    payload = line.split(":", 1)[1].strip()
    parts = [p.strip() for p in payload.split(",")]
    if len(parts) < 4 or not parts[0] or not parts[2]:
        return None, line

    lat_s, ns, lon_s, ew = parts[0], parts[1], parts[2], parts[3]

    def dm_to_deg(dm: str, is_lon: bool) -> float:
        deg_len = 3 if is_lon else 2
        deg = float(dm[:deg_len])
        minutes = float(dm[deg_len:])
        return deg + (minutes / 60.0)

    try:
        lat = dm_to_deg(lat_s, is_lon=False)
        lon = dm_to_deg(lon_s, is_lon=True)
        if ns.upper() == "S":
            lat = -lat
        if ew.upper() == "W":
            lon = -lon
    except Exception:
        return None, line

    alt = None
    speed = None
    try:
        if len(parts) > 6 and parts[6]:
            alt = float(parts[6])
    except Exception:
        pass
    try:
        if len(parts) > 7 and parts[7]:
            speed = float(parts[7])
    except Exception:
        pass

    return {
        "lat": lat,
        "lon": lon,
        "altM": alt,
        "speedKmh": speed,
        "method": "gnss",
    }, line


def parse_cgnssinfo(resp: str):
    line = None
    for item in resp.splitlines():
        if "+CGNSSINFO:" in item:
            line = item.strip()
            break
    if not line:
        return None, None

    payload = line.split(":", 1)[1].strip()
    parts = [p.strip() for p in payload.split(",")]
    if len(parts) < 9 or not parts[5] or not parts[7]:
        return None, line

    lat_v, lat_h = parts[5], parts[6] if len(parts) > 6 else ""
    lon_v, lon_h = parts[7], parts[8] if len(parts) > 8 else ""

    try:
        lat = float(lat_v)
        lon = float(lon_v)
        if lat_h.upper() == "S":
            lat = -lat
        if lon_h.upper() == "W":
            lon = -lon
    except Exception:
        return None, line

    alt = None
    speed = None
    hdop = None

    try:
        if len(parts) > 11 and parts[11]:
            alt = float(parts[11])
    except Exception:
        pass
    try:
        if len(parts) > 12 and parts[12]:
            speed = float(parts[12])
    except Exception:
        pass
    try:
        if len(parts) > 13 and parts[13]:
            hdop = float(parts[13])
    except Exception:
        pass

    return {
        "lat": lat,
        "lon": lon,
        "altM": alt,
        "speedKmh": speed,
        "hdop": hdop,
        "method": "gnss",
    }, line


def parse_clbs(resp: str):
    line = None
    for item in resp.splitlines():
        if "+CLBS:" in item:
            line = item.strip()
            break
    if not line:
        return None, None

    payload = line.split(":", 1)[1].strip()
    parts = [p.strip().strip('"') for p in payload.split(",")]
    if len(parts) < 4:
        return None, line

    try:
        code = int(parts[0])
    except ValueError:
        return None, line
    if code != 0:
        return None, line

    try:
        lat = float(parts[1])
        lon = float(parts[2])
        accuracy = float(parts[3])
    except ValueError:
        return None, line

    return {
        "lat": lat,
        "lon": lon,
        "accuracyM": accuracy,
        "method": "cell_lbs_native",
        "source": "sim7670_clbs",
    }, line


def ensure_gnss_power(ser: serial.Serial) -> None:
    # Keep GNSS receiver powered. Some modem states can silently power it down.
    at_cmd(ser, "AT+CGNSSPWR=1")


def recover_gnss_if_needed(ser: serial.Serial, nofix_streak: int) -> int:
    if NOFIX_GNSS_POWER_REASSERT_EVERY > 0 and (
        nofix_streak % NOFIX_GNSS_POWER_REASSERT_EVERY
    ) == 0:
        at_cmd(ser, "AT+CGNSSPWR=1")

    if NOFIX_COLDSTART_AFTER > 0 and nofix_streak >= NOFIX_COLDSTART_AFTER:
        at_cmd(ser, "AT+CGNSSPWR=1")
        at_cmd(ser, "AT+CGPSCOLD")
        return 0

    return nofix_streak


def probe_lbs_support(ser: serial.Serial) -> bool:
    if not LBS_ENABLED:
        return False
    resp = at_cmd(ser, "AT+CLBS=?", window=LBS_QUERY_TIMEOUT_SEC)
    normalized = resp.upper()
    ok = (
        bool(resp.strip())
        and "ERROR" not in normalized
        and ("+CLBS" in normalized or "OK" in normalized)
    )
    if ok:
        print("LBS probe: supported", flush=True)
    else:
        print("LBS probe: unsupported (AT+CLBS=?)", flush=True)
    return ok


def query_lbs(ser: serial.Serial):
    attempts: list[dict[str, str]] = []
    for cmd in ("AT+CLBS=1,1", "AT+CLBS=4,1"):
        resp = at_cmd(ser, cmd, window=LBS_QUERY_TIMEOUT_SEC)
        parsed, raw = parse_clbs(resp)
        attempts.append({"command": cmd, "raw": raw or resp.strip()})
        if parsed is not None:
            lat = float(parsed["lat"])
            lon = float(parsed["lon"])
            if (not LBS_ALLOW_ZERO_COORDS) and abs(lat) < 1e-9 and abs(lon) < 1e-9:
                print("LBS ignored because coordinates are 0,0", flush=True)
                continue
            return parsed, {"command": cmd, "raw": raw}, attempts
    return None, None, attempts


def pick_port() -> str:
    candidates = [AT_PORT] + AT_PORT_FALLBACKS
    for candidate in candidates:
        if os.path.exists(candidate):
            return candidate
    return AT_PORT


def run_location_cycle(
    conn: sqlite3.Connection,
    ser: serial.Serial,
    lbs_supported: bool,
    nofix_streak: int,
) -> tuple[str, int]:
    cgps_resp = at_cmd(ser, "AT+CGPSINFO")
    gnss_location, cgps_raw = parse_cgpsinfo(cgps_resp)

    if gnss_location is None:
        cgnss_resp = at_cmd(ser, "AT+CGNSSINFO")
        gnss_location, cgnss_raw = parse_cgnssinfo(cgnss_resp)
    else:
        cgnss_raw = None

    if gnss_location is not None:
        # Strip None fields to keep payload compact and cross-compatible.
        clean_location = {k: v for k, v in gnss_location.items() if v is not None}
        event = build_event(
            conn,
            "gps_fix",
            location=clean_location,
            source_payload={"cgpsinfoRaw": cgps_raw, "cgnssinfoRaw": cgnss_raw},
        )
        queue_event(conn, event)
        return "gnss_fix", 0

    lbs_attempts: list[dict[str, str]] = []
    if lbs_supported and LBS_ENABLED:
        lbs_location, lbs_meta, lbs_attempts = query_lbs(ser)
        if lbs_location is not None:
            accuracy = float(lbs_location["accuracyM"])
            if accuracy <= LBS_MAX_ACCURACY_M:
                event = build_event(
                    conn,
                    "gps_cell_fallback",
                    location=lbs_location,
                    source_payload=lbs_meta,
                )
                queue_event(conn, event)
                return "cell_fallback", 0
            print(
                f"LBS ignored because accuracyM={accuracy} exceeds max={LBS_MAX_ACCURACY_M}",
                flush=True,
            )

    nofix_streak += 1
    nofix_streak = recover_gnss_if_needed(ser, nofix_streak)

    no_fix_event = build_event(
        conn,
        "gps_no_fix",
        source_payload={
            "reason": "gnss_and_lbs_unavailable",
            "cgpsinfoRaw": cgps_raw,
            "cgnssinfoRaw": cgnss_raw,
            "lbsAttempts": lbs_attempts,
        },
    )
    queue_event(conn, no_fix_event)
    return "no_fix", nofix_streak


def queue_heartbeat(conn: sqlite3.Connection, location_mode: str) -> None:
    heartbeat_event = build_event(
        conn,
        "heartbeat",
        status={"locationMode": location_mode},
    )
    queue_event(conn, heartbeat_event)


def main() -> None:
    if not INGEST_URL:
        raise SystemExit("INGEST_URL is required")

    conn = ensure_db(QUEUE_DB_PATH)

    _init_sd_notify()
    _sd_notify("READY=1")

    watchdog_usec = int(os.environ.get("WATCHDOG_USEC", "0"))
    watchdog_interval = (watchdog_usec / 1_000_000) / 2 if watchdog_usec else 0
    last_watchdog = time.monotonic()

    def kick_watchdog(force: bool = False) -> None:
        nonlocal last_watchdog
        if not watchdog_interval:
            return
        now_mono = time.monotonic()
        if force or (now_mono - last_watchdog) >= watchdog_interval:
            _sd_notify("WATCHDOG=1")
            last_watchdog = now_mono

    next_location_run = 0.0
    next_heartbeat_run = 0.0
    location_mode = "no_fix"
    nofix_streak = 0

    while True:
        try:
            port = pick_port()
            with serial.Serial(port, BAUD, timeout=1.5) as ser:
                print(f"Using AT port: {port}", flush=True)
                ensure_gnss_power(ser)
                lbs_supported = probe_lbs_support(ser)

                while True:
                    kick_watchdog()
                    now = time.time()

                    if now >= next_location_run:
                        kick_watchdog(force=True)
                        location_mode, nofix_streak = run_location_cycle(
                            conn, ser, lbs_supported, nofix_streak
                        )
                        next_location_run = now + max(1, LOCATION_INTERVAL_SEC)

                    if now >= next_heartbeat_run:
                        kick_watchdog(force=True)
                        queue_heartbeat(conn, location_mode)
                        next_heartbeat_run = now + max(1, HEARTBEAT_INTERVAL_SEC)

                    flush_outbox(conn, watchdog_kick=lambda: kick_watchdog(force=True))
                    kick_watchdog()

                    time.sleep(0.25)

        except serial.SerialException as exc:
            print(f"Serial error: {exc}; reconnecting in 3s", flush=True)
            flush_outbox(conn)
            time.sleep(3)
        except Exception as exc:
            print(f"Loop error: {exc}; reconnecting in 3s", flush=True)
            flush_outbox(conn)
            time.sleep(3)


if __name__ == "__main__":
    main()
