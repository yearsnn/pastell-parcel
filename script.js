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
const STRIP_RATIOS = [0.10, 0.20, 0.40, 0.20, 0.10];

const MAX_DELAY_MS   = 1000;
const MAX_BUFFER_SEC = 5;
const DELAY_CURVE    = 2;

const GHOST_SAMPLES = 5;
const GHOST_SPAN    = 0.45;
const GHOST_ALPHA0  = 0.14;
const GHOST_DECAY   = 0.75;

const BASE_BLUR_PX = 0.8;

const VIGNETTE_ALPHA = 0.30;
const VIGNETTE_WIDTH = 0.06;
const VIGNETTE_RGB   = [0, 0, 0];

const EXTRA_BLUR_PX_AT_EDGE   = 2.2;
const EXTRA_GHOST_ALPHA_AT_EDGE   = 0.08;
const EXTRA_GHOST_SAMPLES_AT_EDGE = 2;

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
 * ✅ 카메라 소스만 +90° 회전하여 cover로 그리는 공통 헬퍼
 *  - ctx:   현재 컨텍스트(미러/클립 적용 이후)
 *  - src:   HTMLCanvasElement(버퍼 프레임)
 *  - W, H:  최종 캔버스 크기(= canvas.width/height)
 *************************************************/
function drawCameraCoverRot90(ctx, src, W, H) {
  const sW = src.width, sH = src.height;
  // +90° 회전하면 (높이,너비) 순으로 들어가므로 cover 스케일을 (H/sW, W/sH)로 비교
  const scale = Math.max(W / sH, H / sW);
  const drawW = sW * scale;
  const drawH = sH * scale;

  ctx.save();
  // 화면 중심 기준으로 회전
  ctx.translate(W / 2, H / 2);
  ctx.rotate(-Math.PI / 2);
            // 시계 방향 90°
  // 회전 좌표계에서 중앙 정렬
  ctx.drawImage(src, -drawW / 2, -drawH / 2, drawW, drawH);
  ctx.restore();
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

  // 추론용 캔버스(회전하지 않음 — 감지는 기존 관성 유지)
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

  // 프레임 버퍼(원본(미회전) 저장 → 그릴 때만 회전)
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
  const SHOW_MS = 1500;
  function showOnly(label){
    Object.entries(badgeEls).forEach(([k,el])=>{ if(!el) return; (k===label)?el.classList.add('show'):el.classList.remove('show'); });
  }
  function hideAll(){ Object.values(badgeEls).forEach(el=>el&&el.classList.remove('show')); }
  function triggerOnce(label){
    detectState.activeLabel = label; detectState.showing = true; detectState.lock = true; detectState.clearSince = 0;
    showOnly(label);
    setTimeout(()=>{ hideAll(); detectState.showing = false; }, SHOW_MS);
  }

  // TM 추론(원본 기준, 회전 적용 안 함)
  let lastInfer = 0;
  async function maybeInfer() {
    if (!tmModel) return;
    const now = performance.now();
    if (now - lastInfer < INFER_INTERVAL_MS) return;
    lastInfer = now;

    const vw = video.videoWidth  || 0;
    const vh = video.videoHeight || 0;
    if (!vw || !vh) return;

    const scale = Math.max(INFER_SIZE / vw, INFER_SIZE / vh);
    const dw = vw * scale, dh = vh * scale;
    const offX = (dw - INFER_SIZE) / 2;
    const offY = (dh - INFER_SIZE) / 2;

    inferCtx.save();
    // 미러 일관성
    inferCtx.translate(INFER_SIZE, 0);
    inferCtx.scale(-1, 1);
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
    } else { detectState.candidateLabel = null; detectState.candidateSince = 0; }
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

    // 미러(좌우반전)는 기존 유지
    ctx.save();
    ctx.translate(W, 0);
    ctx.scale(-1, 1);

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

      // 기준 프레임(여기서만 +90° 회전)
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

    ctx.restore(); // 미러 해제
    ctx.globalAlpha = 1;
  })();
})();
