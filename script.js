/*************************************************
 * 16:9 스테이지 사이징
 *************************************************/
function updateStageSize() {
  const stage = document.querySelector('.stage');
  const aspect = 16 / 9;
  const winW = window.innerWidth;
  const winH = window.innerHeight;
  const winRatio = winW / winH;

  let width, height;
  if (winRatio > aspect) { height = winH; width = Math.round(height * aspect); }
  else { width = winW; height = Math.round(width / aspect); }

  stage.style.width  = `${width}px`;
  stage.style.height = `${height}px`;
  stage.style.left   = '50%';
  stage.style.top    = '50%';
  stage.style.transform = 'translate(-50%, -50%)';
}

/*************************************************
 * 이펙트(베이스라인)
 *************************************************/
const STRIP_RATIOS = [0.12, 0.22, 0.32, 0.22, 0.12];

const MAX_DELAY_MS   = 3000;
const MAX_BUFFER_SEC = 6;
const DELAY_CURVE    = 3.5;

const GHOST_SAMPLES = 7;   // ← 오타 수정
const GHOST_SPAN    = 0.6;
const GHOST_ALPHA0  = 0.10;
const GHOST_DECAY   = 0.75;

const BASE_BLUR_PX = 0.8;

const VIGNETTE_ALPHA = 0.20;
const VIGNETTE_WIDTH = 0.06;
const VIGNETTE_RGB   = [0, 0, 0];

const EXTRA_BLUR_PX_AT_EDGE   = 2;
const EXTRA_GHOST_ALPHA_AT_EDGE   = 0.05;
const EXTRA_GHOST_SAMPLES_AT_EDGE = 1.8;

const MOTION_STREAKS        = 6;
const MOTION_PIXELS_AT_EDGE = 28;
const MOTION_ALPHA0         = 0.10;
const MOTION_DECAY          = 0.72;

const EDGE_BIRTH_ON          = true;
const EDGE_BIRTH_SAMPLES     = 8;
const EDGE_BIRTH_MS          = 480;
const EDGE_BIRTH_ALPHA0      = 0.14;
const EDGE_BIRTH_DECAY       = 0.78;
const EDGE_BIRTH_SHIFT_PX    = 36;
const EDGE_BIRTH_EXTRA_BLUR  = 0.8;
const EDGE_BIRTH_COMPOSITE   = 'lighter';

function getEdgeBirthIntensity(row, N) {
  if (!EDGE_BIRTH_ON) return 0;
  if (row === 0 || row === N - 1) return 1.0;
  if (row === 1 || row === N - 2) return 0.5;
  return 0.0;
}

/*************************************************
 * TM 설정
 *************************************************/
const MODEL_URL = "./tm-outfit/";
const LABELS = ["y2k", "gorp", "ballet", "grunge"];

const INFER_INTERVAL_MS    = 120;
const CONFIDENCE_THRESHOLD = 0.90;
const STABLE_MS            = 2000;
const LOW_CONF_TO_CLEAR    = 0.30;
const CLEAR_MS             = 800;
const SHOW_MS              = 1500;

const INFER_SIZE = 224;
let tmModel = null;

/*************************************************
 * ✅ 카메라 소스만 **오른쪽(시계) 90°** 회전하여 cover로 그리는 헬퍼
 *  (미러는 적용하지 않음)
 *************************************************/
function drawCameraCoverRot90(ctx, src, W, H) {
  const sW = src.width, sH = src.height;
  const scale = Math.max(W / sH, H / sW);
  const drawW = sW * scale;
  const drawH = sH * scale;

  ctx.save();
  ctx.translate(W / 2, H / 2);
  ctx.rotate(Math.PI / 2); // 시계 90°
  ctx.drawImage(src, -drawW / 2, -drawH / 2, drawW, drawH);
  ctx.restore();
}

