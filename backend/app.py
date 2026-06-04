from flask import Flask, request, jsonify, send_from_directory
from flask_cors import CORS
import psycopg
from psycopg.rows import dict_row
from datetime import datetime, timedelta
import pytz
from apscheduler.schedulers.background import BackgroundScheduler
import requests
import os
import logging

# ============================================================
# APP SETUP
# ============================================================

BASE_DIR     = os.path.dirname(os.path.abspath(__file__))
FRONTEND_DIR = os.path.abspath(os.path.join(BASE_DIR, '..', 'frontend'))

app = Flask(__name__, static_folder=None)
CORS(app)
logging.basicConfig(level=logging.INFO)

# Print paths on startup so you can verify
print(f'[CONFIG] Backend dir:  {BASE_DIR}')
print(f'[CONFIG] Frontend dir: {FRONTEND_DIR}')
print(f'[CONFIG] index.html exists: {os.path.exists(os.path.join(FRONTEND_DIR, "index.html"))}')

# ============================================================
# CONFIG — edit directly or use environment variables
# ============================================================

DATABASE_URL = os.getenv("DATABASE_URL")

TELEGRAM_TOKEN = os.getenv("TELEGRAM_TOKEN")
TELEGRAM_CHAT_ID = os.getenv("TELEGRAM_CHAT_ID")

# DB_CONFIG = {
#     "host":     os.getenv("DB_HOST",  "localhost"),
#     "port":     int(os.getenv("DB_PORT", 5432)),
#     "database": os.getenv("DB_NAME",  "taller_iot"),
#     "user":     os.getenv("DB_USER",  "postgres"),
#     "password": os.getenv("DB_PASS",  "carranza06"),
# }

# TELEGRAM_TOKEN   = os.getenv("TELEGRAM_TOKEN",   "8935796677:AAFi5wLLHmvCTeJNGtV67UUMfRmxEaE_3K0")
# TELEGRAM_CHAT_ID = os.getenv("TELEGRAM_CHAT_ID", "5992449522")

THRESHOLDS = {
    "temperature": 35.0,
    "humidity":    80.0,
    "sound_level": 3000,
    "pressure_min": 900.0,
    "pressure_max": 1080.0,
}

# ============================================================
# DB HELPERS
# ============================================================

def get_db():
    # return psycopg2.connect(**DB_CONFIG)
    return psycopg.connect(DATABASE_URL)

# def query(sql, params=(), fetchone=False, fetchall=False, commit=False):
#     conn = get_db()
#     try:
#         with conn:
#             with conn.cursor(cursor_factory=psycopg.extras.RealDictCursor) as cur:
#                 cur.execute(sql, params)
#                 if commit:
#                     return None
#                 if fetchone:
#                     return cur.fetchone()
#                 if fetchall:
#                     return cur.fetchall()
#     finally:
#         conn.close()

def query(sql, params=(), fetchone=False, fetchall=False, commit=False):
    conn = get_db()

    try:
        with conn:
            with conn.cursor(row_factory=dict_row) as cur:
                cur.execute(sql, params)

                if commit:
                    return None

                if fetchone:
                    return cur.fetchone()

                if fetchall:
                    return cur.fetchall()

    finally:
        conn.close()

# ============================================================
# TELEGRAM
# ============================================================

def send_telegram(message: str):
    url = f"https://api.telegram.org/bot{TELEGRAM_TOKEN}/sendMessage"
    try:
        r = requests.post(url, json={
            "chat_id": TELEGRAM_CHAT_ID,
            "text": message,
            "parse_mode": "HTML"
        }, timeout=6)
        logging.info(f"Telegram sent: {r.status_code}")
    except Exception as e:
        logging.error(f"Telegram error: {e}")

# ============================================================
# SCHEDULED SUMMARY
# ============================================================

