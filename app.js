// Contador de flexiones. Ver CLAUDE.md para arquitectura, umbrales y pruebas.
//
// Dos máquinas de estado que conviene no confundir:
//   stage     framing → calibrating → counting ⇄ resting   (fase del entrenamiento)
//   rep.phase up ⇄ down                                    (fase de una repetición)
// La pantalla visible va aparte, en #app[data-screen].
//
// Toda la geometría trabaja en píxeles: las coordenadas normalizadas de MediaPipe
// deforman los ángulos en vídeo no cuadrado. La conversión se hace en loop().

import { FilesetResolver, PoseLandmarker } from "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/vision_bundle.mjs";

// Índices de los puntos de MediaPipe Pose que usamos, por lado del cuerpo
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

// Recorrido que estás haciendo de verdad, medido sobre la marcha. Si la
// calibración quedó corta (móvil en el suelo, perspectiva) los umbrales fijos
// pueden ser inalcanzables y no contarías ninguna repetición; con esto los
// disparadores se adaptan a tu rango real.
const obs = { min: 180, max: 0, t: 0 };
const OBS_WINDOW = 12000;   // ms sin novedad antes de reiniciar la ventana
const OBS_MIN_RANGE = 45;   // grados de recorrido mínimos para fiarse

let stage = "framing"; // framing → calibrating → counting ⇄ resting

// Plan de entrenamiento
// mode: "sets" (series con objetivo) | "free" (contar sin más) | "test" (hasta el fallo)
const plan = { sets: 3, target: 10, rest: 60, mode: "sets", view: "side" };
const isSets = () => plan.mode === "sets";
const isTest = () => plan.mode === "test";
const TEST_IDLE_MS = 12000;   // sin repetir este rato en test = has llegado al fallo
let currentSet = 1;
let setReps = 0;
let restUntil = 0;
let restCue = 0;

const el = {
  app: document.getElementById("app"),
  video: document.getElementById("video"),
  canvas: document.getElementById("canvas"),
  coach: document.getElementById("coach"),
  debug: document.getElementById("debug"),
  reps: document.getElementById("reps"),
  repsSub: document.getElementById("repsSub"),
  countBox: document.getElementById("countBox"),
  gaugeFill: document.getElementById("gaugeFill"),
  setBadge: document.getElementById("setBadge"),
  phase: document.getElementById("phaseBadge"),
  startBtn: document.getElementById("startBtn"),
  stopBtn: document.getElementById("stopBtn"),
  againBtn: document.getElementById("againBtn"),
  switchBtn: document.getElementById("switchBtn"),
  recalBtn: document.getElementById("recalBtn"),
  skipBtn: document.getElementById("skipBtn"),
  restOverlay: document.getElementById("restOverlay"),
  restLeft: document.getElementById("restLeft"),
  restNext: document.getElementById("restNext"),
  ringFg: document.getElementById("ringFg"),
  scoreRing: document.getElementById("scoreRing"),
  scoreVal: document.getElementById("scoreVal"),
  sumReps: document.getElementById("sumReps"),
  sumSets: document.getElementById("sumSets"),
  sumTime: document.getElementById("sumTime"),
  feedback: document.getElementById("summaryList"),
  clipBox: document.getElementById("clipBox"),
  steppers: document.querySelector(".steppers"),
  segs: [...document.querySelectorAll(".seg[data-view]")],
  modeSegs: [...document.querySelectorAll(".seg[data-mode]")],
  modeHint: document.getElementById("modeHint"),
  tip: document.getElementById("tip"),
  guide: document.getElementById("guide"),
  helpBtn: document.getElementById("helpBtn"),
  guideOk: document.getElementById("guideOk"),
  setsVal: document.getElementById("setsVal"),
  targetVal: document.getElementById("targetVal"),
  restVal: document.getElementById("restVal"),
  voice: document.getElementById("voice"),
  haptics: document.getElementById("haptics"),
  suggest: document.getElementById("suggest"),
  exportBtn: document.getElementById("exportBtn"),
  importBtn: document.getElementById("importBtn"),
  importFile: document.getElementById("importFile"),
  historyBody: document.querySelector("#historyTable tbody"),
  clearHistory: document.getElementById("clearHistory"),
};
const ctx = el.canvas.getContext("2d");

let landmarker = null;
let stream = null;
let running = false;
let lastTs = -1;
let fps = 0;

const session = {
  reps: 0,
  scores: [],
  depths: [],
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
  worstFlare: 0,    // apertura máxima de codos (solo vista frontal)
  gapLR: 0,         // diferencia izquierda-derecha abajo (solo vista frontal)
  tElbowMin: 0,     // instante en que el pecho toca abajo
  hipLowY: 0,       // punto más bajo de la cadera (y crece hacia abajo)
  tHipLow: 0,
  hipYAtElbowMin: 0,
  torso: 0,
};

// Reps de la serie actual, para detectar fatiga
let setLog = [];
let fatigueWarned = false;

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

const isFront = () => plan.view === "front";