/*************************************************
 * ⭐ 배지 트레일(배지이름_t.png 연달아 생성) - 위치는 CSS left로만 제어
 *************************************************/
const TRAIL_IMG_SUFFIX   = "_t.png";
const TRAIL_INTERVAL_MS  = 120;
const TRAIL_MAX_COUNT    = Math.ceil(SHOW_MS / TRAIL_INTERVAL_MS) + 2;

function getBadgeSrcByLabel(label, badgeEls) {
  const el = badgeEls[label];
  return el ? el.getAttribute('src') : null;
}
function makeTrailSrcFromBase(baseSrc) {
  if (!baseSrc) return null;
  const m = baseSrc.match(/^(.*?)(\.[a-zA-Z0-9]+)$/);
  return m ? `${m[1]}_t${m[2]}` : `${baseSrc}_t.png`;
}

// ⛔ 가로 위치는 CSS의 left만 사용 — JS에서 translateX 금지!
function addOneTrailImage(stage, src, label) {
  const img = new Image();
  img.className = 'badge-trail';
  img.alt = `${label} trail`;

  img.onerror = () => {
    console.warn(`[trail] 이미지 로드 실패: ${src}`);
    const fallback = document.getElementById(`badge-${label}`)?.getAttribute('src');
    if (fallback) img.src = fallback; else img.remove();
  };

  img.src = src;

  // 필요하면 Y만 아주 살짝 흔들고 싶을 때 아래 주석 해제
  // const dy = (Math.random() * 2 - 1) * 4;
  // img.style.transform = `translateY(calc(-50% + ${dy}px)) rotate(90deg) scale(0.9)`;

  // 기본: 좌표는 CSS left, transform은 회전·정렬만
  img.style.transform = `translateY(-50%) rotate(90deg) scale(0.9)`;

  img.addEventListener('animationend', () => img.remove(), { once: true });
  stage.appendChild(img);
}

function spawnBadgeTrail(label, badgeEls) {
  // ⬇️ 기존: const stage = document.querySelector('.stage');
  const stage = document.getElementById('badge-layer') || document.querySelector('.stage'); // ✅ 여기만 바꾸기!
  if (!stage) return;

  const baseSrc  = getBadgeSrcByLabel(label, badgeEls);
  if (!baseSrc) { console.warn(`[trail] 배지 src 없음: ${label}`); return; }
  const trailSrc = makeTrailSrcFromBase(baseSrc);

  const start = performance.now();
  let count = 0;
  const timer = setInterval(() => {
    if (performance.now() - start > SHOW_MS || count >= TRAIL_MAX_COUNT) {
      clearInterval(timer);
      return;
    }
    addOneTrailImage(stage, trailSrc, label);
    count++;
  }, TRAIL_INTERVAL_MS);
}


/*************************************************
 * 메인
 *************************************************/