def send_scheduled_summary():
    # Use local Mexico City time — matches how PostgreSQL stores timestamps on this machine
    now   = datetime.now(LOCAL_TZ)
    end   = now
    start = now - timedelta(hours=1)

    print(f">>> Summary: querying from {start.strftime('%H:%M')} to {end.strftime('%H:%M')} (Mexico City)")

    # Query ALL data from last 24h as fallback if last hour has no data
    row = query(
        """
        SELECT AVG(temperature) AS avg_temp,
               AVG(humidity)    AS avg_hum,
               AVG(pressure)    AS avg_pres,
               AVG(sound_level) AS avg_sound,
               MAX(temperature) AS max_temp,
               MIN(temperature) AS min_temp,
               COUNT(*)         AS readings
        FROM sensor_data
        WHERE created_at >= NOW() - INTERVAL '1 hour'
        """,
        fetchone=True
    )

    print(f">>> Query result: {dict(row) if row else None}")

    alert_count = query(
        "SELECT COUNT(*) AS cnt FROM alerts WHERE created_at >= NOW() - INTERVAL '1 hour'",
        fetchone=True
    )

    alerts_n = alert_count["cnt"] if alert_count else 0

    if row and row["avg_temp"] is not None:
        query(
            """
            INSERT INTO hourly_average
                (avg_temperature, avg_humidity, avg_pressure, avg_sound, period_start, period_end)
            VALUES (%s, %s, %s, %s, %s, %s)
            """,
            (row["avg_temp"], row["avg_hum"], row["avg_pres"], row["avg_sound"],
             start.replace(tzinfo=None), end.replace(tzinfo=None)),
            commit=True
        )
        msg = (
            f"<b>Automotive Workshop — Scheduled Summary</b>\n"
            f"Period: {start.strftime('%I:%M %p')} - {end.strftime('%I:%M %p')} (Mexico City)\n\n"
            f"🌡️ Temperature:  avg {row['avg_temp']:.1f} °C  |  max {row['max_temp']:.1f}  |  min {row['min_temp']:.1f}\n"
            f"💧 Humidity:     avg {row['avg_hum']:.1f} %\n"
            f"🔩 Pressure:     avg {row['avg_pres']:.1f} hPa\n"
            f"🔊 Sound Level:  avg {row['avg_sound']:.0f} AO\n"
            f"📊 Readings:     {row['readings']}\n"
            f"⚠️ Alerts fired: {alerts_n}"
        )
        send_telegram(msg)
        logging.info(f"Summary sent: {row['readings']} readings, {alerts_n} alerts")
        print(f">>> Telegram message sent!")
    else:
        # No data in last hour — send a notice anyway
        msg = (
            f"<b>Automotive Workshop — Scheduled Summary</b>\n"
            f"Period: {start.strftime('%I:%M %p')} - {end.strftime('%I:%M %p')} (Mexico City)\n\n"
            f"No sensor data recorded in the last hour.\n"
            f"Please check that the ESP32 is running."
        )
        send_telegram(msg)
        print(f">>> No data found — sent notice to Telegram")
        logging.warning("Summary: no sensor data in last hour")

# ============================================================
# ALERT ENGINE
# ============================================================

def evaluate_alerts(data: dict):
    ICONS = {
        "temperature": "\U0001f321\ufe0f",   # 🌡️
        "humidity":    "\U0001f4a7",           # 💧
        "sound_level": "\U0001f50a",           # 🔊
        "pressure":    "\U0001f527",           # 🔧
    }
    checks = [
        ("temperature", data["temperature"], THRESHOLDS["temperature"],
         f"High Temperature: {data['temperature']:.1f} °C  (limit {THRESHOLDS['temperature']} °C)"),
        ("humidity", data["humidity"], THRESHOLDS["humidity"],
         f"High Humidity: {data['humidity']:.1f}%  (limit {THRESHOLDS['humidity']}%)"),
        ("sound_level", data["sound_level"], THRESHOLDS["sound_level"],
         f"High Sound Level: {data['sound_level']} AO  (limit {THRESHOLDS['sound_level']} AO)"),
    ]
    for key, val, limit, msg in checks:
        if val > limit:
            query(
                "INSERT INTO alerts (alert_type, sensor_value, message) VALUES (%s, %s, %s)",
                (key, val, msg), commit=True
            )
            icon = ICONS.get(key, "\u26a0\ufe0f")
            send_telegram(
                f"{icon} <b>ALERT \u2014 Automotive Workshop</b>\n"
                f"{msg}"
            )

    p = data["pressure"]
    if p and not (THRESHOLDS["pressure_min"] <= p <= THRESHOLDS["pressure_max"]):
        msg = f"Pressure out of range: {p:.1f} hPa  (range {THRESHOLDS['pressure_min']}\u2013{THRESHOLDS['pressure_max']} hPa)"
        query("INSERT INTO alerts (alert_type, sensor_value, message) VALUES (%s, %s, %s)",
              ("pressure", p, msg), commit=True)
        send_telegram(
            f"\U0001f527 <b>ALERT \u2014 Automotive Workshop</b>\n"
            f"{msg}"
        )

# ============================================================
# SCHEDULER
# ============================================================

# Fixed timezone — matches the user's location (Toluca, Mexico = America/Mexico_City)
LOCAL_TZ = pytz.timezone("America/Mexico_City")
scheduler = BackgroundScheduler(timezone=LOCAL_TZ)
scheduler.add_job(send_scheduled_summary, "interval", hours=1, id="hourly_summary",
                  misfire_grace_time=3600)   # run even if up to 1h late
scheduler.start()
logging.info(f"Scheduler timezone: {LOCAL_TZ}")

# ============================================================
# SERVE FRONTEND
# ============================================================

@app.route("/")
def index():
    return send_from_directory(FRONTEND_DIR, "index.html")

@app.route("/css/<path:filename>")
def serve_css(filename):
    return send_from_directory(os.path.join(FRONTEND_DIR, 'css'), filename)

@app.route("/js/<path:filename>")
def serve_js(filename):
    return send_from_directory(os.path.join(FRONTEND_DIR, 'js'), filename)

# ============================================================
# API ENDPOINTS
# ============================================================

