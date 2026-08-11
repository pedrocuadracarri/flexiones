import { FilesetResolver, PoseLandmarker } from "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/vision_bundle.mjs";

const L = { shoulder: 11, elbow: 13, wrist: 15, hip: 23, knee: 25, ankle: 27 };
const R = { shoulder: 12, elbow: 14, wrist: 16, hip: 24, knee: 26, ankle: 28 };
const CONNECTIONS = [
  [11, 13], [13, 15], [12, 14], [14, 16], [11, 12],
  [11, 23], [12, 24], [23, 24], [23, 25], [24, 26], [25, 27], [26, 28],
];

const GOOD_DEPTH = 90;    // codo a 90° o menos = profundidad correcta
const MIN_VISIBILITY = 0.6;
const CAL_SECONDS = 3;

// Umbrales personales, medidos en la calibración (valores por defecto de reserva)
const cal = {
  upElbow: 170,      // extensión real de tu codo arriba
  neutralBody: 180,  // tu línea hombro-cadera-rodilla neutra
  downAngle: 100,    // entra en fase de bajada
  upAngle: 155,      // vuelve a arriba
  samples: [],
  startedAt: 0,
};

let stage = "framing"; // framing → calibrating → counting

const el = {
  video: document.getElementById("video"),
  canvas: document.getElementById("canvas"),
  status: document.getElementById("status"),
  reps: document.getElementById("reps"),
  elbowVal: document.getElementById("elbowVal"),
  bodyVal: document.getElementById("bodyVal"),
  phase: document.getElementById("phase"),
  feedback: document.getElementById("feedback"),
  startBtn: document.getElementById("startBtn"),
  stopBtn: document.getElementById("stopBtn"),
  switchBtn: document.getElementById("switchBtn"),
  recalBtn: document.getElementById("recalBtn"),
  voice: document.getElementById("voice"),
  historyBody: document.querySelector("#historyTable tbody"),
  clearHistory: document.getElementById("clearHistory"),
};
const ctx = el.canvas.getContext("2d");

let landmarker = null;
let stream = null;
let running = false;
let lastTs = -1;

const session = {
  reps: 0,
  scores: [],
  issues: {},
  startedAt: 0,
};

const rep = {
  phase: "up",
  minElbow: 180,
  worstBodyDev: 0,
  sagSign: 0,
  startedAt: 0,
  descending: false,
  cued: false,
};

let smoothElbow = 180;
let framedSince = 0;

// --- geometría ---------------------------------------------------------

function angle(a, b, c) {
  const abx = a.x - b.x, aby = a.y - b.y;
  const cbx = c.x - b.x, cby = c.y - b.y;
  const dot = abx * cbx + aby * cby;
  const mag = Math.hypot(abx, aby) * Math.hypot(cbx, cby);
  if (mag === 0) return 180;
  return Math.acos(Math.max(-1, Math.min(1, dot / mag))) * 180 / Math.PI;
}

function visible(lm, ...idx) {
  return idx.every(i => (lm[i]?.visibility ?? 0) >= MIN_VISIBILITY);
}

// Lado con mejor visibilidad de hombro+codo+muñeca
function pickSide(lm) {
  const score = s => (lm[s.shoulder].visibility + lm[s.elbow].visibility + lm[s.wrist].visibility);
  return score(L) >= score(R) ? L : R;
}

