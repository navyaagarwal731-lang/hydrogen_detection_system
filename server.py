import time
import math
import threading
import re
import numpy as np
import serial
from flask import Flask, jsonify, request, send_from_directory
from flask_socketio import SocketIO, emit
from sklearn.ensemble import IsolationForest

prev_swell_rate = 0.0
smooth_risk = 0.0

app = Flask(__name__, static_folder=".")
app.config['SECRET_KEY'] = 'industrial_safety_secret'

# Force threading mode for multi-platform SocketIO stability
socketio = SocketIO(app, cors_allowed_origins="*", async_mode="threading")

# --- USB SERIAL CONFIGURATION ---
SERIAL_PORT = 'COM19'
BAUD_RATE = 115200

ser = None
try:
    ser = serial.Serial(SERIAL_PORT, BAUD_RATE, timeout=0.1)
    time.sleep(1)
    print(f"[USB SERIAL] Successfully connected to {SERIAL_PORT}")
except Exception as e:
    print(f"[USB SERIAL WARNING] Port {SERIAL_PORT} unavailable: {e}")

# Global System State
demo_active = False
manual_fan_override = 0
simulation_step = 0
latest_actuation = {"buzzer_gas": 0, "buzzer_swell": 0, "relay_fan": 0}
manual_actuation_override = None

# Hardware Sensor Reference & Storage
BASELINE_US1_CM = 10.22
live_us1_raw_cm = 10.22
live_gas_raw = 15.0
us1_clean_cm = 10.22
prev_swell_mm = 0.0

# Regex Patterns for Serial Parsing
pattern_us1 = re.compile(
    r"US1(?:\s*\([^)]*\))?:\s*([-?\d\.]+)\s*cm", re.IGNORECASE)
pattern_gas = re.compile(r"(?:MQ8|GAS)_?1?:\s*([-?\d\.]+)", re.IGNORECASE)

# Kalman Filter State (Gas Sensor)
kf_x = 0.0
kf_p = 1.0
Q = 0.1
R = 20.0

# Isolation Forest ML Model
X_train = np.random.normal(loc=[15.0, 0.0, 0.0, 0.0, 0.001], scale=[
                           2.0, 0.1, 0.1, 0.1, 0.005], size=(200, 5))
clf = IsolationForest(contamination=0.05, random_state=42)
clf.fit(X_train)


def kalman_filter(z):
    global kf_x, kf_p
    kf_p = kf_p + Q
    K = kf_p / (kf_p + R)
    kf_x = kf_x + K * (z - kf_x)
    kf_p = (1 - K) * kf_p
    return kf_x


def set_demo_mode(active, reset_step=True):
    """Central manager to toggle simulation mode without broadcast errors."""
    global demo_active, simulation_step, manual_actuation_override
    demo_active = active
    if active and reset_step:
        simulation_step = 0
        manual_actuation_override = None
    print(
        f"[SIMULATION] Mode set to: {'ACTIVE (DEMO)' if demo_active else 'INACTIVE (LIVE)'}")
    # socketio.emit broadcasts globally by default without requiring broadcast=True
    socketio.emit('demo_status', {
                  'mode': 'DEMO' if demo_active else 'NOMINAL', 'active': demo_active})


def read_serial_thread():
    """Reads hardware serial streams cleanly without input queue latency."""
    global live_us1_raw_cm, live_gas_raw
    while True:
        if ser and ser.is_open:
            try:
                if ser.in_waiting > 150:
                    ser.reset_input_buffer()

                line = ser.readline().decode('utf-8', errors='ignore').strip()
                if line:
                    match_us1 = pattern_us1.search(line)
                    if match_us1:
                        val = float(match_us1.group(1))
                        if val > 0:
                            live_us1_raw_cm = val

                    match_gas = pattern_gas.search(line)
                    if match_gas:
                        val_gas = float(match_gas.group(1))
                        if val_gas >= 0:
                            live_gas_raw = val_gas
            except Exception:
                time.sleep(0.01)
        else:
            time.sleep(0.5)


def send_serial_commands(actuation):
    if ser and ser.is_open:
        try:
            if actuation.get("buzzer_gas", 0) == 1:
                ser.write(b"BUZZER_GAS_ON\n")
            else:
                ser.write(b"BUZZER_GAS_OFF\n")

            if actuation.get("buzzer_swell", 0) == 1:
                ser.write(b"BUZZER_SWELL_ON\n")
            else:
                ser.write(b"BUZZER_SWELL_OFF\n")
        except Exception:
            pass