function armLength(lm, side) {
  return Math.hypot(lm[side.shoulder].x - lm[side.elbow].x, lm[side.shoulder].y - lm[side.elbow].y)
    + Math.hypot(lm[side.elbow].x - lm[side.wrist].x, lm[side.elbow].y - lm[side.wrist].y);
}

// Devuelve null si la posición es válida, o el motivo por el que no lo es.
function framingProblem(lm, side) {
  const spread = Math.abs(lm[L.shoulder].x - lm[R.shoulder].x);

  if (isFront()) {
    // De frente hacen falta los dos brazos; cadera y rodilla no se ven y no se piden.
    if (!visible(lm, L.shoulder, L.elbow, L.wrist) || !visible(lm, R.shoulder, R.elbow, R.wrist))
      return "Tienen que verse los dos brazos enteros.";
    const arm = Math.max(armLength(lm, L), armLength(lm, R));
    if (arm > 0 && spread / arm < 0.35)
      return "Ponte de frente a la cámara, no de lado.";
    return null;
  }

  if (!visible(lm, side.shoulder, side.elbow, side.wrist))
    return "Aleja la cámara: no veo bien el brazo.";
  if (!visible(lm, side.hip, side.knee))
    return "Tienen que verse también cadera y rodilla.";

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

// ¿Has dejado la plancha? Al levantarte a por el móvil los brazos se mueven y
// los ángulos dan un vaivén que parecía una repetición. Se mira el torso: de
// lado se pone vertical, y de frente deja de estar escorzado y se alarga.
function outOfPosition(lm, side) {
  if (isFront()) {
    if (!visible(lm, L.hip, R.hip, L.shoulder, R.shoulder)) return false;
    const width = Math.abs(lm[L.shoulder].x - lm[R.shoulder].x);
    if (width < 1) return false;
    const shY = (lm[L.shoulder].y + lm[R.shoulder].y) / 2;
    const hipY = (lm[L.hip].y + lm[R.hip].y) / 2;
    return Math.abs(hipY - shY) > width * 1.2;
  }
  if (!visible(lm, side.shoulder, side.hip)) return false;
  const tilt = Math.abs(Math.atan2(
    lm[side.shoulder].y - lm[side.hip].y,
    lm[side.shoulder].x - lm[side.hip].x
  ) * 180 / Math.PI);
  return Math.min(tilt, 180 - tilt) > 45;
}

// Ángulo de codo: de lado, el del lado visible; de frente, la media de los dos.
// Devuelve también cada lado por separado para juzgar simetría y apertura.
function elbowReading(lm, side) {
  const one = s => visible(lm, s.shoulder, s.elbow, s.wrist)
    ? angle(lm[s.shoulder], lm[s.elbow], lm[s.wrist]) : null;

  if (!isFront()) {
    const a = one(side);
    return a === null ? null : { mean: a, left: null, right: null };
  }
  const aL = one(L), aR = one(R);
  if (aL === null && aR === null) return null;
  if (aL === null || aR === null) return { mean: aL ?? aR, left: aL, right: aR };
  return { mean: (aL + aR) / 2, left: aL, right: aR };
}

// Cuánto se separan los codos del cuerpo, en anchos de hombro. Solo tiene
// sentido de frente: es la vista donde la apertura se ve de verdad.
function elbowFlare(lm) {
  if (!visible(lm, L.shoulder, R.shoulder, L.elbow, R.elbow)) return null;
  const width = Math.abs(lm[L.shoulder].x - lm[R.shoulder].x);
  if (width < 1) return null;
  const outL = Math.abs(lm[L.elbow].x - lm[L.shoulder].x) / width;
  const outR = Math.abs(lm[R.elbow].x - lm[R.shoulder].x) / width;
  return Math.max(outL, outR);
}

function startCalibration() {
  stage = "calibrating";
  cal.samples = [];
  cal.startedAt = performance.now();
  speak("Quieto, calibrando", true);
}

function runCalibration(lm, side, elbow, body) {
  const left = CAL_SECONDS - (performance.now() - cal.startedAt) / 1000;
  if (framingProblem(lm, side)) {           // te has movido: vuelta a empezar
    stage = "framing";
    return;
  }
  // De frente no hay línea de cadera que medir: se calibra solo el codo.
  if (elbow > 130 && (body || isFront())) cal.samples.push([elbow, body ? body.raw : 180]);
  if (left > 0) {
    setCoach(`Calibrando… ${left.toFixed(1)} s. Quieto, brazos estirados.`, "info");
    el.phase.textContent = "calibrando";
    return;
  }
  if (cal.samples.length < 15) {            // pocas muestras válidas
    cal.startedAt = performance.now();
    cal.samples = [];
    setCoach("Estira los brazos del todo y repetimos la calibración.", "warn");
    return;
  }

  cal.upElbow = median(cal.samples.map(s => s[0]));
  cal.neutralBody = median(cal.samples.map(s => s[1]));
  cal.upAngle = cal.upElbow - 12;
  cal.downAngle = Math.min(115, Math.max(85, cal.upElbow - 50));
  obs.min = obs.max = cal.upElbow;
  obs.t = 0;

  stage = "counting";
  smoothElbow = cal.upElbow;
  rep.phase = "up";
  paused = false;
  outSince = 0;
  lastRepAt = performance.now();
  resetRep();
  setCoach("Listo. ¡Empieza a bajar!", "good");
  speak("Listo, empieza", true);
  buzz(400);
}

// --- lógica de repeticiones -------------------------------------------

let shortAttempt = 0;   // punto más bajo de un intento que no llegó a disparar
let atTop = true;       // ¿venías de arriba? si no, no hay intento que juzgar
let paused = false;     // fuera de la plancha: ni cuenta ni juzga
let outSince = 0;
let lastRepAt = 0;

function trackRange(a, now) {
  if (now - obs.t > OBS_WINDOW) { obs.min = obs.max = a; obs.t = now; return; }
  if (a < obs.min) { obs.min = a; obs.t = now; }
  if (a > obs.max) { obs.max = a; obs.t = now; }
}

// Disparadores de bajada y subida. Si tu recorrido real es amplio, se colocan
// en torno a su punto medio; si no, se usan los de la calibración. Siempre se
// elige el más permisivo de los dos, que es lo que evita quedarse en 0.
function triggers() {
  const range = obs.max - obs.min;
  if (range < OBS_MIN_RANGE) return { down: cal.downAngle, up: cal.upAngle };
  const mid = (obs.max + obs.min) / 2;
  return {
    down: Math.max(cal.downAngle, mid - range * 0.1),
    up: Math.min(cal.upAngle, mid + range * 0.1),
  };
}

function resetRep() {
  rep.minElbow = 180;
  rep.worstBodyDev = 0;
  rep.sagSign = 0;
  rep.startedAt = performance.now();
  rep.descending = false;
  rep.cued = false;
  rep.tElbowMin = 0;
  rep.hipLowY = 0;
  rep.tHipLow = 0;
  rep.hipYAtElbowMin = 0;
  rep.torso = 0;
  rep.worstFlare = 0;
  rep.gapLR = 0;
}

function processFrame(lm) {
  const side = pickSide(lm);
  const reading = elbowReading(lm, side);
  const rawElbow = reading ? reading.mean : null;
  const body = isFront() ? null : bodyLine(lm, side);
  const flare = isFront() ? elbowFlare(lm) : null;

  if (rawElbow !== null) {
    smoothElbow = smoothElbow * 0.6 + rawElbow * 0.4;
    updateGauge();
  }
  const t = triggers();
  const extra = isFront()
    ? `codos ${flare === null ? "–" : flare.toFixed(1)}×hombro`
    : `cuerpo ${body ? Math.round(body.raw) : "–"}°`;
  setDebug(`codo ${Math.round(smoothElbow)}° · cuenta bajando <${Math.round(t.down)}° y subiendo >${Math.round(t.up)}° · ${extra} · ${Math.round(fps)} fps`);

  if (stage === "framing") {
    const problem = framingProblem(lm, side);
    if (problem) {
      setCoach(problem, "warn");
      el.phase.textContent = "encuadre";
      framedSince = 0;
      return;
    }
    if (!framedSince) framedSince = performance.now();
    setCoach("Posición correcta. Mantente quieto…", "info");
    if (performance.now() - framedSince > 800) startCalibration();
    return;
  }

  if (stage === "calibrating") {
    runCalibration(lm, side, rawElbow ?? 0, body);
    return;
  }

  if (rawElbow === null) {
    setCoach("No se ve bien el brazo. Ajusta la cámara.", "warn");
    return;
  }

  const now = performance.now();

  // Sales de la plancha (te levantas a por el móvil): se descarta la repetición
  // en curso y se deja de contar hasta que vuelvas.
  if (outOfPosition(lm, side)) {
    if (!outSince) outSince = now;
    if (!paused && now - outSince > 600) {   // el margen es para no parpadear el aviso
      paused = true;
      rep.phase = "up";
      resetRep();
      el.phase.textContent = "pausa";
      setCoach("Fuera de posición: no estoy contando.", "info");
    }
    return;                                  // fuera de la plancha no se cuenta nunca
  } else if (outSince) {
    outSince = 0;
    if (paused) {
      paused = false;
      smoothElbow = cal.upElbow;
      obs.min = obs.max = cal.upElbow;   // el vaivén de levantarte no es tu recorrido
      obs.t = 0;
      rep.phase = "up";
      resetRep();
      lastRepAt = now;   // el rato fuera de posición no cuenta como fallo en el test
      setCoach("Ya te veo otra vez. Cuando quieras.", "good");
    }
  }
  if (paused) return;

  const hipY = visible(lm, side.hip) ? lm[side.hip].y : null;

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
    rep.torso = Math.hypot(lm[side.shoulder].x - lm[side.hip].x, lm[side.shoulder].y - lm[side.hip].y);
  }

  // Para detectar el "gusano": si la cadera toca fondo y empieza a subir
  // antes de que el pecho llegue abajo, estás subiendo por partes.
  if (hipY !== null && hipY > rep.hipLowY) {
    rep.hipLowY = hipY;
    rep.tHipLow = now;
  }
  if (smoothElbow < rep.minElbow) {
    rep.minElbow = smoothElbow;
    rep.tElbowMin = now;
    if (hipY !== null) rep.hipYAtElbowMin = hipY;
    if (reading.left !== null && reading.right !== null) {
      rep.gapLR = Math.abs(reading.left - reading.right);   // asimetría en el punto bajo
    }
  }
  // la apertura se juzga abajo, que es donde el hombro sufre
  if (flare !== null && rep.phase === "down" && flare > rep.worstFlare) rep.worstFlare = flare;

  trackRange(smoothElbow, now);
  const trig = triggers();

  if (rep.phase === "up" && smoothElbow < trig.down) {
    rep.phase = "down";
    rep.descending = true;
    el.phase.textContent = "bajando";
    startClip();
    shortAttempt = 0;
    atTop = false;   // ya no hay intento que juzgar hasta que vuelvas arriba
  } else if (rep.phase === "down" && smoothElbow > trig.up) {
    rep.phase = "up";
    el.phase.textContent = "arriba";
    if (rep.descending) completeRep();
    resetRep();
  } else if (rep.phase === "up") {
    // bajaste pero te quedaste por encima del disparador: dilo, o parece averiado
    if (smoothElbow > cal.upElbow - 15) {
      atTop = true;
      shortAttempt = 0;
    } else if (atTop) {
      if (!shortAttempt || smoothElbow < shortAttempt) shortAttempt = smoothElbow;
      if (shortAttempt < cal.upElbow - 20 && smoothElbow > shortAttempt + 10) {
        setCoach(`Te faltaron ${Math.round(shortAttempt - trig.down)}° para que contase. Baja un poco más.`, "warn");
        atTop = false;
        shortAttempt = 0;
      }
    }
  }

  el.phase.textContent = rep.phase === "down" ? "bajando" : "arriba";

  // En test no hay que pulsar nada al llegar al fallo: si dejas de repetir, cierra
  if (isTest() && session.reps > 0 && rep.phase === "up" && now - lastRepAt > TEST_IDLE_MS) {
    speak("Test terminado", true);
    stop();
  }
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

  // De frente se juzga lo que de lado no se ve: apertura de codos y simetría.
  // La cadera y el gusano quedan fuera porque desde delante no se miden.
  if (isFront()) {
    if (rep.worstFlare > 1.15) {
      issues.push(["bad", "Codos muy abiertos: pégalos más al cuerpo, a unos 45°, o cargas el hombro."]);
      score -= 25;
    } else if (rep.worstFlare > 0.9) {
      issues.push(["warn", "Codos algo abiertos: llévalos un poco más hacia atrás."]);
      score -= 10;
    }
    if (rep.gapLR > 15) {
      issues.push(["warn", `Un brazo baja más que el otro (${Math.round(rep.gapLR)}° de diferencia).`]);
      score -= 10;
    }
  }

  // "Gusano": la cadera toca fondo y ya va subiendo cuando el pecho llega abajo
  const hipLead = rep.hipLowY - rep.hipYAtElbowMin;
  const worm = !isFront() && rep.torso > 0 && rep.tHipLow > 0
    && rep.tElbowMin - rep.tHipLow > 200
    && hipLead / rep.torso > 0.05;

  if (worm) {
    issues.push(["bad", "Subes la cadera antes que el pecho. Empuja con los brazos y sube todo el cuerpo a la vez."]);
    score -= 25;
  } else if (rep.worstBodyDev > 12) {
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
  setReps += 1;
  session.scores.push(score);
  session.depths.push(rep.minElbow);
  setLog.push({ depth: rep.minElbow, dur: duration });
  for (const [, msg] of issues) session.issues[msg] = (session.issues[msg] || 0) + 1;

  saveClip(score);
  updateCounter();

  const fatigue = checkFatigue();
  if (fatigue) issues.push(["warn", fatigue]);

  // lo grave primero: solo el primer aviso se dice en voz y se ve en pantalla
  issues.sort((a, b) => (a[0] === "bad" ? 0 : 1) - (b[0] === "bad" ? 0 : 1));

  const spoken = isSets() ? setReps : session.reps;
  pulseCount();
  if (issues.length === 0) {
    setCoach(`Rep ${session.reps}: técnica correcta (${Math.round(rep.minElbow)}°)`, "good");
    speak(String(spoken), true);
    buzz(40);
  } else {
    const [kind, msg] = issues[0];
    setCoach(msg, kind);
    speak(`${spoken}. ${shortPhrase(msg)}`, true);
    buzz([30, 70, 30]);
  }

  lastRepAt = performance.now();
  if (isSets() && setReps >= plan.target) endSet();
}

// --- fatiga -------------------------------------------------------------

const mean = a => a.reduce((x, y) => x + y, 0) / a.length;

// Compara las últimas reps con el arranque de la serie. Se avisa una vez.
function checkFatigue() {
  if (fatigueWarned || setLog.length < 5) return null;
  const base = setLog.slice(0, 3);
  const last = setLog.slice(-2);
  const depthDrop = mean(last.map(r => r.depth)) - mean(base.map(r => r.depth));
  const slowdown = mean(last.map(r => r.dur)) / mean(base.map(r => r.dur));

  if (depthDrop > 8) {
    fatigueWarned = true;
    return `Estás perdiendo recorrido (${Math.round(depthDrop)}° menos que al empezar). Quedan pocas buenas.`;
  }
  if (slowdown > 1.6) {
    fatigueWarned = true;
    return "Te estás frenando bastante: llegas al límite, mantén la técnica.";
  }
  return null;
}

// --- clip de la peor repetición ----------------------------------------

let canvasStream = null;
let recorder = null;
let clipChunks = [];
// la peor enseña qué corregir; la mejor, a qué se parece cuando lo haces bien
const clips = {
  worst: {
    score: 101, url: null,
    video: document.getElementById("clip"),
    box: document.getElementById("worstBox"),
    label: document.getElementById("clipScore"),
  },
  best: {
    score: -1, url: null,
    video: document.getElementById("bestClip"),
    box: document.getElementById("bestBox"),
    label: document.getElementById("bestScore"),
  },
};

function clipMime() {
  return ["video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm", "video/mp4"]
    .find(t => window.MediaRecorder?.isTypeSupported?.(t)) || null;
}

// Se graba solo la repetición en curso: así el clip guardado es un archivo
// completo y reproducible, no un trozo suelto de un stream.
function startClip() {
  const mime = clipMime();
  if (!mime || !canvasStream || recorder) return;
  try {
    clipChunks = [];
    recorder = new MediaRecorder(canvasStream, { mimeType: mime, videoBitsPerSecond: 1200000 });
    recorder.ondataavailable = e => e.data.size && clipChunks.push(e.data);
    recorder.start();
  } catch {
    recorder = null;
  }
}

function keepClip(slot, score, blob) {
  if (slot.url) URL.revokeObjectURL(slot.url);
  slot.score = score;
  slot.url = URL.createObjectURL(blob);
  slot.video.src = slot.url;
  slot.label.textContent = `${score}/100`;
  slot.box.hidden = false;
  el.clipBox.hidden = false;
}

function saveClip(score) {
  if (!recorder) return;
  const rec = recorder;
  recorder = null;
  rec.onstop = () => {
    if (!clipChunks.length) return;
    const blob = new Blob(clipChunks, { type: rec.mimeType });
    if (score < clips.worst.score) keepClip(clips.worst, score, blob);
    if (score > clips.best.score) keepClip(clips.best, score, blob);
  };
  try { rec.stop(); } catch { /* ya parado */ }
}

function resetClips() {
  el.clipBox.hidden = true;
  for (const slot of Object.values(clips)) {
    if (slot.url) { URL.revokeObjectURL(slot.url); slot.url = null; }
    slot.video.removeAttribute("src");
    slot.box.hidden = true;
  }
  clips.worst.score = 101;
  clips.best.score = -1;
}

// --- series y descansos ------------------------------------------------

function updateCounter() {
  el.reps.textContent = isSets() ? setReps : session.reps;
  el.repsSub.textContent = isSets() ? `de ${plan.target}` : "repeticiones";
  el.setBadge.textContent = isSets() ? `Serie ${currentSet}/${plan.sets}`
    : isTest() ? `Test · récord ${loadRecord()?.reps ?? "–"}` : "Modo libre";
}

// El medidor se llena según lo cerca que estés de la profundidad objetivo.
// Ver una barra llenarse es más útil que leer un ángulo mientras entrenas.
function updateGauge() {
  const rango = Math.max(20, cal.upElbow - GOOD_DEPTH);
  const p = (cal.upElbow - smoothElbow) / rango;
  el.gaugeFill.style.height = `${Math.max(0, Math.min(1, p)) * 100}%`;
  el.gaugeFill.classList.toggle("deep", p >= 1);
}

function pulseCount() {
  el.countBox.classList.add("pulse");
  setTimeout(() => el.countBox.classList.remove("pulse"), 140);
}

function endSet() {
  if (currentSet >= plan.sets) {
    speak("Última serie completada. Buen trabajo", true);
    setTimeout(stop, 1200);
    return;
  }
  stage = "resting";
  restUntil = performance.now() + plan.rest * 1000;
  restCue = 0;
  el.restNext.textContent = `${currentSet + 1}/${plan.sets}`;
  el.restOverlay.hidden = false;
  el.phase.textContent = "descanso";
  speak(`Serie ${currentSet} completada. Descansa ${plan.rest} segundos`, true);
  buzz([200, 100, 200]);
}

const RING = 2 * Math.PI * 52;

function tickRest() {
  const msLeft = restUntil - performance.now();
  const left = Math.ceil(msLeft / 1000);
  if (left <= 0) return startNextSet();

  el.restLeft.textContent = left;
  el.ringFg.style.strokeDashoffset = RING * (1 - msLeft / (plan.rest * 1000));
  if (restCue !== left && (left === 10 || left <= 3)) {
    restCue = left;
    speak(left === 10 ? "Diez segundos" : String(left), true);
  }
}

function startNextSet() {
  currentSet += 1;
  setReps = 0;
  setLog = [];
  fatigueWarned = false;
  restUntil = 0;
  el.restOverlay.hidden = true;
  stage = "counting";
  rep.phase = "up";
  smoothElbow = cal.upElbow;
  resetRep();
  updateCounter();
  el.phase.textContent = "arriba";
  setCoach(`Serie ${currentSet}. ¡Vamos!`, "good");
  speak(`Serie ${currentSet}. Vamos`, true);
  buzz(400);
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

// Una sola línea de consejo, visible y con color según la gravedad.
function setCoach(text, kind = "info") {
  el.coach.textContent = text;
  el.coach.className = `coach ${kind}`;
}

function setDebug(text) {
  el.debug.textContent = text;
}

function showScreen(name) {
  el.app.dataset.screen = name;
}

// Aviso táctil: en un gimnasio con ruido la voz no llega, la vibración sí.
function buzz(pattern) {
  if (el.haptics.checked) navigator.vibrate?.(pattern);
}

const synth = window.speechSynthesis;
let esVoice = null;

function pickVoice() {
  const voices = synth?.getVoices?.() || [];
  esVoice = voices.find(v => /^es[-_]ES/i.test(v.lang))
    || voices.find(v => /^es/i.test(v.lang))
    || null;
}
synth?.addEventListener?.("voiceschanged", pickVoice);
pickVoice();

// El motor de voz del móvil solo arranca desde un gesto del usuario, y si no se
// le habla en un rato se duerme. Se despierta al pulsar Empezar con una frase
// muda; sin esto el primer aviso de la sesión se pierde.
let speechWatchdog = 0;

function primeSpeech() {
  if (!synth) return;
  try {
    synth.cancel();
    const u = new SpeechSynthesisUtterance(" ");
    u.volume = 0;
    synth.speak(u);
  } catch { /* navegador sin voz */ }

  // Chrome deja de hablar tras un rato en segundo plano si nadie lo reanima
  clearInterval(speechWatchdog);
  speechWatchdog = setInterval(() => {
    if (synth.speaking && !synth.paused) synth.resume();
  }, 8000);
}

// `urgent` = el número de la repetición, que es lo que no puede perderse. Un
// consejo no interrumpe a otro: cortar a media frase es justo lo que se oye
// como "no ha sonado".
function speak(text, urgent = false) {
  if (!el.voice.checked || !synth) return;
  if (synth.speaking || synth.pending) {
    if (!urgent) return;
    synth.cancel();
  }
  const u = new SpeechSynthesisUtterance(text);
  u.lang = "es-ES";
  if (esVoice) u.voice = esVoice;
  u.rate = 1.05;
  synth.speak(u);
}

// Frase corta para decir en voz: el detalle se lee en pantalla. Una frase larga
// no cabe entre dos repeticiones y acaba pisada por la siguiente.
function shortPhrase(msg) {
  return msg.split(/[:.(]/)[0].trim();
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

const MIN_FRAME_MS = 1000 / 24;   // inferir más rápido no mejora la medida y calienta el móvil

function loop() {
  if (!running) return;
  if (el.video.readyState >= 2) {
    const ts = performance.now();
    if (ts - lastTs >= MIN_FRAME_MS) {
      fps = fps ? fps * 0.9 + (1000 / (ts - lastTs)) * 0.1 : 1000 / (ts - lastTs);
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
      if (stage === "resting") tickRest();
      else if (lm) processFrame(lm);
      else {
        setCoach("No te detecto. Colócate dentro del encuadre.", "warn");
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
  try { await openCamera(); } catch (err) { setCoach(`Error de cámara: ${err.message}`, "bad"); }
}

async function requestWakeLock() {
  try { wakeLock = await navigator.wakeLock?.request("screen"); } catch { /* no soportado */ }
}

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && running && !wakeLock) requestWakeLock();
});

// --- sesión ------------------------------------------------------------

async function start() {
  primeSpeech();   // aquí seguimos dentro del gesto del usuario; después ya no
  el.startBtn.disabled = true;
  el.startBtn.textContent = "Cargando…";
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

    setCoach("Pidiendo cámara…", "info");
    await openCamera();
    await requestWakeLock();

    session.reps = 0;
    session.scores = [];
    session.depths = [];
    session.issues = {};
    session.startedAt = Date.now();
    currentSet = 1;
    setReps = 0;
    setLog = [];
    fatigueWarned = false;
    lastRepAt = performance.now();
    resetClips();
    canvasStream = el.canvas.captureStream?.(30) || null;
    updateCounter();
    el.feedback.innerHTML = "";
    el.restOverlay.hidden = true;
    resetRep();
    rep.phase = "up";
    smoothElbow = 180;
    stage = "framing";
    framedSince = 0;

    running = true;
    showScreen("workout");
    setCoach("Ponte en posición de plancha, de lado a la cámara.", "info");
    loop();
  } catch (err) {
    setCoach(`No pude arrancar: ${err.message}`, "bad");
    showScreen("setup");
  } finally {
    el.startBtn.disabled = false;
    el.startBtn.textContent = "Empezar";
  }
}

function stop() {
  running = false;
  el.restOverlay.hidden = true;
  if (recorder) { try { recorder.stop(); } catch { /* ya parado */ } recorder = null; }
  canvasStream?.getTracks().forEach(t => t.stop());
  canvasStream = null;
  clearInterval(speechWatchdog);
  speechWatchdog = 0;
  stream?.getTracks().forEach(t => t.stop());
  stream = null;
  wakeLock?.release?.();
  wakeLock = null;

  if (session.reps === 0) {
    showScreen("setup");
    return;
  }

  const avg = Math.round(session.scores.reduce((a, b) => a + b, 0) / session.scores.length);
  const duration = Math.round((Date.now() - session.startedAt) / 1000);
  const top = Object.entries(session.issues).sort((a, b) => b[1] - a[1]).slice(0, 2);

  el.scoreVal.textContent = avg;
  el.scoreRing.style.strokeDashoffset = RING * (1 - avg / 100);
  el.scoreRing.style.stroke = avg >= 80 ? "var(--good)" : avg >= 60 ? "var(--warn)" : "var(--bad)";
  el.sumReps.textContent = session.reps;
  el.sumSets.textContent = isSets() ? `${currentSet}/${plan.sets}` : isTest() ? "test" : "–";
  el.sumTime.textContent = duration >= 60 ? `${Math.floor(duration / 60)}:${String(duration % 60).padStart(2, "0")}` : `${duration}s`;

  const summary = [];
  if (isTest()) {
    const prev = loadRecord();
    if (!prev || session.reps > prev.reps) {
      saveRecord({ reps: session.reps, quality: avg, date: Date.now() });
      summary.push(["good", prev
        ? `¡Récord nuevo! ${session.reps} flexiones, ${session.reps - prev.reps} más que tu marca anterior.`
        : `Primera marca: ${session.reps} flexiones. A partir de aquí, a superarla.`]);
      speak("Récord nuevo", true);
    } else if (session.reps === prev.reps) {
      summary.push(["good", `Igualas tu récord: ${prev.reps} flexiones.`]);
    } else {
      summary.push(["warn", `Te quedaste a ${prev.reps - session.reps} de tu récord (${prev.reps}).`]);
    }
  }
  if (session.depths.length >= 6) {
    const drop = mean(session.depths.slice(-3)) - mean(session.depths.slice(0, 3));
    if (drop > 6) summary.push(["warn", `Las últimas reps bajaron ${Math.round(drop)}° menos que las primeras: la fatiga te quitó recorrido.`]);
  }
  for (const [msg, n] of top) summary.push(["warn", `${n} reps: ${msg}`]);
  if (!summary.length) summary.push(["good", "Sin fallos repetidos. Buena sesión."]);
  showFeedback(summary);
  showScreen("summary");
  speak(`Sesión terminada. ${session.reps} flexiones. Calidad ${avg} sobre 100.`, true);

  saveSession({
    date: Date.now(), reps: session.reps, quality: avg, duration,
    sets: isSets() ? currentSet : null, target: isSets() ? plan.target : null,
    mode: plan.mode,
  });
}

// --- historial ---------------------------------------------------------

const STORE = "flexiones.history";
const RECORD_STORE = "flexiones.record";

function loadRecord() {
  try { return JSON.parse(localStorage.getItem(RECORD_STORE)) || null; } catch { return null; }
}

function saveRecord(r) {
  localStorage.setItem(RECORD_STORE, JSON.stringify(r));
}

function loadHistory() {
  try { return JSON.parse(localStorage.getItem(STORE)) || []; } catch { return []; }
}

function saveSession(entry) {
  const list = loadHistory();
  list.unshift(entry);
  localStorage.setItem(STORE, JSON.stringify(list.slice(0, 50)));
  renderHistory();
}

// Propone el objetivo de hoy: sube una rep por serie si la última sesión
// salió con buena técnica, y lo mantiene si no.
function suggestPlan() {
  const [last] = loadHistory();
  if (!last) { el.suggest.hidden = true; return; }

  const sets = last.sets || plan.sets;
  const target = (last.target || Math.round(last.reps / sets)) + (last.quality >= 80 ? 1 : 0);
  el.suggest.hidden = false;
  el.suggest.innerHTML =
    `Última sesión: ${last.reps} reps, calidad ${last.quality}. Hoy: <b>${sets}×${target}</b> `;
  const use = document.createElement("button");
  use.className = "link";
  use.textContent = "usar";
  use.onclick = () => {
    plan.sets = sets;
    plan.target = target;
    plan.mode = "sets";
    savePlan();
  };
  el.suggest.appendChild(use);
}

function exportHistory() {
  const blob = new Blob([localStorage.getItem(STORE) || "[]"], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `flexiones-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
}

// Fusiona por fecha en vez de reemplazar: importar no borra lo que ya tienes.
async function importHistory(file) {
  try {
    const data = JSON.parse(await file.text());
    if (!Array.isArray(data)) throw new Error("formato");
    const byDate = new Map([...loadHistory(), ...data.filter(s => s?.date && s.reps != null)]
      .map(s => [s.date, s]));
    const merged = [...byDate.values()].sort((a, b) => b.date - a.date).slice(0, 50);
    localStorage.setItem(STORE, JSON.stringify(merged));
    renderHistory();
    showFeedback([["good", `Historial importado: ${merged.length} sesiones en total.`]]);
  } catch {
    showFeedback([["bad", "Ese archivo no es un historial válido."]]);
  }
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
  suggestPlan();
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

// --- plan ---------------------------------------------------------------

const PLAN_STORE = "flexiones.plan";

const LIMITS = { sets: [1, 12], target: [1, 100], rest: [15, 300] };

function savePlan() {
  localStorage.setItem(PLAN_STORE, JSON.stringify(plan));
  renderPlan();
}

const TIPS = {
  side: "Apoya el móvil <b>de lado</b>, a ras de suelo, a 1,5–2 m. Deben verse hombro, cadera y rodilla. Mide profundidad, cadera y \"gusano\".",
  front: "Pon el móvil <b>delante de ti</b>, a ras de suelo, apuntando a tu cara. Deben verse los dos brazos. Mide profundidad, apertura de codos y simetría; la cadera no se ve desde aquí.",
};

const MODE_HINTS = {
  sets: "Series con objetivo y descanso cronometrado entre ellas.",
  free: "Cuenta sin objetivo. Terminas tú cuando quieras.",
  test: "Hasta el fallo, sin objetivo. Se cierra sola si dejas de repetir 12 s.",
};

function renderPlan() {
  el.setsVal.textContent = plan.sets;
  el.targetVal.textContent = plan.target;
  el.restVal.textContent = plan.rest;
  el.steppers.classList.toggle("off", !isSets());
  for (const b of el.segs) b.setAttribute("aria-pressed", String(b.dataset.view === plan.view));
  for (const b of el.modeSegs) b.setAttribute("aria-pressed", String(b.dataset.mode === plan.mode));
  el.tip.innerHTML = TIPS[plan.view] || TIPS.side;
  const rec = loadRecord();
  el.modeHint.innerHTML = (MODE_HINTS[plan.mode] || "")
    + (isTest() && rec ? ` Tu récord: <b>${rec.reps} reps</b>.` : "");
  updateCounter();
}

function restorePlan() {
  try { Object.assign(plan, JSON.parse(localStorage.getItem(PLAN_STORE)) || {}); } catch { /* valores por defecto */ }
  if (!plan.mode) plan.mode = plan.free ? "free" : "sets";   // planes guardados antes de los modos
  delete plan.free;
  renderPlan();
}

for (const btn of document.querySelectorAll(".step")) {
  btn.addEventListener("click", () => {
    const { field, delta } = btn.dataset;
    const [min, max] = LIMITS[field];
    plan[field] = Math.min(max, Math.max(min, plan[field] + +delta));
    savePlan();
    buzz(15);
  });
}
for (const b of el.segs) {
  b.addEventListener("click", () => { plan.view = b.dataset.view; savePlan(); buzz(15); });
}
for (const b of el.modeSegs) {
  b.addEventListener("click", () => { plan.mode = b.dataset.mode; savePlan(); buzz(15); });
}
el.skipBtn.addEventListener("click", () => { restUntil = 0; });
el.exportBtn.addEventListener("click", exportHistory);
el.importBtn.addEventListener("click", () => el.importFile.click());
el.importFile.addEventListener("change", e => {
  const [file] = e.target.files;
  if (file) importHistory(file);
  e.target.value = "";
});

el.startBtn.addEventListener("click", start);
el.stopBtn.addEventListener("click", stop);
el.switchBtn.addEventListener("click", switchCamera);
el.againBtn.addEventListener("click", () => showScreen("setup"));
el.recalBtn.addEventListener("click", () => {
  stage = "framing";
  framedSince = 0;
  setCoach("Recalibrando: ponte en posición de plancha.", "info");
});
el.clearHistory.addEventListener("click", () => {
  localStorage.removeItem(STORE);
  renderHistory();
});

// La guía se enseña sola la primera vez: colocar mal el móvil es el fallo que
// más se paga, y no se descubre solo.
const GUIDE_STORE = "flexiones.guiaVista";

el.helpBtn.addEventListener("click", () => el.guide.showModal());
el.guideOk.addEventListener("click", () => {
  el.guide.close();
  localStorage.setItem(GUIDE_STORE, "1");
});

restorePlan();
renderHistory();

if (!localStorage.getItem(GUIDE_STORE)) el.guide.showModal();

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => navigator.serviceWorker.register("./sw.js").catch(() => {}));
}
