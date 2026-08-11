import { FilesetResolver, PoseLandmarker } from "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/vision_bundle.mjs";

const L = { shoulder: 11, elbow: 13, wrist: 15, hip: 23, knee: 25, ankle: 27 };
const R = { shoulder: 12, elbow: 14, wrist: 16, hip: 24, knee: 26, ankle: 28 };
const CONNECTIONS = [
  [11, 13], [13, 15], [12, 14], [14, 16], [11, 12],
  [11, 23], [12, 24], [23, 24], [23, 25], [24, 26], [25, 27], [26, 28],
];

const DOWN_ANGLE = 100;   // entra en fase de bajada
const UP_ANGLE = 155;     // brazos extendidos
const GOOD_DEPTH = 90;    // codo a 90° o menos = profundidad correcta
const MIN_VISIBILITY = 0.6;

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
};

let smoothElbow = 180;

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

// Desviación de la línea hombro-cadera-rodilla respecto a 180°.
// Signo: +1 cadera caída (por debajo de la línea), -1 cadera elevada.
function bodyLine(lm, side) {
  if (!visible(lm, side.shoulder, side.hip, side.knee)) return null;
  const sh = lm[side.shoulder], hp = lm[side.hip], kn = lm[side.knee];
  const dev = 180 - angle(sh, hp, kn);
  // y crece hacia abajo: cross > 0 => cadera por debajo de la línea hombro-rodilla
  const cross = (kn.x - sh.x) * (hp.y - sh.y) - (kn.y - sh.y) * (hp.x - sh.x);
  const sign = (cross * Math.sign(kn.x - sh.x || 1)) > 0 ? 1 : -1;
  return { dev, sign };
}

// --- lógica de repeticiones -------------------------------------------

function resetRep() {
  rep.minElbow = 180;
  rep.worstBodyDev = 0;
  rep.sagSign = 0;
  rep.startedAt = performance.now();
  rep.descending = false;
}

function processFrame(lm) {
  const side = pickSide(lm);
  if (!visible(lm, side.shoulder, side.elbow, side.wrist)) {
    setStatus("No se ve bien el brazo. Ajusta la cámara.");
    return;
  }

  const raw = angle(lm[side.shoulder], lm[side.elbow], lm[side.wrist]);
  smoothElbow = smoothElbow * 0.6 + raw * 0.4;

  const body = bodyLine(lm, side);
  if (body) {
    if (body.dev > rep.worstBodyDev) {
      rep.worstBodyDev = body.dev;
      rep.sagSign = body.sign;
    }
    el.bodyVal.textContent = Math.round(180 - body.dev);
  }

  el.elbowVal.textContent = Math.round(smoothElbow);

  if (smoothElbow < rep.minElbow) rep.minElbow = smoothElbow;

  if (rep.phase === "up" && smoothElbow < DOWN_ANGLE) {
    rep.phase = "down";
    rep.descending = true;
    el.phase.textContent = "bajando";
  } else if (rep.phase === "down" && smoothElbow > UP_ANGLE) {
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
  const w = el.canvas.width, h = el.canvas.height;
  ctx.drawImage(el.video, 0, 0, w, h);
  if (!lm) return;

  ctx.lineWidth = 4;
  ctx.strokeStyle = rep.worstBodyDev > 20 ? "#f87171" : "#4ade80";
  for (const [a, b] of CONNECTIONS) {
    if (!visible(lm, a, b)) continue;
    ctx.beginPath();
    ctx.moveTo(lm[a].x * w, lm[a].y * h);
    ctx.lineTo(lm[b].x * w, lm[b].y * h);
    ctx.stroke();
  }
  ctx.fillStyle = "#fff";
  for (const i of [11, 12, 13, 14, 15, 16, 23, 24, 25, 26, 27, 28]) {
    if ((lm[i]?.visibility ?? 0) < MIN_VISIBILITY) continue;
    ctx.beginPath();
    ctx.arc(lm[i].x * w, lm[i].y * h, 5, 0, Math.PI * 2);
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
      const lm = result.landmarks?.[0];
      draw(lm);
      if (lm) processFrame(lm);
      else setStatus("No te detecto. Colócate dentro del encuadre.");
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

  el.canvas.width = el.video.videoWidth;
  el.canvas.height = el.video.videoHeight;
  el.canvas.classList.toggle("mirror", facingMode === "user");

  const cams = (await navigator.mediaDevices.enumerateDevices())
    .filter(d => d.kind === "videoinput");
  el.switchBtn.hidden = cams.length < 2;
}

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

    running = true;
    el.stopBtn.disabled = false;
    setStatus("Listo. Ponte en posición de plancha de lado a la cámara.");
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
}

el.startBtn.addEventListener("click", start);
el.stopBtn.addEventListener("click", stop);
el.switchBtn.addEventListener("click", switchCamera);
el.clearHistory.addEventListener("click", () => {
  localStorage.removeItem(STORE);
  renderHistory();
});

renderHistory();