# ESP32 → receive sensor data
@app.route("/api/sensor-data", methods=["POST"])
def receive_data():
    data = request.get_json(force=True)
    required = ["temperature", "humidity", "pressure", "sound_level"]
    if not all(k in data for k in required):
        return jsonify({"error": "Missing fields"}), 400

    query(
        "INSERT INTO sensor_data (temperature, humidity, pressure, sound_level) VALUES (%s,%s,%s,%s)",
        (data["temperature"], data["humidity"], data["pressure"], data["sound_level"]),
        commit=True
    )
    evaluate_alerts(data)
    return jsonify({"ok": True}), 201

# Latest single reading
@app.route("/api/sensor-data/current")
def current():
    row = query("SELECT * FROM sensor_data ORDER BY created_at DESC LIMIT 1", fetchone=True)
    return jsonify(dict(row) if row else {})

# Last N readings for charts
@app.route("/api/sensor-data/latest")
def latest():
    n = min(int(request.args.get("n", 20)), 200)
    rows = query("SELECT * FROM sensor_data ORDER BY created_at DESC LIMIT %s", (n,), fetchall=True)
    return jsonify([dict(r) for r in rows])

# All sensor records paginated
@app.route("/api/sensor-data/records")
def records():
    page     = int(request.args.get("page", 1))
    per_page = int(request.args.get("per_page", 8))
    offset   = (page - 1) * per_page
    rows  = query("SELECT * FROM sensor_data ORDER BY created_at DESC LIMIT %s OFFSET %s",
                  (per_page, offset), fetchall=True)
    total = query("SELECT COUNT(*) AS cnt FROM sensor_data", fetchone=True)
    return jsonify({"records": [dict(r) for r in rows], "total": total["cnt"] if total else 0})

# Recent alerts
@app.route("/api/alerts")
def alerts():
    n = int(request.args.get("n", 10))
    rows = query("SELECT * FROM alerts ORDER BY created_at DESC LIMIT %s", (n,), fetchall=True)
    return jsonify([dict(r) for r in rows])

# Hourly averages
@app.route("/api/averages")
def averages():
    n = int(request.args.get("n", 24))
    rows = query("SELECT * FROM hourly_average ORDER BY period_start DESC LIMIT %s", (n,), fetchall=True)
    return jsonify([dict(r) for r in rows])

# Force compute now (demo)
@app.route("/api/averages/compute", methods=["POST"])
def compute_now():
    send_scheduled_summary()
    return jsonify({"ok": True})

# Schedule a one-time summary at a specific datetime
@app.route("/api/schedule", methods=["POST"])
def schedule_summary():
    data = request.get_json(force=True)
    run_at_str = data.get("run_at")  # ISO format: "2025-05-24T15:30:00"
    if not run_at_str:
        return jsonify({"error": "Missing run_at"}), 400
    try:
        naive_dt = datetime.fromisoformat(run_at_str)   # e.g. 2026-06-03T22:10:00
        run_at   = LOCAL_TZ.localize(naive_dt)          # attach Mexico City tz
    except (ValueError, Exception) as e:
        return jsonify({"error": f"Invalid datetime: {e}"}), 400

    job_id = f"scheduled_{run_at.strftime('%Y%m%d%H%M%S')}"
    if scheduler.get_job(job_id):
        scheduler.remove_job(job_id)

    # Validate the time is in the future
    now = datetime.now(LOCAL_TZ)
    if run_at <= now:
        return jsonify({"error": f"The selected time ({run_at.strftime('%H:%M')}) has already passed. Please choose a future time."}), 400

    scheduler.add_job(
        send_scheduled_summary,
        trigger="date",
        run_date=run_at,
        id=job_id,
        misfire_grace_time=3600   # run even if Flask is briefly busy at that moment
    )
    # Return the scheduled time as Mexico City local string so frontend shows it correctly
    local_str = run_at.strftime('%Y-%m-%dT%H:%M:%S')
    logging.info(f"Scheduled summary at {local_str} Mexico City time")
    print(f">>> Job scheduled for: {local_str} (Mexico City)")
    return jsonify({"ok": True, "scheduled_at": local_str})

# List scheduled one-time jobs
@app.route("/api/schedule", methods=["GET"])
def get_schedules():
    jobs = []
    for job in scheduler.get_jobs():
        if job.id.startswith("scheduled_"):
            nr = job.next_run_time
            if nr:
                # Convert to Mexico City time and return as plain string (no Z, no offset)
                # so the JS displays it exactly without any timezone conversion
                local_nr = nr.astimezone(LOCAL_TZ).strftime('%Y-%m-%d %I:%M:%S %p')
            else:
                local_nr = None
            jobs.append({
                "id": job.id,
                "next_run": local_nr   # e.g. "Jun 3, 2026  10:35:00 PM"
            })
    return jsonify(jobs)

# Cancel a scheduled job
@app.route("/api/schedule/<job_id>", methods=["DELETE"])
def cancel_schedule(job_id):
    job = scheduler.get_job(job_id)
    if job:
        job.remove()
        return jsonify({"ok": True})
    return jsonify({"error": "Job not found"}), 404

# Current thresholds
@app.route("/api/thresholds")
def get_thresholds():
    return jsonify(THRESHOLDS)

if __name__ == "__main__":
    app.run(debug=True, host="0.0.0.0", port=5000)