function median(arr) {
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

// Desviación de la línea hombro-cadera-rodilla respecto a TU línea neutra calibrada.
// Signo: +1 cadera caída (por debajo de la línea), -1 cadera elevada.
function bodyLine(lm, side) {
  if (!visible(lm, side.shoulder, side.hip, side.knee)) return null;
  const sh = lm[side.shoulder], hp = lm[side.hip], kn = lm[side.knee];
  const raw = angle(sh, hp, kn);
  const dev = Math.max(0, cal.neutralBody - raw);
  // y crece hacia abajo: cross > 0 => cadera por debajo de la línea hombro-rodilla
  const cross = (kn.x - sh.x) * (hp.y - sh.y) - (kn.y - sh.y) * (hp.x - sh.x);
  const sign = (cross * Math.sign(kn.x - sh.x || 1)) > 0 ? 1 : -1;
  return { raw, dev, sign };
}

// --- encuadre y calibración -------------------------------------------

// Devuelve null si la posición es válida, o el motivo por el que no lo es.
function framingProblem(lm, side) {
  if (!visible(lm, side.shoulder, side.elbow, side.wrist))
    return "Aleja la cámara: no veo bien el brazo.";
  if (!visible(lm, side.hip, side.knee))
    return "Tienen que verse también cadera y rodilla.";

  const spread = Math.abs(lm[L.shoulder].x - lm[R.shoulder].x);
  const torso = Math.hypot(lm[side.shoulder].x - lm[side.hip].x, lm[side.shoulder].y - lm[side.hip].y);
  if (torso > 0 && spread / torso > 0.55)
    return "Ponte de lado a la cámara, no de frente.";

  const tilt = Math.abs(Math.atan2(
    lm[side.shoulder].y - lm[side.knee].y,
    lm[side.shoulder].x - lm[side.knee].x
  ) * 180 / Math.PI);
  if (Math.min(tilt, 180 - tilt) > 40)
    return "Ponte en posición de plancha, con el cuerpo horizontal.";

  return null;
}

function startCalibration() {
  stage = "calibrating";
  cal.samples = [];
  cal.startedAt = performance.now();
  speak("Quieto, calibrando");
}

function runCalibration(lm, side, elbow, body) {
  const left = CAL_SECONDS - (performance.now() - cal.startedAt) / 1000;
  if (framingProblem(lm, side)) {           // te has movido: vuelta a empezar
    stage = "framing";
    return;
  }
  if (elbow > 130 && body) cal.samples.push([elbow, body.raw]);
  if (left > 0) {
    setStatus(`Calibrando… ${left.toFixed(1)} s. Quieto en posición alta.`);
    el.phase.textContent = "calibrando";
    return;
  }
  if (cal.samples.length < 15) {            // pocas muestras válidas
    cal.startedAt = performance.now();
    cal.samples = [];
    setStatus("Estira los brazos del todo y repetimos la calibración.");
    return;
  }

  cal.upElbow = median(cal.samples.map(s => s[0]));
  cal.neutralBody = median(cal.samples.map(s => s[1]));
  cal.upAngle = cal.upElbow - 12;
  cal.downAngle = Math.min(105, Math.max(85, cal.upElbow - 60));

  stage = "counting";
  smoothElbow = cal.upElbow;
  rep.phase = "up";
  resetRep();
  showFeedback([["good", `Calibrado: extensión ${Math.round(cal.upElbow)}°, línea neutra ${Math.round(cal.neutralBody)}°. ¡Empieza!`]]);
  speak("Listo, empieza");
}

// --- lógica de repeticiones -------------------------------------------

function resetRep() {
  rep.minElbow = 180;
  rep.worstBodyDev = 0;
  rep.sagSign = 0;
  rep.startedAt = performance.now();
  rep.descending = false;
  rep.cued = false;
}

function processFrame(lm) {
  const side = pickSide(lm);
  const rawElbow = visible(lm, side.shoulder, side.elbow, side.wrist)
    ? angle(lm[side.shoulder], lm[side.elbow], lm[side.wrist])
    : null;
  const body = bodyLine(lm, side);

  if (rawElbow !== null) {
    smoothElbow = smoothElbow * 0.6 + rawElbow * 0.4;
    el.elbowVal.textContent = Math.round(smoothElbow);
  }
  if (body) el.bodyVal.textContent = Math.round(body.raw);

  if (stage === "framing") {
    const problem = framingProblem(lm, side);
    if (problem) {
      setStatus(problem);
      el.phase.textContent = "encuadre";
      framedSince = 0;
      return;
    }
    if (!framedSince) framedSince = performance.now();
    setStatus("Posición correcta. Mantente quieto…");
    if (performance.now() - framedSince > 800) startCalibration();
    return;
  }

  if (stage === "calibrating") {
    runCalibration(lm, side, rawElbow ?? 0, body);
    return;
  }

  if (rawElbow === null) {
    setStatus("No se ve bien el brazo. Ajusta la cámara.");
    return;
  }

  if (body) {
    if (body.dev > rep.worstBodyDev) {
      rep.worstBodyDev = body.dev;
      rep.sagSign = body.sign;
    }
    // aviso en el momento, no al terminar la repetición
    if (body.dev > 18 && !rep.cued && rep.phase === "down") {
      rep.cued = true;
      speak(body.sign > 0 ? "Sube la cadera" : "Baja la cadera");
    }
  }

  if (smoothElbow < rep.minElbow) rep.minElbow = smoothElbow;

  if (rep.phase === "up" && smoothElbow < cal.downAngle) {
    rep.phase = "down";
    rep.descending = true;
    el.phase.textContent = "bajando";
  } else if (rep.phase === "down" && smoothElbow > cal.upAngle) {
    rep.phase = "up";
    el.phase.textContent = "arriba";
    if (rep.descending) completeRep();
    resetRep();
  }

  setStatus(`Fase: ${rep.phase === "down" ? "abajo" : "arriba"} · codo ${Math.round(smoothElbow)}°`);
}

function completeRep() {
  const duration = (performance.now() - rep.startedAt) / 1000;
  const issues = [];
  let score = 100;

  if (rep.minElbow > 110) {
    issues.push(["bad", "Muy poco recorrido: baja hasta que el codo forme 90° o menos."]);
    score -= 35;
  } else if (rep.minElbow > GOOD_DEPTH) {
    issues.push(["warn", `Falta profundidad (${Math.round(rep.minElbow)}°). Baja un poco más el pecho.`]);
    score -= 15;
  }

  if (rep.worstBodyDev > 12) {
    const sev = rep.worstBodyDev > 20 ? "bad" : "warn";
    issues.push(rep.sagSign > 0
      ? [sev, "Cadera caída: aprieta abdomen y glúteos para mantener la línea."]
      : [sev, "Cadera demasiado alta: baja la cadera hasta alinear hombro-cadera-rodilla."]);
    score -= rep.worstBodyDev > 20 ? 30 : 15;
  }

  if (duration < 0.9) {
    issues.push(["warn", "Vas muy rápido. Controla la bajada ~1.5 s."]);
    score -= 10;
  } else if (duration > 6) {
    issues.push(["warn", "Repetición muy lenta, pierdes tensión."]);
    score -= 5;
  }

  score = Math.max(0, score);
  session.reps += 1;
  session.scores.push(score);
  for (const [, msg] of issues) session.issues[msg] = (session.issues[msg] || 0) + 1;

  el.reps.textContent = session.reps;

  if (issues.length === 0) {
    showFeedback([["good", `Rep ${session.reps}: técnica correcta (${Math.round(rep.minElbow)}°).`]]);
    speak(String(session.reps));
  } else {
    showFeedback(issues);
    speak(`${session.reps}. ${issues[0][1]}`);
  }
}

function showFeedback(items) {
  el.feedback.innerHTML = "";
  for (const [kind, msg] of items) {
    const li = document.createElement("li");
    li.className = kind === "good" ? "" : kind;
    li.textContent = msg;
    el.feedback.appendChild(li);
  }
}

function setStatus(text) {
  el.status.textContent = text;
}

let lastSpoken = 0;
function speak(text) {
  if (!el.voice.checked || !window.speechSynthesis) return;
  if (performance.now() - lastSpoken < 700) return;
  lastSpoken = performance.now();
  window.speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.lang = "es-ES";
  u.rate = 1.1;
  window.speechSynthesis.speak(u);
}

// --- render ------------------------------------------------------------

function draw(lm) {
  ctx.drawImage(el.video, 0, 0, el.canvas.width, el.canvas.height);
  if (!lm) return;

  ctx.lineWidth = 4;
  ctx.strokeStyle = stage !== "counting" ? "#60a5fa"
    : rep.worstBodyDev > 20 ? "#f87171" : "#4ade80";
  for (const [a, b] of CONNECTIONS) {
    if (!visible(lm, a, b)) continue;
    ctx.beginPath();
    ctx.moveTo(lm[a].x, lm[a].y);
    ctx.lineTo(lm[b].x, lm[b].y);
    ctx.stroke();
  }
  ctx.fillStyle = "#fff";
  for (const i of [11, 12, 13, 14, 15, 16, 23, 24, 25, 26, 27, 28]) {
    if ((lm[i]?.visibility ?? 0) < MIN_VISIBILITY) continue;
    ctx.beginPath();
    ctx.arc(lm[i].x, lm[i].y, 5, 0, Math.PI * 2);
    ctx.fill();
  }
}

function loop() {
  if (!running) return;
  if (el.video.readyState >= 2) {
    const ts = performance.now();
    if (ts !== lastTs) {
      lastTs = ts;
      const result = landmarker.detectForVideo(el.video, ts);
      // a píxeles: en coordenadas normalizadas los ángulos salen deformados
      // cuando el vídeo no es cuadrado
      const lm = result.landmarks?.[0]?.map(k => ({
        x: k.x * el.canvas.width,
        y: k.y * el.canvas.height,
        visibility: k.visibility,
      }));
      draw(lm);
      if (lm) processFrame(lm);
      else {
        setStatus("No te detecto. Colócate dentro del encuadre.");
        framedSince = 0;
      }
    }
  }
  requestAnimationFrame(loop);
}

// --- cámara ------------------------------------------------------------

let facingMode = localStorage.getItem("flexiones.facing") || "user";
let wakeLock = null;

async function openCamera() {
  stream?.getTracks().forEach(t => t.stop());
  stream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode, width: { ideal: 1280 }, height: { ideal: 720 } },
    audio: false,
  });
  el.video.srcObject = stream;
  await el.video.play();

  syncVideoSize();
  el.canvas.classList.toggle("mirror", facingMode === "user");

  const cams = (await navigator.mediaDevices.enumerateDevices())
    .filter(d => d.kind === "videoinput");
  el.switchBtn.hidden = cams.length < 2;
}