def process_live_micro_swelling(raw_cm):
    """
    Two-stage low-pass filter to smooth distance tracking and velocity spikes.
    """
    global BASELINE_US1_CM, us1_clean_cm, prev_swell_mm, prev_swell_rate

    if BASELINE_US1_CM is None:
        BASELINE_US1_CM = raw_cm
        us1_clean_cm = raw_cm

    # Stage 1: Distance smoothing (alpha = 0.35)
    us1_clean_cm = (0.35 * raw_cm) + (0.65 * us1_clean_cm)
    swell_mm = max(0.0, (BASELINE_US1_CM - us1_clean_cm) * 10.0)

    # Stage 2: Velocity calculation & EMA smoothing (alpha = 0.25)
    raw_rate = max(0.0, (swell_mm - prev_swell_mm) / 0.5)
    prev_swell_mm = swell_mm

    swell_rate = (0.25 * raw_rate) + (0.75 * prev_swell_rate)
    prev_swell_rate = swell_rate

    return round(us1_clean_cm, 2), round(swell_mm, 2), round(swell_rate, 3)


def generate_telemetry():
    global simulation_step, demo_active, manual_fan_override, latest_actuation, manual_actuation_override, BASELINE_US1_CM, smooth_risk

    base_val = BASELINE_US1_CM if BASELINE_US1_CM is not None else 10.22

    if demo_active:
        simulation_step += 1
        # Thermal Runaway Failure Sequence Progression (Smoothed linear increment)
        raw_gas = 15.0 + math.pow(simulation_step * 0.18, 2.1)
        d_p1 = min(12.0, simulation_step * 0.15)  # Smooth swell escalation
        d_p2 = d_p1
        d_p3 = d_p1
        p1 = base_val - (d_p1 / 10.0)
        p2 = p1
        p3 = p1
        swell_rate = 0.02 * simulation_step
    else:
        simulation_step = 0
        raw_gas = live_gas_raw
        clean_cm, swell_mm, swell_rate = process_live_micro_swelling(
            live_us1_raw_cm)

        d_p1 = swell_mm
        d_p2 = swell_mm
        d_p3 = swell_mm
        p1 = clean_cm
        p2 = clean_cm
        p3 = clean_cm

    kf_gas = kalman_filter(raw_gas)
    max_swell_mm = max(d_p1, d_p2, d_p3)
    probe_spread = max_swell_mm - min(d_p1, d_p2, d_p3)

    # --- Smooth Risk Weighting Logic ---
    gas_risk = min(100.0, (kf_gas / 150.0) * 100.0)

    # Displacement Risk: 10mm physical swell = 100% risk
    swell_disp_risk = min(100.0, (max_swell_mm / 10.0) * 100.0)

    # Velocity Risk: Re-scaled to 1.50 mm/s baseline (prevents instant 100% spikes)
    swell_rate_risk = min(100.0, (swell_rate / 1.50) * 100.0)

    # Balanced Swell Composite (80% magnitude, 20% rate for smooth progression)
    swell_risk = (0.80 * swell_disp_risk) + (0.20 * swell_rate_risk)

    trend_risk = min(100.0, (kf_gas * 0.4))

    # Continuous correlation boost instead of a hard step-function jump
    boost = min(20.0, max(0.0, (gas_risk + swell_risk - 40.0) * 0.25))

    target_risk = min(100.0, (0.45 * gas_risk) +
                      (0.45 * swell_risk) + (0.10 * trend_risk) + boost)

    # Risk Score Slew Rate Filter (Saves gauge from jumping instantly 5 -> 45)
    smooth_risk = (0.25 * target_risk) + (0.75 * smooth_risk)

    # --- Strict Safety Threshold Overrides ---
    if max_swell_mm >= 10.0 or smooth_risk >= 70.0:
        threat_level = "CRITICAL"
    elif max_swell_mm >= 5.0 or smooth_risk >= 40.0:
        threat_level = "CAUTION"
    else:
        threat_level = "NOMINAL"

    mode = "DEMO" if demo_active else threat_level

    # Machine Learning Inference
    features = np.array([[kf_gas, d_p1, d_p2, d_p3, swell_rate]])
    anomaly_score = float(-clf.score_samples(features)[0])
    ml_pct = min(100.0, max(0.0, (anomaly_score - 0.35) * 200.0))

    # Actuation Hardware Logic
    relay_fan = 1 if (manual_fan_override ==
                      1 or threat_level == "CRITICAL") else 0
    buzzer_gas = 1 if (threat_level in ["CAUTION", "CRITICAL"]) else 0
    buzzer_swell = 1 if (threat_level == "CRITICAL") else 0

    actuation_state = {
        "relay_fan": relay_fan,
        "buzzer_gas": buzzer_gas,
        "buzzer_swell": buzzer_swell
    }

    if manual_actuation_override is not None:
        actuation_state = manual_actuation_override
    else:
        latest_actuation = actuation_state

    send_serial_commands(actuation_state)

    return {
        "hardware_source": "DEMO_SIMULATOR" if demo_active else "LIVE_USB_SERIAL",
        "mode": mode,
        "risk_score": round(smooth_risk, 2),
        "risk_breakdown": {
            "gas_risk": round(gas_risk, 2),
            "swell_risk": round(swell_risk, 2),
            "trend_risk": round(trend_risk, 2),
            "correlation_boost": round(boost, 2),
            "threat_level": threat_level
        },
        "ml_anomaly_score": round(ml_pct, 2),
        "r0_ch1": 10500,
        "r0_ch2": 10480,
        "mq8_1": {
            "ppm_raw": round(raw_gas, 2),
            "ppm_kf": round(kf_gas, 2),
            "vout": round(0.4 + (kf_gas * 0.002), 2)
        },
        "mq8_2": {
            "ppm_raw": round(raw_gas * 0.98, 2),
            "ppm_kf": round(kf_gas * 0.98, 2),
            "vout": round(0.39 + (kf_gas * 0.002), 2)
        },
        "ultrasonic": {
            "probe1_delta_mm": round(d_p1, 2),
            "probe2_delta_mm": round(d_p2, 2),
            "probe3_delta_mm": round(d_p3, 2),
            "probe1_filtered_mm": round(p1, 2),
            "probe2_filtered_mm": round(p2, 2),
            "probe3_filtered_mm": round(p3, 2),
            "swell_rate_mm_s": round(swell_rate, 3),
            "probe_spread_mm": round(probe_spread, 2)
        },
        "actuation": actuation_state
    }


