(function () {
    'use strict';

    const MAX_BUFFER_POINTS = 120;

    // --- State Variables ---
    let socket = null;
    let gasChart = null;
    let ultrasonicChart = null;
    let isConnected = false;
    let isDemoActive = false;
    let audioEnabled = false;
    let lastAudioBeepTs = 0;
    let currentFilter = 'all';
    let audioCtx = null;

    // Data Buffers
    const timeLabels = [];
    const rawGasData = [];
    const kfGasData = [];
    const probe1Data = [];
    const probe2Data = [];
    const probe3Data = [];
    const sparklineBuffer = [];
    const logAuditStore = [];

    window.addEventListener('DOMContentLoaded', () => {
        initCharts();
        initSocket();
        initControls();
        initNavigation();
        initLogFilter();
        drawThreatGauge(null, 'CALIBRATING');
        addLogEntry('system', 'SYSTEM', 'Multi-Modal Engine initialized. Listening on 2 Hz telemetry stream...');
    });

    // --- Utility Functions ---
    function setElemText(id, text) {
        const el = document.getElementById(id);
        if (el) el.textContent = text;
    }

    function setElemWidth(id, width) {
        const el = document.getElementById(id);
        if (el) el.style.width = width;
    }

    function setSafeQueryText(selector, text) {
        const el = document.querySelector(selector);
        if (el) el.textContent = text;
    }

    // --- Chart Initializations ---
    function initCharts() {
        const commonGridStyle = { color: '#DFD9CC', borderColor: '#D5CFC2', tickColor: '#D5CFC2' };

        const ctxGas = document.getElementById('chart-gas-telemetry');
        if (ctxGas && typeof Chart !== 'undefined') {
            gasChart = new Chart(ctxGas.getContext('2d'), {
                type: 'line',
                data: {
                    labels: timeLabels,
                    datasets: [
                        { label: 'Raw Sensor 1', data: rawGasData, borderColor: '#78716C', borderWidth: 1.5, pointRadius: 0, tension: 0.1 },
                        { label: 'Kalman Filtered', data: kfGasData, borderColor: '#2D5A43', backgroundColor: 'rgba(45, 90, 67, 0.08)', fill: true, borderWidth: 2.2, pointRadius: 0, tension: 0.2 }
                    ]
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    animation: false,
                    plugins: { legend: { display: false } },
                    scales: {
                        x: { grid: commonGridStyle, ticks: { color: '#757168', font: { family: "'IBM Plex Sans', monospace", size: 10 }, maxTicksLimit: 8 } },
                        y: { grid: commonGridStyle, ticks: { color: '#47443E', font: { family: "'IBM Plex Sans', monospace", size: 10 } }, suggestedMin: 0, suggestedMax: 100 }
                    }
                }
            });
        }

        const ctxUs = document.getElementById('chart-ultrasonic-telemetry');
        if (ctxUs && typeof Chart !== 'undefined') {
            ultrasonicChart = new Chart(ctxUs.getContext('2d'), {
                type: 'line',
                data: {
                    labels: timeLabels,
                    datasets: [
                        { label: 'Probe 1', data: probe1Data, borderColor: '#1F6B75', borderWidth: 1.8, pointRadius: 0, tension: 0.1 },
                        { label: 'Probe 2', data: probe2Data, borderColor: '#B45309', borderWidth: 1.8, pointRadius: 0, tension: 0.1 },
                        { label: 'Probe 3', data: probe3Data, borderColor: '#2D5A43', borderWidth: 1.8, pointRadius: 0, tension: 0.1 }
                    ]
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    animation: false,
                    plugins: { legend: { display: false } },
                    scales: {
                        x: { grid: commonGridStyle, ticks: { color: '#757168', font: { family: "'IBM Plex Sans', monospace", size: 10 }, maxTicksLimit: 8 } },
                        y: { grid: commonGridStyle, ticks: { color: '#47443E', font: { family: "'IBM Plex Sans', monospace", size: 10 } }, suggestedMin: 115, suggestedMax: 125 }
                    }
                }
            });
        }
    }

    // --- Socket Initialization ---
    function initSocket() {
        if (typeof io === 'undefined') {
            addLogEntry('alert', 'COMM', 'Socket.io client library failed to load.');
            return;
        }

        // Adjust endpoint if needed
        socket = io();

        socket.on('connect', () => {
            isConnected = true;
            updateConnectionBadge('LINK: LIVE TELEMETRY', 'online');
            setSafeQueryText('.link-status', 'LINK: CONNECTED');
            addLogEntry('info', 'COMM', 'WebSocket connection established with telemetry engine.');
        });

        socket.on('disconnect', () => {
            isConnected = false;
            updateConnectionBadge('LINK: OFFLINE', 'offline');
            setSafeQueryText('.link-status', 'LINK: DISCONNECTED');
            addLogEntry('alert', 'COMM', 'Communication link disconnected.');
        });

        socket.on('connection_ack', (data) => {
            if (data && data.ml_ready) {
                addLogEntry('info', 'ML', 'Isolation Forest anomaly detection online.');
            }
        });

        socket.on('sensor_update', (payload) => {
            if (!payload) return;
            handleTelemetryUpdate(payload);
        });

        socket.on('telemetry_update', (data) => {
            if (!data) return;
            handleLegacyTelemetry(data);
        });

        socket.on('fan_status', (data) => {
            if (data) {
                syncFanToggleState(data.state === 1);
                addLogEntry('info', 'RELAY', `Exhaust Fan Relay: ${data.state === 1 ? 'ENGAGED' : 'IDLE'}`);
            }
        });

        socket.on('demo_status', (data) => {
            if (data) {
                isDemoActive = (data.mode === 'DEMO');
                updateDemoButtons(isDemoActive);
            }
        });
    }

    // --- Telemetry Handlers ---
    function handleTelemetryUpdate(data) {
        const mode = data.mode || 'CALIBRATING';
        const riskScore = data.risk_score !== undefined ? data.risk_score : 0;
        const breakdown = data.risk_breakdown || {};
        const threatLevel = breakdown.threat_level || mode;
        const mlAnomaly = data.ml_anomaly_score;

        if (data.hardware_source === 'VIRTUAL_SIMULATOR') {
            updateConnectionBadge('LINK: SIMULATOR', 'simulated');
        } else {
            updateConnectionBadge('LINK: LIVE ESP32', 'online');
        }

        applyDynamicTheme(mode, threatLevel, riskScore);

        // Safe Selectors & Updates
        setSafeQueryText('.overall-state', mode);
        setElemText('overall-state', mode);

        if (mlAnomaly !== undefined && mlAnomaly !== null) {
            const mlStr = `${mlAnomaly.toFixed(1)}%`;
            setSafeQueryText('.anomaly-score', mlStr);
            setSafeQueryText('#anomaly-score', mlStr);
            setElemText('val-ml-anomaly', mlStr);
            setElemText('val-summary-ml', mlStr);
        }

        const riskStr = `${riskScore.toFixed(1)}%`;
        setSafeQueryText('.threat-gauge-val', riskStr);
        setSafeQueryText('#risk-score', riskStr);

        if (data.risk_breakdown) {
            if (breakdown.gas_risk !== undefined) setSafeQueryText('.gas-weight', `${breakdown.gas_risk.toFixed(1)}%`);
            if (breakdown.swell_risk !== undefined) setSafeQueryText('.swell-weight', `${breakdown.swell_risk.toFixed(1)}%`);
            if (breakdown.trend_risk !== undefined) setSafeQueryText('.trend-weight', `${breakdown.trend_risk.toFixed(1)}%`);
        }

        const mq1 = data.mq8_1 || {};
        const mq2 = data.mq8_2 || {};
        
        if (mq1.ppm_kf !== undefined) setSafeQueryText('.mq8-1-ppm', `${mq1.ppm_kf.toFixed(1)} PPM`);
        setElemText('val-mq8-1-ppm', mq1.ppm_kf !== undefined ? mq1.ppm_kf.toFixed(1) : '--');
        setElemText('val-mq8-1-vout', mq1.vout !== undefined ? `${mq1.vout.toFixed(2)} V` : '-- V');
        setElemText('val-mq8-2-ppm', mq2.ppm_kf !== undefined ? mq2.ppm_kf.toFixed(1) : '--');
        setElemText('val-mq8-2-vout', mq2.vout !== undefined ? `${mq2.vout.toFixed(2)} V` : '-- V');

        setElemText('val-r0-1', data.r0_ch1 ? `${data.r0_ch1} Ω` : '-- Ω');
        setElemText('val-r0-2', data.r0_ch2 ? `${data.r0_ch2} Ω` : '-- Ω');
        setElemText('val-summary-r0', (data.r0_ch1 && mode !== 'CALIBRATING') ? 'LOCKED (STABLE)' : 'CALIBRATING...');

        if (mq1.ppm_kf !== undefined) {
            sparklineBuffer.push(mq1.ppm_kf);
            if (sparklineBuffer.length > 50) sparklineBuffer.shift();
            drawSparkline(sparklineBuffer);
        }

        const us = data.ultrasonic || {};
        if (us.swell_rate_mm_s !== undefined) setSafeQueryText('.swell-rate', `${us.swell_rate_mm_s.toFixed(3)} mm/s`);
        
        setElemText('val-disp-1', (us.probe1_delta_mm || 0).toFixed(1));
        setElemText('val-disp-2', (us.probe2_delta_mm || 0).toFixed(1));
        setElemText('val-disp-3', (us.probe3_delta_mm || 0).toFixed(1));

        setElemWidth('bar-probe-1', Math.min(100, (us.probe1_delta_mm || 0) * 20) + '%');
        setElemWidth('bar-probe-2', Math.min(100, (us.probe2_delta_mm || 0) * 20) + '%');
        setElemWidth('bar-probe-3', Math.min(100, (us.probe3_delta_mm || 0) * 20) + '%');

        setElemText('val-swell-rate', (us.swell_rate_mm_s || 0).toFixed(3));
        setElemText('val-probe-spread', (us.probe_spread_mm || 0).toFixed(2));

        const act = data.actuation || {};
        const fanActive = act.relay_fan === 1;
        const pillFan = document.getElementById('pill-relay-fan');
        
        if (pillFan) {
            pillFan.textContent = fanActive ? 'ACTIVE (ON)' : 'IDLE (OFF)';
            pillFan.className = 'status-pill ' + (fanActive ? 'pill-active' : 'pill-idle');
        }
        setElemText('val-summary-actuation', fanActive ? 'FAN ACTIVE (ON)' : 'IDLE (OFF)');

        const pillGasBuzzer = document.getElementById('pill-buzzer-gas');
        if (pillGasBuzzer) {
            pillGasBuzzer.textContent = act.buzzer_gas === 1 ? 'PULSING' : 'MUTED';
            pillGasBuzzer.className = 'status-pill ' + (act.buzzer_gas === 1 ? 'pill-red' : 'pill-idle');
        }

        const pillSwellBuzzer = document.getElementById('pill-buzzer-swell');
        if (pillSwellBuzzer) {
            pillSwellBuzzer.textContent = act.buzzer_swell === 1 ? 'CONTINUOUS' : 'MUTED';
            pillSwellBuzzer.className = 'status-pill ' + (act.buzzer_swell === 1 ? 'pill-red' : 'pill-idle');
        }

        const pillRyg = document.getElementById('pill-ryg-state');
        if (pillRyg) {
            if (threatLevel === 'CRITICAL' || isDemoActive) {
                pillRyg.textContent = 'HAZARD (RED)';
                pillRyg.className = 'status-pill pill-red';
            } else if (threatLevel === 'CAUTION') {
                pillRyg.textContent = 'WARNING (YELLOW)';
                pillRyg.className = 'status-pill pill-yellow';
            } else {
                pillRyg.textContent = 'NORMAL (GREEN)';
                pillRyg.className = 'status-pill pill-green';
            }
        }

        drawThreatGauge(riskScore, mode);
        updateBreakdownFactors(breakdown);

        const tsLabel = new Date().toLocaleTimeString('en-US', { hour12: false, minute: '2-digit', second: '2-digit' });
        appendChartData(
            tsLabel,
            mq1.ppm_raw || 0,
            mq1.ppm_kf || 0,
            us.probe1_filtered_mm || 120,
            us.probe2_filtered_mm || 120,
            us.probe3_filtered_mm || 120
        );

        if (audioEnabled) {
            handleAudioAlerts(act.buzzer_gas === 1, act.buzzer_swell === 1);
        }
    }

    function handleLegacyTelemetry(data) {
        if (data.risk_score !== undefined) {
            setSafeQueryText('.speedometer-value', `${data.risk_score.toFixed(1)}%`);
        }
        if (data.h2_gas !== undefined) setSafeQueryText('.h2-conc', `${data.h2_gas}%`);
        if (data.swelling !== undefined) setSafeQueryText('.swell-vel', `${data.swelling}%`);
        if (data.gas_deriv !== undefined) setSafeQueryText('.gas-deriv', `${data.gas_deriv}%`);
        if (data.anomaly_score !== undefined) setSafeQueryText('.anomaly-score', `${data.anomaly_score}%`);
    }

    // --- UI Dynamic Rendering & Theme ---
    function applyDynamicTheme(mode, threatLevel, riskScore) {
        const body = document.body;
        const banner = document.getElementById('alert-banner');
        const bannerText = document.getElementById('alert-banner-text');
        const modeText = document.getElementById('mode-badge-text');
        const summaryStatus = document.getElementById('val-summary-status');
        const summarySub = document.getElementById('val-summary-sub');

        if (modeText) modeText.textContent = mode;

        if (mode === 'CALIBRATING') {
            body.className = 'theme-calibrating';
            if (banner) banner.classList.add('hidden');
            if (summaryStatus) { summaryStatus.textContent = 'CALIBRATING'; summaryStatus.className = 'val-text text-sage'; }
            if (summarySub) summarySub.textContent = 'Sensors stabilizing in clean reference air';
            return;
        }

        if (threatLevel === 'CRITICAL') {
            body.className = 'theme-critical';
            if (banner) { banner.className = 'alert-banner'; banner.classList.remove('hidden'); }
            if (bannerText) bannerText.textContent = `CRITICAL THERMAL RUNAWAY HAZARD (${(riskScore || 0).toFixed(0)}%) - EXHAUST FAN ENGAGED`;
            if (summaryStatus) { summaryStatus.textContent = 'CRITICAL ALERT'; summaryStatus.className = 'val-text text-critical'; }
            if (summarySub) summarySub.textContent = 'Runaway hazard detected - Cooling relay tripped';
        } else if (threatLevel === 'CAUTION') {
            body.className = 'theme-caution';
            if (banner) { banner.className = 'alert-banner caution'; banner.classList.remove('hidden'); }
            if (bannerText) bannerText.textContent = `CAUTION: ELEVATED GAS / EXPANSION ACCELERATION (${(riskScore || 0).toFixed(0)}%)`;
            if (summaryStatus) { summaryStatus.textContent = 'CAUTION HAZARD'; summaryStatus.className = 'val-text text-amber'; }
            if (summarySub) summarySub.textContent = 'Pre-venting / cell kinetic acceleration increasing';
        } else {
            body.className = 'theme-nominal';
            if (banner) banner.classList.add('hidden');
            if (summaryStatus) { summaryStatus.textContent = 'NOMINAL'; summaryStatus.className = 'val-text text-sage'; }
            if (summarySub) summarySub.textContent = 'Pack parameters within safe operating limits';
        }
    }

    function updateBreakdownFactors(b) {
        const gasVal = b.gas_risk || 0;
        const swellVal = b.swell_risk || 0;
        const trendVal = b.trend_risk || 0;
        const boostVal = b.correlation_boost || 0;

        setElemText('val-gas-risk', `${gasVal.toFixed(0)}%`);
        setElemWidth('bar-gas-risk', `${Math.min(100, gasVal)}%`);

        setElemText('val-swell-risk', `${swellVal.toFixed(0)}%`);
        setElemWidth('bar-swell-risk', `${Math.min(100, swellVal)}%`);

        setElemText('val-trend-risk', `${trendVal.toFixed(0)}%`);
        setElemWidth('bar-trend-risk', `${Math.min(100, trendVal)}%`);

        const boostElem = document.getElementById('val-correlation-boost');
        const boostBar = document.getElementById('bar-correlation-boost');
        if (boostElem && boostBar) {
            if (boostVal > 0) {
                boostElem.textContent = '+20% ACTIVE';
                boostElem.style.color = '#991B1B';
                boostBar.style.width = '100%';
                boostBar.style.backgroundColor = '#991B1B';
            } else {
                boostElem.textContent = 'INACTIVE';
                boostElem.style.color = '#757168';
                boostBar.style.width = '0%';
                boostBar.style.backgroundColor = '#757168';
            }
        }
    }

    function drawThreatGauge(score, mode) {
        const canvas = document.getElementById('threat-gauge');
        if (!canvas) return;
        const ctx = canvas.getContext('2d');
        const w = canvas.width;
        const h = canvas.height;
        const cx = w / 2;
        const cy = h - 35;
        const radius = 150;
        const lineWidth = 24;

        ctx.clearRect(0, 0, w, h);

        ctx.beginPath();
        ctx.arc(cx, cy, radius, Math.PI, 2 * Math.PI, false);
        ctx.lineWidth = lineWidth;
        ctx.strokeStyle = '#DFD9CC';
        ctx.lineCap = 'round';
        ctx.stroke();

        const gaugePercent = document.getElementById('gauge-percent');
        const statusLabel = document.getElementById('threat-status-label');

        let activeColor = '#2D5A43';
        let statusText = 'NOMINAL';
        let valText = '0.0%';

        if (mode === 'CALIBRATING' || score === null) {
            activeColor = '#57534E';
            statusText = 'CALIBRATING';
            valText = '0.0%';
        } else {
            valText = `${score.toFixed(1)}%`;
            if (score >= 70.0) {
                activeColor = '#991B1B';
                statusText = 'CRITICAL ALERT';
            } else if (score >= 40.0) {
                activeColor = '#B45309';
                statusText = 'CAUTION HAZARD';
            } else {
                activeColor = '#2D5A43';
                statusText = 'NOMINAL';
            }
        }

        ctx.beginPath();
        ctx.arc(cx - radius, cy, lineWidth / 2, 0, 2 * Math.PI);
        ctx.fillStyle = activeColor;
        ctx.fill();

        if (mode !== 'CALIBRATING' && score !== null && score > 0) {
            const fillAngle = Math.PI + (Math.min(100, Math.max(0, score)) / 100.0) * Math.PI;
            ctx.beginPath();
            ctx.arc(cx, cy, radius, Math.PI, fillAngle, false);
            ctx.lineWidth = lineWidth;
            ctx.strokeStyle = activeColor;
            ctx.lineCap = 'round';
            ctx.stroke();
        }

        if (gaugePercent) { gaugePercent.textContent = valText; gaugePercent.style.color = activeColor; }
        if (statusLabel) { statusLabel.textContent = statusText; statusLabel.style.color = activeColor; }
    }

    function drawSparkline(buffer) {
        const canvas = document.getElementById('gas-sparkline');
        if (!canvas || buffer.length < 2) return;
        const ctx = canvas.getContext('2d');
        const w = canvas.width;
        const h = canvas.height;

        ctx.clearRect(0, 0, w, h);

        const min = Math.min(...buffer) - 5;
        const max = Math.max(...buffer) + 5;
        const range = max - min || 1;

        ctx.beginPath();
        ctx.strokeStyle = '#2D5A43';
        ctx.lineWidth = 1.8;
        ctx.lineJoin = 'round';

        for (let i = 0; i < buffer.length; i++) {
            const x = (i / (buffer.length - 1)) * w;
            const y = h - ((buffer[i] - min) / range) * (h - 8) - 4;
            if (i === 0) ctx.moveTo(x, y);
            else ctx.lineTo(x, y);
        }
        ctx.stroke();
    }

    function appendChartData(label, rawGas, kfGas, p1, p2, p3) {
        timeLabels.push(label);
        rawGasData.push(rawGas);
        kfGasData.push(kfGas);
        probe1Data.push(p1);
        probe2Data.push(p2);
        probe3Data.push(p3);

        if (timeLabels.length > MAX_BUFFER_POINTS) {
            timeLabels.shift(); rawGasData.shift(); kfGasData.shift();
            probe1Data.shift(); probe2Data.shift(); probe3Data.shift();
        }

        if (gasChart) gasChart.update('none');
        if (ultrasonicChart) ultrasonicChart.update('none');
    }

    // --- User Actions & Controls ---
    function initControls() {
        const fanToggle = document.getElementById('fan-override-toggle');
        const mobileFanToggle = document.getElementById('mobile-fan-toggle');

        function onFanChange(checked) {
            if (socket) socket.emit('override_fan', { state: checked ? 1 : 0 });
            syncFanToggleState(checked);
            addLogEntry('info', 'USER', `Fan Relay Override: ${checked ? 'ACTIVE' : 'AUTOMATIC'}`);
        }

        if (fanToggle) fanToggle.addEventListener('change', (e) => onFanChange(e.target.checked));
        if (mobileFanToggle) mobileFanToggle.addEventListener('change', (e) => onFanChange(e.target.checked));

        const demoNavBtn = document.getElementById('btn-demo-toggle');
        const demoPanelBtn = document.getElementById('btn-demo-panel-toggle');

        function onDemoClick() {
            const action = isDemoActive ? 'stop' : 'start';
            if (socket) socket.emit('demo_control', { action: action });
            isDemoActive = !isDemoActive;
            updateDemoButtons(isDemoActive);
            addLogEntry('warn', 'DEMO', `Simulation state change requested: ${action.toUpperCase()}`);
        }

        if (demoNavBtn) demoNavBtn.addEventListener('click', onDemoClick);
        if (demoPanelBtn) demoPanelBtn.addEventListener('click', onDemoClick);

        const recalNavBtn = document.getElementById('btn-recalibrate');
        const recalPanelBtn = document.getElementById('btn-recalibrate-panel');

        function onRecalibrateClick() {
            fetch('/api/recalibrate', { method: 'POST' })
                .then(res => res.json())
                .then(() => addLogEntry('warn', 'CALIB', 'R0 baseline recalibration triggered.'))
                .catch(err => addLogEntry('alert', 'CALIB', 'Recalibration error: ' + err));
        }

        if (recalNavBtn) recalNavBtn.addEventListener('click', onRecalibrateClick);
        if (recalPanelBtn) recalPanelBtn.addEventListener('click', onRecalibrateClick);

        const audioNavBtn = document.getElementById('btn-audio-toggle');
        const audioPanelBtn = document.getElementById('btn-audio-panel-toggle');

        function onAudioToggle() {
            audioEnabled = !audioEnabled;
            updateAudioUI(audioEnabled);
            if (audioEnabled && !audioCtx) {
                audioCtx = new (window.AudioContext || window.webkitAudioContext)();
            }
            addLogEntry('info', 'AUDIO', `Audible alarms ${audioEnabled ? 'UNMUTED' : 'MUTED'}`);
        }

        if (audioNavBtn) audioNavBtn.addEventListener('click', onAudioToggle);
        if (audioPanelBtn) audioPanelBtn.addEventListener('click', onAudioToggle);

        const clearBtn = document.getElementById('btn-clear-log');
        if (clearBtn) {
            clearBtn.addEventListener('click', () => {
                const term = document.getElementById('event-log-terminal');
                if (term) term.innerHTML = '';
                addLogEntry('info', 'LOG', 'System event log cleared.');
            });
        }

        const dismissBtn = document.getElementById('btn-alert-dismiss');
        if (dismissBtn) {
            dismissBtn.addEventListener('click', () => {
                const banner = document.getElementById('alert-banner');
                if (banner) banner.classList.add('hidden');
            });
        }
    }

    function syncFanToggleState(checked) {
        const t1 = document.getElementById('fan-override-toggle');
        const t2 = document.getElementById('mobile-fan-toggle');
        const label = document.getElementById('fan-override-label');
        if (t1) t1.checked = checked;
        if (t2) t2.checked = checked;
        if (label) label.textContent = checked ? 'MODE: MANUAL OVERRIDE (ON)' : 'MODE: AUTOMATIC SAFETY';
    }

    function updateDemoButtons(active) {
        const navBtn = document.getElementById('btn-demo-toggle');
        const panelBtn = document.getElementById('btn-demo-panel-toggle');
        const navText = document.getElementById('demo-btn-text');

        if (active) {
            if (navBtn) navBtn.classList.add('active');
            if (panelBtn) panelBtn.classList.add('btn-demo', 'active');
            if (navText) navText.textContent = 'STOP SIMULATION';
            if (panelBtn) panelBtn.textContent = 'STOP SIMULATION DEMO';
        } else {
            if (navBtn) navBtn.classList.remove('active');
            if (panelBtn) panelBtn.classList.remove('btn-demo', 'active');
            if (navText) navText.textContent = 'RUN SIMULATION';
            if (panelBtn) panelBtn.textContent = 'START SIMULATION DEMO';
        }
    }

    function updateAudioUI(enabled) {
        const label1 = document.getElementById('audio-btn-label');
        const text2 = document.getElementById('panel-audio-text');
        if (label1) label1.textContent = enabled ? 'AUDIO: ACTIVE' : 'AUDIO: MUTED';
        if (text2) text2.textContent = enabled ? 'MUTE AUDIO ALARMS' : 'UNMUTE AUDIO ALARMS';
    }

    function updateConnectionBadge(label, stateClass) {
        const text = document.getElementById('hw-source-text');
        if (text) text.textContent = label;
    }

    function initNavigation() {
        const toggleBtn = document.getElementById('mobile-menu-toggle');
        const drawer = document.getElementById('mobile-drawer');

        if (toggleBtn && drawer) {
            toggleBtn.addEventListener('click', () => {
                const isOpen = drawer.classList.contains('open');
                drawer.classList.toggle('open', !isOpen);
                toggleBtn.setAttribute('aria-expanded', !isOpen);
            });
        }
    }

    function initLogFilter() {
        const filterBtns = document.querySelectorAll('.filter-btn');
        filterBtns.forEach(btn => {
            btn.addEventListener('click', () => {
                filterBtns.forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                currentFilter = btn.getAttribute('data-filter');
                applyLogFilter();
            });
        });
    }

    function applyLogFilter() {
        const entries = document.querySelectorAll('#event-log-terminal .ledger-entry');
        entries.forEach(entry => {
            const type = entry.getAttribute('data-type');
            entry.classList.toggle('hidden-by-filter', !(currentFilter === 'all' || currentFilter === type));
        });
    }

    // --- Audio Feedback Engine ---
    function handleAudioAlerts(gasAlert, swellAlert) {
        if (!audioCtx) return;
        const now = Date.now();
        if (swellAlert) {
            playTone(720, 0.25, 'sawtooth');
        } else if (gasAlert && (now - lastAudioBeepTs > 400)) {
            lastAudioBeepTs = now;
            playTone(480, 0.15, 'sine');
        }
    }

    function playTone(freq, durationSec, type = 'sine') {
        try {
            if (audioCtx.state === 'suspended') audioCtx.resume();
            const osc = audioCtx.createOscillator();
            const gain = audioCtx.createGain();
            osc.type = type;
            osc.frequency.setValueAtTime(freq, audioCtx.currentTime);
            gain.gain.setValueAtTime(0.06, audioCtx.currentTime);
            gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + durationSec);
            osc.connect(gain);
            gain.connect(audioCtx.destination);
            osc.start();
            osc.stop(audioCtx.currentTime + durationSec);
        } catch (e) {
            // Audio play prevented or unavailable
        }
    }

    // --- Logging & Audit Engine ---
    function addLogEntry(type, source, message) {
        const term = document.getElementById('event-log-terminal');
        const timeStr = new Date().toLocaleTimeString('en-US', { hour12: false });

        logAuditStore.push({ timestamp: timeStr, type: type, source: source, message: message });

        if (!term) return;

        const entry = document.createElement('div');
        entry.className = `ledger-entry ${type}`;
        entry.setAttribute('data-type', type);

        if (currentFilter !== 'all' && currentFilter !== type) {
            entry.classList.add('hidden-by-filter');
        }

        entry.innerHTML = `
            <span class="log-time">[${timeStr}]</span>
            <span class="log-source">${source}:</span>
            <span class="log-msg">${message}</span>
        `;

        term.appendChild(entry);
        while (term.children.length > 150) term.removeChild(term.firstChild);

        const autoscroll = document.getElementById('autoscroll-checkbox');
        if (autoscroll && autoscroll.checked) term.scrollTop = term.scrollHeight;
    }

})();