// El encuadre real cambia al girar el móvil: reajusta canvas y proporción del marco
function syncVideoSize() {
  const w = el.video.videoWidth, h = el.video.videoHeight;
  if (!w || !h) return;
  el.canvas.width = w;
  el.canvas.height = h;
  document.querySelector(".stage").style.setProperty("--ar", `${w} / ${h}`);
}

el.video.addEventListener("resize", syncVideoSize);
window.addEventListener("orientationchange", () => setTimeout(syncVideoSize, 300));

async function switchCamera() {
  facingMode = facingMode === "user" ? "environment" : "user";
  localStorage.setItem("flexiones.facing", facingMode);
  try { await openCamera(); } catch (err) { setStatus(`Error de cámara: ${err.message}`); }
}

async function requestWakeLock() {
  try { wakeLock = await navigator.wakeLock?.request("screen"); } catch { /* no soportado */ }
}

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && running && !wakeLock) requestWakeLock();
});

// --- sesión ------------------------------------------------------------

async function start() {
  el.startBtn.disabled = true;
  setStatus("Cargando modelo…");
  try {
    if (!landmarker) {
      const vision = await FilesetResolver.forVisionTasks(
        "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm"
      );
      landmarker = await PoseLandmarker.createFromOptions(vision, {
        baseOptions: {
          modelAssetPath: "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task",
          delegate: "GPU",
        },
        runningMode: "VIDEO",
        numPoses: 1,
      });
    }

    setStatus("Pidiendo cámara…");
    await openCamera();
    await requestWakeLock();

    session.reps = 0;
    session.scores = [];
    session.issues = {};
    session.startedAt = Date.now();
    el.reps.textContent = "0";
    el.feedback.innerHTML = "";
    resetRep();
    rep.phase = "up";
    smoothElbow = 180;
    stage = "framing";
    framedSince = 0;

    running = true;
    el.stopBtn.disabled = false;
    el.recalBtn.hidden = false;
    setStatus("Ponte en posición de plancha, de lado a la cámara.");
    loop();
  } catch (err) {
    setStatus(`Error: ${err.message}`);
    el.startBtn.disabled = false;
  }
}

