-- Run this before starting Flask
-- psql -U postgres -d taller_iot -f schema.sql

CREATE TABLE IF NOT EXISTS sensor_data (
    id          SERIAL PRIMARY KEY,
    temperature FLOAT   NOT NULL,
    humidity    FLOAT   NOT NULL,
    pressure    FLOAT   NOT NULL,
    sound_level INTEGER NOT NULL,
    created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS alerts (
    id           SERIAL PRIMARY KEY,
    alert_type   VARCHAR(50),
    sensor_value FLOAT,
    message      TEXT,
    created_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS hourly_average (
    id              SERIAL PRIMARY KEY,
    avg_temperature FLOAT,
    avg_humidity    FLOAT,
    avg_pressure    FLOAT,
    avg_sound       FLOAT,
    period_start    TIMESTAMP,
    period_end      TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_sensor_data_time ON sensor_data(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_alerts_time      ON alerts(created_at DESC);
