# Industrial Hydrogen Leak & Anomaly Detection System

An IoT backend application engineered for real-time monitoring, early anomaly detection, and automated safety actuation in industrial hydrogen and battery storage systems.

The system continuously acquires telemetry from MQ-8 gas sensors and ultrasonic micro-swelling probes via USB Serial, filters noisy sensor data using Digital Signal Processing (DSP), runs real-time Machine Learning anomaly scoring via Isolation Forest, and streams telemetry to a frontend interface via WebSockets.

## Key Features

- **Dual Data Sources:** Seamlessly switches between live hardware data via USB Serial (COM19 @ 115200 Baud) and a built-in Thermal Runaway Simulation Engine.
- **Real-Time Signal Processing:**
  - **Kalman Filtering:** Smooths MQ-8 hydrogen gas PPM readings to eliminate transient electrical noise.
  - **Two-Stage EMA Filtering:** Filters ultrasonic micro-swelling distances and rates, suppressing acoustic jitter for clean sub-millimeter measurements.
  - **Risk Score Slew-Rate Dampener:** Smooths gauge transitions, preventing abrupt visual jumps on client dashboards.
- **Predictive Anomaly & Risk Engine:**
  - Multi-factor continuous risk score combining gas PPM, physical cell expansion magnitude, and expansion rate (mm/s).
  - Isolation Forest ML Model for unsupervised multivariate anomaly detection.
- **Automatic Safety Actuation:** Triggers hardware buzzers based on dynamic threat thresholds.

## Tech Stack

- **Hardware:** ESP32 Microcontroller, MQ-8 Hydrogen Gas Sensor
- **Backend:** Python, Flask, Flask-SocketIO, PySerial
- **Machine Learning:** Scikit-Learn (Isolation Forest), Joblib, Pandas, NumPy
- **Frontend:** HTML5, CSS3, JavaScript (ES6+), TypeScript

## Data & Safety Pipeline

┌─────────────────────────┐ ┌─────────────────────────┐
│ Hardware USB Serial │ OR │ Thermal Runaway │
│ (Gas Sensor + Probes) │ │ Simulation Engine │
└────────────┬────────────┘ └────────────┬────────────┘
│ │
└────────────────┬───────────────┘
│
▼
┌───────────────────────────────────────────┐
│ DSP & Telemetry Engine │
├───────────────────────────────────────────┤
│ • Kalman Filter (Gas PPM) │
│ • Two-Stage EMA Filter (Swelling/Rate) │
│ • Isolation Forest Anomaly Score │
│ • Composite Risk Calculation & Smoothing │
└─────────────────────┬─────────────────────┘
│
┌──────────────┴──────────────┐
▼ ▼
Safety Hardware Actuation WebSocket Stream
(Gas Buzzers) (JSON Sensor Update)