function stop() {
  running = false;
  el.stopBtn.disabled = true;
  el.startBtn.disabled = false;
  el.recalBtn.hidden = true;
  stream?.getTracks().forEach(t => t.stop());
  stream = null;
  wakeLock?.release?.();
  wakeLock = null;

  if (session.reps === 0) {
    setStatus("Sesión terminada sin repeticiones.");
    return;
  }

  const avg = Math.round(session.scores.reduce((a, b) => a + b, 0) / session.scores.length);
  const duration = Math.round((Date.now() - session.startedAt) / 1000);
  const top = Object.entries(session.issues).sort((a, b) => b[1] - a[1]).slice(0, 2);

  const summary = [["good", `Sesión: ${session.reps} flexiones · calidad media ${avg}/100 · ${duration}s`]];
  for (const [msg, n] of top) summary.push(["warn", `${n} reps: ${msg}`]);
  showFeedback(summary);
  speak(`Sesión terminada. ${session.reps} flexiones. Calidad ${avg} sobre 100.`);

  saveSession({ date: Date.now(), reps: session.reps, quality: avg, duration });
}

// --- historial ---------------------------------------------------------

const STORE = "flexiones.history";

function loadHistory() {
  try { return JSON.parse(localStorage.getItem(STORE)) || []; } catch { return []; }
}