def telemetry_thread():
    while True:
        packet = generate_telemetry()
        socketio.emit('sensor_update', packet)
        time.sleep(0.5)


# --- ROUTING & SIMULATION ENDPOINTS ---

@app.route('/')
def index():
    return send_from_directory('.', 'index.html')


@app.route('/<path:path>')
def static_files(path):
    return send_from_directory('.', path)


@app.route('/api/demo', methods=['GET', 'POST'])
@app.route('/api/simulation', methods=['GET', 'POST'])
def api_simulation_control():
    if request.method == 'POST':
        data = request.get_json() or {}
        action = str(data.get('action', '')).lower()
        if action in ['start', 'run', 'enable', 'true', '1']:
            set_demo_mode(True)
        elif action in ['stop', 'disable', 'false', '0']:
            set_demo_mode(False)
        elif action == 'toggle':
            set_demo_mode(not demo_active)
        else:
            set_demo_mode(True)
    return jsonify({"status": "success", "demo_active": demo_active, "simulation_step": simulation_step})


@app.route('/api/recalibrate', methods=['POST'])
def recalibrate():
    global BASELINE_US1_CM, us1_clean_cm
    BASELINE_US1_CM = us1_clean_cm
    return jsonify({"status": "success", "message": f"Baseline zero set to {BASELINE_US1_CM:.2f} cm."})


# --- WEBSOCKET EVENT HANDLERS ---

@socketio.on('demo_control')
def handle_demo_control(data):
    if isinstance(data, dict):
        action = str(data.get('action', '')).lower()
        if action in ['start', 'run', 'enable']:
            set_demo_mode(True)
        elif action in ['stop', 'disable']:
            set_demo_mode(False)
        elif action == 'toggle':
            set_demo_mode(not demo_active)
    else:
        set_demo_mode(bool(data))


@socketio.on('run_simulation')
@socketio.on('start_demo')
@socketio.on('start_simulation')
def handle_run_simulation(data=None):
    set_demo_mode(True)


@socketio.on('stop_demo')
@socketio.on('stop_simulation')
def handle_stop_simulation(data=None):
    set_demo_mode(False)


@socketio.on('toggle_demo')
def handle_toggle_demo(data=None):
    set_demo_mode(not demo_active)


if __name__ == '__main__':
    serial_worker = threading.Thread(target=read_serial_thread, daemon=True)
    serial_worker.start()

    telemetry_worker = threading.Thread(target=telemetry_thread, daemon=True)
    telemetry_worker.start()

    print("[SERVER READY] Running on http://localhost:5000")
    socketio.run(app, host='0.0.0.0', port=5000, debug=False)
