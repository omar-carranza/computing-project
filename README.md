# Automotive Workshop IoT Monitor

## Project Structure

```
taller-iot-v2/
├── backend/
│   ├── app.py              ← Flask API (all endpoints + scheduler + Telegram)
│   └── requirements.txt
├── frontend/
│   ├── index.html          ← Dashboard HTML
│   ├── css/
│   │   └── style.css       ← All styles
│   └── js/
│       └── dashboard.js    ← All dashboard logic + charts + calendar
└── schema.sql              ← PostgreSQL tables
```

---

## Quick Start

### 1. Database
```bash
psql -U postgres -c "CREATE DATABASE taller_iot;"
psql -U postgres -d taller_iot -f schema.sql
```

### 2. Edit credentials in backend/app.py
```python
DB_CONFIG = {
    "password": "YOUR_PASSWORD",
    ...
}
TELEGRAM_TOKEN   = "YOUR_TOKEN"
TELEGRAM_CHAT_ID = "YOUR_CHAT_ID"
```

### 3. Run Flask
```bash
cd backend
pip install -r requirements.txt
py app.py
```
Dashboard at → http://localhost:5000

### 4. ESP32
Update `esp32_taller.ino`:
```cpp
const char* WIFI_SSID  = "your_wifi";
const char* WIFI_PASS  = "your_pass";
const char* SERVER_URL = "http://192.168.1.4:5000/api/sensor-data";
```

---

## API Endpoints

| Method | Route | Description |
|--------|-------|-------------|
| GET  | /                            | Dashboard |
| POST | /api/sensor-data             | ESP32 → receive reading |
| GET  | /api/sensor-data/current     | Latest reading |
| GET  | /api/sensor-data/latest?n=30 | Last N readings (charts) |
| GET  | /api/sensor-data/records     | Paginated table |
| GET  | /api/alerts?n=15             | Recent alerts |
| GET  | /api/averages?n=12           | Hourly averages |
| POST | /api/averages/compute        | Compute average now |
| GET  | /api/schedule                | List scheduled summaries |
| POST | /api/schedule                | Schedule a Telegram summary |
| DELETE | /api/schedule/:id          | Cancel a scheduled summary |

---

## Schedule API

POST `/api/schedule`
```json
{ "run_at": "2025-05-24T15:30:00" }
```
Use the calendar in the dashboard — select a date and time, click "Schedule Summary". The bot sends a full summary to Telegram at that moment.

---

## AWS Free Tier Deployment

```bash
# 1. EC2 t2.micro (Ubuntu 22.04) — open port 5000 in Security Group
# 2. Upload project
scp -r taller-iot-v2/ ubuntu@YOUR_EC2_IP:/home/ubuntu/

# 3. Install
sudo apt update && sudo apt install python3-pip postgresql -y
cd taller-iot-v2/backend
pip3 install -r requirements.txt

# 4. Run (stays alive after SSH close)
nohup python3 app.py &

# 5. Update ESP32 SERVER_URL to your EC2 public IP
```