function saveSession(entry) {
  const list = loadHistory();
  list.unshift(entry);
  localStorage.setItem(STORE, JSON.stringify(list.slice(0, 50)));
  renderHistory();
}

function renderHistory() {
  const list = loadHistory();
  el.historyBody.innerHTML = "";
  for (const s of list) {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td>${new Date(s.date).toLocaleString("es-ES")}</td><td>${s.reps}</td><td>${s.quality}/100</td><td>${s.duration}s</td>`;
    el.historyBody.appendChild(tr);
  }
  renderProgress(list);
}

// --- progreso ----------------------------------------------------------

const dayKey = ts => new Date(ts).toLocaleDateString("es-ES");

// Días seguidos entrenando hasta hoy (o hasta ayer, si aún no has entrenado)
function streak(list) {
  const days = new Set(list.map(s => dayKey(s.date)));
  const day = new Date();
  if (!days.has(dayKey(day))) day.setDate(day.getDate() - 1);
  let n = 0;
  while (days.has(dayKey(day))) { n++; day.setDate(day.getDate() - 1); }
  return n;
}

function tile(value, label) {
  return `<div class="tile"><b>${value}</b><span>${label}</span></div>`;
}

function barChart(data, label) {
  const W = 320, H = 96, pad = { t: 16, r: 4, b: 16, l: 26 };
  const max = Math.max(...data.map(d => d.v), 1);
  const bw = (W - pad.l - pad.r) / data.length;
  const base = H - pad.b;
  const bars = data.map((d, i) => {
    const h = (base - pad.t) * d.v / max;
    return `<rect x="${(pad.l + i * bw + 1).toFixed(1)}" y="${(base - h).toFixed(1)}"
      width="${Math.max(2, bw - 3).toFixed(1)}" height="${h.toFixed(1)}" rx="2" fill="#60a5fa">
      <title>${d.label}: ${d.v} ${label}</title></rect>`;
  }).join("");
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${label} por sesión">
    <text x="0" y="9" class="ct">${label} por sesión</text>
    <text x="0" y="${pad.t + 3}" class="cl">${max}</text>
    <text x="0" y="${base + 3}" class="cl">0</text>
    <line x1="${pad.l}" y1="${base}" x2="${W - pad.r}" y2="${base}" class="cg"/>
    ${bars}
    <text x="${pad.l}" y="${H - 3}" class="cl">${data[0].label}</text>
    <text x="${W - pad.r}" y="${H - 3}" text-anchor="end" class="cl">${data.at(-1).label}</text>
  </svg>`;
}

function lineChart(data, label) {
  const W = 320, H = 80, pad = { t: 16, r: 6, b: 12, l: 26 };
  const x = i => pad.l + (W - pad.l - pad.r) * (data.length === 1 ? .5 : i / (data.length - 1));
  const y = v => H - pad.b - (H - pad.t - pad.b) * v / 100;
  const pts = data.map((d, i) => `${x(i).toFixed(1)},${y(d.v).toFixed(1)}`).join(" ");
  const dots = data.map((d, i) =>
    `<circle cx="${x(i).toFixed(1)}" cy="${y(d.v).toFixed(1)}" r="4" fill="#60a5fa" stroke="#0e1116" stroke-width="2">
      <title>${d.label}: ${d.v}/100</title></circle>`).join("");
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${label} por sesión">
    <text x="0" y="9" class="ct">${label} (0-100)</text>
    <line x1="${pad.l}" y1="${y(100)}" x2="${W - pad.r}" y2="${y(100)}" class="cg"/>
    <line x1="${pad.l}" y1="${y(0)}" x2="${W - pad.r}" y2="${y(0)}" class="cg"/>
    <text x="0" y="${y(100) + 3}" class="cl">100</text>
    <text x="0" y="${y(0) + 3}" class="cl">0</text>
    <polyline points="${pts}" fill="none" stroke="#60a5fa" stroke-width="2" stroke-linejoin="round"/>
    ${dots}
  </svg>`;
}

function renderProgress(list) {
  const box = document.getElementById("progress");
  if (!list.length) {
    box.innerHTML = `<p class="empty">Aún no hay sesiones guardadas.</p>`;
    return;
  }

  const total = list.reduce((a, s) => a + s.reps, 0);
  const best = Math.max(...list.map(s => s.reps));
  const avg = Math.round(list.reduce((a, s) => a + s.quality, 0) / list.length);
  const tiles = `<div class="tiles">
    ${tile(total, "flexiones")}${tile(best, "récord")}${tile(`${avg}`, "calidad media")}${tile(streak(list), "días seguidos")}
  </div>`;

  const recent = list.slice(0, 14).reverse();
  const labels = recent.map(s => new Date(s.date).toLocaleDateString("es-ES", { day: "numeric", month: "short" }));
  const charts = recent.length < 2 ? "" : `
    <div class="chart">${barChart(recent.map((s, i) => ({ v: s.reps, label: labels[i] })), "Reps")}</div>
    <div class="chart">${lineChart(recent.map((s, i) => ({ v: s.quality, label: labels[i] })), "Calidad")}</div>`;

  box.innerHTML = tiles + charts;
}

el.startBtn.addEventListener("click", start);
el.stopBtn.addEventListener("click", stop);
el.switchBtn.addEventListener("click", switchCamera);
el.recalBtn.addEventListener("click", () => {
  stage = "framing";
  framedSince = 0;
  setStatus("Recalibrando: ponte en posición de plancha.");
});
el.clearHistory.addEventListener("click", () => {
  localStorage.removeItem(STORE);
  renderHistory();
});

renderHistory();

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => navigator.serviceWorker.register("./sw.js").catch(() => {}));
}