(async () => {
  const video  = document.getElementById('cam');
  const canvas = document.getElementById('view');
  const ctx    = canvas.getContext('2d', { alpha: false });

  updateStageSize();
  window.addEventListener('resize', () => {
    updateStageSize();
    fitCanvasToStage();
  }, { passive: true });

  // 카메라 시작
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: { ideal: 'user' },
        width:  { ideal: 1920, min: 1280 },
        height: { ideal: 1080, min: 720 },
        aspectRatio: 16 / 9
      }, audio: false
    });
    video.srcObject = stream;
    await video.play().catch(() => {});
  } catch {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
      video.srcObject = stream;
      await video.play().catch(() => {});
    } catch {
      alert('카메라 권한이 필요합니다. (HTTPS 또는 localhost에서 테스트)');
      return;
    }
  }

  // TM 로드(없어도 렌더는 동작)
  try {
    tmModel = await tmImage.load(MODEL_URL + "model.json", MODEL_URL + "metadata.json");
  } catch (e) {
    console.warn("TM 모델 로드 실패:", e);
  }

  // 추론용 캔버스(감지용)
  const inferCanvas = document.createElement('canvas');
  const inferCtx = inferCanvas.getContext('2d', { alpha: false });
  inferCanvas.width = INFER_SIZE;
  inferCanvas.height = INFER_SIZE;

  // DPR 맞춤
  function fitCanvasToStage() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const rect = canvas.getBoundingClientRect();
    const w = Math.max(1, Math.floor(rect.width  * dpr));
    const h = Math.max(1, Math.floor(rect.height * dpr));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width  = w;
      canvas.height = h;
    }
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
  }
  fitCanvasToStage();

  // 프레임 버퍼(원본 저장 → 그릴 때만 90° 회전)
  const APPROX_FPS = 30;
  const BUF_LEN    = Math.ceil(MAX_BUFFER_SEC * APPROX_FPS);
  const buffer = new Array(BUF_LEN).fill(null).map(() => {
    const c = document.createElement('canvas'); c.width = 1920; c.height = 1080; return c;
  });
  const bctx = buffer.map(c => c.getContext('2d', { alpha: false }));
  let head = 0, framesFilled = 0;

  function pushFrame() {
    const vw = video.videoWidth  || 1920;
    const vh = video.videoHeight || 1080;
    const c = buffer[head], b = bctx[head];
    if (c.width !== vw || c.height !== vh) { c.width = vw; c.height = vh; }
    b.drawImage(video, 0, 0, vw, vh);
    head = (head + 1) % BUF_LEN;
    if (framesFilled < BUF_LEN) framesFilled++;
  }

  // 배지 표시 관리
  const badgeEls = {
    y2k:    document.getElementById('badge-y2k'),
    gorp:   document.getElementById('badge-gorp'),
    ballet: document.getElementById('badge-ballet'),
    grunge: document.getElementById('badge-grunge')
  };
  const detectState = { candidateLabel:null, candidateSince:0, activeLabel:null, showing:false, lock:false, clearSince:0 };
  function showOnly(label){
    Object.entries(badgeEls).forEach(([k,el])=>{ if(!el) return; (k===label)?el.classList.add('show'):el.classList.remove('show'); });
  }
  function hideAll(){ Object.values(badgeEls).forEach(el=>el&&el.classList.remove('show')); }

  // ✅ 트리거 시: 배지 표시 + 트레일 시작
  function triggerOnce(label){
    detectState.activeLabel = label; detectState.showing = true; detectState.lock = true; detectState.clearSince = 0;
    showOnly(label);
    spawnBadgeTrail(label, badgeEls);
    setTimeout(()=>{ hideAll(); detectState.showing = false; }, SHOW_MS);
  }

  // TM 추론(원본 비디오 기준)
  let lastInfer = 0;
  async function maybeInfer() {
    if (!tmModel) return;
    const now = performance.now();
    if (now - lastInfer < INFER_INTERVAL_MS) return;
    lastInfer = now;

    const vw = video.videoWidth  || 0;
    const vh = video.videoHeight || 0;
    if (!vw || !vh) return;

    // 중앙 crop
    const scale = Math.max(INFER_SIZE / vw, INFER_SIZE / vh);
    const dw = vw * scale, dh = vh * scale;
    const offX = (dw - INFER_SIZE) / 2;
    const offY = (dh - INFER_SIZE) / 2;

    inferCtx.save();
    inferCtx.drawImage(video, -offX, -offY, dw, dh);
    inferCtx.restore();

    const predictions = await tmModel.predict(inferCanvas);

    if (detectState.lock) {
      const active = detectState.activeLabel;
      const activeProb = predictions.find(p => p.className === active)?.probability ?? 0;
      if (activeProb < LOW_CONF_TO_CLEAR) {
        if (!detectState.clearSince) detectState.clearSince = now;
        else if (now - detectState.clearSince >= CLEAR_MS) {
          detectState.lock = false;
          detectState.candidateLabel = null; detectState.candidateSince = 0; detectState.clearSince = 0;
        }
      } else detectState.clearSince = 0;
      return;
    }

    let best = { className:"", probability:0 };
    for (const p of predictions) if (p.probability > best.probability) best = p;

    if (LABELS.includes(best.className) && best.probability >= CONFIDENCE_THRESHOLD) {
      if (detectState.candidateLabel !== best.className) {
        detectState.candidateLabel = best.className; detectState.candidateSince = now;
      } else if (now - detectState.candidateSince >= STABLE_MS && !detectState.showing) {
        triggerOnce(best.className);
      }
    } else {
      detectState.candidateLabel = null; detectState.candidateSince = 0;
    }
  }

  // 메인 렌더
  (function loop(){
    requestAnimationFrame(loop);
    if (video.readyState < 2) return;

    pushFrame();
    maybeInfer();

    const W = canvas.width, H = canvas.height;
    ctx.clearRect(0, 0, W, H);
    ctx.globalCompositeOperation = 'source-over';

    ctx.save(); // 전역 미러 없음

    const N = STRIP_RATIOS.length;
    const centerIdx = (N - 1) / 2;

    const APPROX_FPS = 30;
    const maxUsable  = Math.max(0, Math.min(BUF_LEN - 1, framesFilled - 1));

    let curY = 0;
    for (let row = 0; row < N; row++) {
      let h = Math.round(H * STRIP_RATIOS[row]);
      let y = curY;
      if (row === N - 1) h = H - curY;
      curY += h;

      const overlapY = y - (row ? 1 : 0);
      const overlapH = h + (row && row < N - 1 ? 2 : 1);

      const dist = Math.abs(row - centerIdx) / Math.max(1, centerIdx);
      const verticalSign = (row < centerIdx ? 1 : (row > centerIdx ? -1 : 0));

      // 행별 지연
      const t = (N === 1) ? 0 : row / (N - 1);
      const stripMaxDelay = Math.pow(t, DELAY_CURVE) * MAX_DELAY_MS;

      const baseFrames = Math.min(maxUsable, Math.floor((stripMaxDelay / 1000) * APPROX_FPS));
      let baseIdx = head - 1 - baseFrames; if (baseIdx < 0) baseIdx += BUF_LEN;
      const baseSrc = buffer[baseIdx];

      // 블러
      const perStripBlur = BASE_BLUR_PX + dist * EXTRA_BLUR_PX_AT_EDGE;
      ctx.filter = perStripBlur > 0 ? `blur(${perStripBlur}px)` : 'none';

      // 기준 프레임(여기서 오른쪽 90° 회전)
      ctx.save();
      ctx.beginPath(); ctx.rect(0, overlapY, W, overlapH); ctx.clip();
      drawCameraCoverRot90(ctx, baseSrc, W, H);
      ctx.restore();

      // 고스트
      const ghostSamples = GHOST_SAMPLES + Math.round(dist * EXTRA_GHOST_SAMPLES_AT_EDGE);
      const ghostAlpha0  = GHOST_ALPHA0 + dist * EXTRA_GHOST_ALPHA_AT_EDGE;

      for (let s = 0; s < ghostSamples; s++) {
        const frac       = (ghostSamples === 1) ? 1 : s / (ghostSamples - 1);
        const extraDelay = frac * stripMaxDelay * GHOST_SPAN;
        const delayMs    = stripMaxDelay - extraDelay;

        const df = Math.min(maxUsable, Math.floor((delayMs / 1000) * APPROX_FPS));
        let idx = head - 1 - df; if (idx < 0) idx += BUF_LEN;

        const src = buffer[idx];
        const a   = ghostAlpha0 * Math.pow(GHOST_DECAY, s);
        if (a <= 0.003) continue;

        ctx.save();
        ctx.globalAlpha = a;
        ctx.beginPath(); ctx.rect(0, overlapY, W, overlapH); ctx.clip();
        drawCameraCoverRot90(ctx, src, W, H);
        ctx.restore();
      }

      // 스트릭
      if (MOTION_STREAKS > 0 && verticalSign !== 0) {
        const maxShift = dist * MOTION_PIXELS_AT_EDGE;
        for (let m = 1; m <= MOTION_STREAKS; m++) {
          const f  = m / MOTION_STREAKS;
          const dx = (verticalSign > 0 ? 1 : -1) * maxShift * f;
          const a  = MOTION_ALPHA0 * Math.pow(MOTION_DECAY, m - 1);
          if (a <= 0.003) continue;

          ctx.save();
          ctx.globalAlpha = a;
          ctx.beginPath(); ctx.rect(0, overlapY, W, overlapH); ctx.clip();
          ctx.translate(dx, 0);
          drawCameraCoverRot90(ctx, baseSrc, W, H);
          ctx.restore();
        }
      }

      // 에지버스
      const birthIntensity = getEdgeBirthIntensity(row, N);
      if (birthIntensity > 0) {
        const dir = (row < centerIdx ? 1 : (row > centerIdx ? -1 : 0));
        const prevComp = ctx.globalCompositeOperation;
        ctx.globalCompositeOperation = EDGE_BIRTH_COMPOSITE;

        const samples   = Math.max(1, Math.round(EDGE_BIRTH_SAMPLES * birthIntensity));
        const alpha0    = EDGE_BIRTH_ALPHA0 * birthIntensity;
        const shiftMax  = EDGE_BIRTH_SHIFT_PX * birthIntensity;
        const extraBlur = EDGE_BIRTH_EXTRA_BLUR * birthIntensity;

        for (let k = 1; k <= samples; k++) {
          const frac = k / samples;
          const lagMs= frac * EDGE_BIRTH_MS;
          const df   = Math.min(maxUsable, Math.floor((lagMs / 1000) * APPROX_FPS));
          let idx = head - 1 - df; if (idx < 0) idx += BUF_LEN;

          const src = buffer[idx];
          const a   = alpha0 * Math.pow(EDGE_BIRTH_DECAY, k - 1);
          if (a <= 0.003) continue;

          const shiftY = dir * frac * shiftMax;

          ctx.save();
          ctx.beginPath(); ctx.rect(0, overlapY, W, overlapH); ctx.clip();
          const prevFilter = ctx.filter;
          ctx.filter = (perStripBlur + extraBlur) > 0 ? `blur(${perStripBlur + extraBlur}px)` : 'none';
          ctx.globalAlpha = a;
          ctx.translate(0, shiftY);
          drawCameraCoverRot90(ctx, src, W, H);
          ctx.filter = prevFilter;
          ctx.restore();
        }
        ctx.globalCompositeOperation = prevComp;
      }

      ctx.filter = 'none';
    }

    // 좌/우 비네트
    (function drawSideVignette(){
      const [r,g,b] = VIGNETTE_RGB;
      const edge = Math.max(20, Math.floor(W * VIGNETTE_WIDTH));

      const gL = ctx.createLinearGradient(0, 0, edge, 0);
      gL.addColorStop(0.0, `rgba(${r},${g},${b},${VIGNETTE_ALPHA})`);
      gL.addColorStop(1.0, `rgba(${r},${g},${b},0)`);
      ctx.fillStyle = gL; ctx.fillRect(0, 0, edge, H);

      const gR = ctx.createLinearGradient(W - edge, 0, W, 0);
      gR.addColorStop(0.0, `rgba(${r},${g},${b},0)`);
      gR.addColorStop(1.0, `rgba(${r},${g},${b},${VIGNETTE_ALPHA})`);
      ctx.fillStyle = gR; ctx.fillRect(W - edge, 0, edge, H);
    })();

    ctx.restore(); // 전역 미러 없음
    ctx.globalAlpha = 1;
  })();
})();
