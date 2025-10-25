/* =========================
   16:9 스테이지 사이징 (JS 계산)
   ========================= */
function updateStageSize() {
  const stage = document.querySelector('.stage');
  const aspect = 16 / 9;
  const winW = window.innerWidth;
  const winH = window.innerHeight;
  const winRatio = winW / winH;

  let width, height;
  if (winRatio > aspect) {
    height = winH;
    width  = Math.round(height * aspect);
  } else {
    width  = winW;
    height = Math.round(width / aspect);
  }

  stage.style.width  = `${width}px`;
  stage.style.height = `${height}px`;
  stage.style.left   = '50%';
  stage.style.top    = '50%';
  stage.style.transform = 'translate(-50%, -50%)';
}

/* =========================
   이펙트(베이스라인) 설정
   ========================= */
const STRIP_RATIOS = [0.10, 0.20, 0.40, 0.20, 0.10];

const MAX_DELAY_MS   = 450; // 전체 지연 축소
const MAX_BUFFER_SEC = 2;
const DELAY_CURVE    = 1.6; // 지연 곡선(아래쪽에만 약간 더)

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

/* =========================
   Teachable Machine 설정
   ========================= */
// 네가 /tm-outfit/ 에 모델 3종(model.json, metadata.json, weights.bin) 넣었다고 했으니:
const MODEL_URL = "./tm-outfit/"; // 끝에 / 유지

// 라벨(모델의 클래스명과 정확히 일치해야 함)
const LABELS = ["y2k", "gorp", "ballet", "grunge"];

// 추론 파라미터
const INFER_INTERVAL_MS    = 120;  // 추론 주기(ms)
const CONFIDENCE_THRESHOLD = 0.80; // 임계치
const SHOW_MS              = 1000; // 배지 표시 시간
const COOLDOWN_MS          = 1400; // 같은 라벨 연속 노출 쿨다운
const INFER_SIZE           = 224;  // TM 기본 입력 크기
let tmModel = null;

/* =========================
   메인 초기화
   ========================= */
(async () => {
  const stage  = document.querySelector('.stage');
  const video  = document.getElementById('cam');
  const canvas = document.getElementById('view');
  const ctx    = canvas.getContext('2d', { alpha: false });

  // 16:9 스테이지 크기 계산
  updateStageSize();
  window.addEventListener('resize', () => {
    updateStageSize();
    fitCanvasToStage();
  }, { passive: true });

  // 카메라 시작 (거울 표현 위해 전면 권장)
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: { ideal: 'user' },
        width:  { ideal: 1920, min: 1280 },
        height: { ideal: 1080, min: 720 },
        aspectRatio: 16 / 9
      },
      audio: false
    });
    video.srcObject = stream;
    await video.play().catch(() => {});
  } catch (e) {
    // 폴백: 기본 카메라
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
      video.srcObject = stream;
      await video.play().catch(() => {});
    } catch (e2) {
      alert('카메라 권한이 필요합니다. (HTTPS 또는 localhost에서 테스트하세요)');
      return;
    }
  }

  // TM 모델 로드
  try {
    tmModel = await tmImage.load(
      MODEL_URL + "model.json",
      MODEL_URL + "metadata.json"
    );
  } catch (e) {
    console.error("Teachable Machine 모델 로드 실패:", e);
    alert("모델 로드 실패: /tm-outfit/ 경로와 파일들을 확인하세요.");
    // 모델 없어도 웹캠/이펙트는 동작하게 계속 진행
  }

  // 추론용 오프스크린 캔버스 (좌우 반전 후 전달)
  const inferCanvas = document.createElement('canvas');
  const inferCtx = inferCanvas.getContext('2d', { alpha: false });
  inferCanvas.width = INFER_SIZE;
  inferCanvas.height = INFER_SIZE;

  // 캔버스 픽셀 크기(DPR) 맞추기
  function fitCanvasToStage() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const rect = canvas.getBoundingClientRect(); // 스테이지와 동일
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

  // ===== 프레임 버퍼 =====
  const APPROX_FPS = 30;
  const BUF_LEN    = Math.ceil(MAX_BUFFER_SEC * APPROX_FPS);

  const buffer = new Array(BUF_LEN).fill(null).map(() => {
    const c = document.createElement('canvas');
    c.width = 1920; c.height = 1080; // 초기값
    return c;
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

  // ===== 감지 배지 표시 =====
  const badgeEls = {
    y2k:    document.getElementById('badge-y2k'),
    gorp:   document.getElementById('badge-gorp'),
    ballet: document.getElementById('badge-ballet'),
    grunge: document.getElementById('badge-grunge')
  };
  const lastShownAt = { y2k: 0, gorp: 0, ballet: 0, grunge: 0 };
  const hideTimers  = { y2k: null, gorp: null, ballet: null, grunge: null };

  function showBadge(label) {
    const el = badgeEls[label];
    if (!el) return;
    const now = performance.now();
    if (now - lastShownAt[label] < COOLDOWN_MS) return; // 쿨다운
    lastShownAt[label] = now;

    el.classList.add('show');
    if (hideTimers[label]) clearTimeout(hideTimers[label]);
    hideTimers[label] = setTimeout(() => el.classList.remove('show'), SHOW_MS);
  }

  // ===== TM 추론 루프 =====
  let lastInfer = 0;
  async function maybeInfer() {
    if (!tmModel) return;
    const now = performance.now();
    if (now - lastInfer < INFER_INTERVAL_MS) return;
    lastInfer = now;

    const vw = video.videoWidth  || 0;
    const vh = video.videoHeight || 0;
    if (!vw || !vh) return;

    // cover로 중앙 영역을 INFER_SIZE로 취하고 좌우 반전(거울 일관성)
    const scale = Math.max(INFER_SIZE / vw, INFER_SIZE / vh);
    const dw = vw * scale, dh = vh * scale;
    const offX = (dw - INFER_SIZE) / 2;
    const offY = (dh - INFER_SIZE) / 2;

    inferCtx.save();
    inferCtx.translate(INFER_SIZE, 0);
    inferCtx.scale(-1, 1);
    inferCtx.drawImage(video, -offX, -offY, dw, dh);
    inferCtx.restore();

    const predictions = await tmModel.predict(inferCanvas);
    let best = { className: "", probability: 0 };
    for (const p of predictions) {
      if (p.probability > best.probability) best = p;
    }

    if (LABELS.includes(best.className) && best.probability >= CONFIDENCE_THRESHOLD) {
      showBadge(best.className);
    }
  }

  // ===== 메인 렌더 루프 =====
  (function loop() {
    requestAnimationFrame(loop);
    if (video.readyState < 2) return;

    pushFrame();   // 버퍼에 현재 프레임 저장
    maybeInfer();  // (주기적으로) TM 추론

    const W  = canvas.width, H = canvas.height;
    const vw = video.videoWidth  || 1920;
    const vh = video.videoHeight || 1080;

    // cover 스케일 (영상 → 캔버스)
    const scale = Math.max(W / vw, H / vh);
    const drawW = vw * scale, drawH = vh * scale;
    const offX  = (drawW - W) / 2, offY = (drawH - H) / 2;

    ctx.clearRect(0, 0, W, H);
    ctx.globalCompositeOperation = 'source-over';

    // 좌우 반전(거울)
    ctx.save();
    ctx.translate(W, 0);
    ctx.scale(-1, 1);

    const N = STRIP_RATIOS.length;
    const centerIdx = (N - 1) / 2;

    // 행 누적 렌더
    let curY = 0;
    for (let row = 0; row < N; row++) {
      let h = Math.round(H * STRIP_RATIOS[row]);
      let y = curY;
      if (row === N - 1) { h = H - curY; }
      curY += h;

      // 이음새 미세 겹침
      const overlapY = y - (row ? 1 : 0);
      const overlapH = h + (row && row < N - 1 ? 2 : 1);

      const dist = Math.abs(row - centerIdx) / Math.max(1, centerIdx);
      const verticalSign = (row < centerIdx ? 1 : (row > centerIdx ? -1 : 0));

      // 행별 지연(곡선 적용)
      const t = (N === 1) ? 0 : row / (N - 1);
      const stripMaxDelay = Math.pow(t, DELAY_CURVE) * MAX_DELAY_MS;

      const maxUsable  = Math.max(0, Math.min(BUF_LEN - 1, framesFilled - 1));
      const baseFrames = Math.min(maxUsable, Math.floor((stripMaxDelay / 1000) * APPROX_FPS));
      let baseIdx      = head - 1 - baseFrames; if (baseIdx < 0) baseIdx += BUF_LEN;
      const baseSrc    = buffer[baseIdx];

      // 블러(중앙 선명, 위/아래 더 블러)
      const perStripBlur = BASE_BLUR_PX + dist * EXTRA_BLUR_PX_AT_EDGE;
      ctx.filter = perStripBlur > 0 ? `blur(${perStripBlur}px)` : 'none';

      // 기준 프레임
      ctx.save();
      ctx.globalAlpha = 1;
      ctx.beginPath(); ctx.rect(0, overlapY, W, overlapH); ctx.clip();
      ctx.drawImage(baseSrc, -offX, -offY, drawW, drawH);
      ctx.restore();

      // 고스트(잔상)
      const ghostSamples = GHOST_SAMPLES + Math.round(dist * EXTRA_GHOST_SAMPLES_AT_EDGE);
      const ghostAlpha0  = GHOST_ALPHA0 + dist * EXTRA_GHOST_ALPHA_AT_EDGE;

      for (let s = 0; s < ghostSamples; s++) {
        const frac      = (ghostSamples === 1) ? 1 : s / (ghostSamples - 1);
        const extraDelay= frac * stripMaxDelay * GHOST_SPAN;
        const delayMs   = stripMaxDelay - extraDelay;

        const desired   = Math.floor((delayMs / 1000) * APPROX_FPS);
        const df        = Math.min(maxUsable, desired);
        let idx = head - 1 - df; if (idx < 0) idx += BUF_LEN;

        const src = buffer[idx];
        const a   = ghostAlpha0 * Math.pow(GHOST_DECAY, s);
        if (a <= 0.003) continue;

        ctx.save();
        ctx.globalAlpha = a;
        ctx.beginPath(); ctx.rect(0, overlapY, W, overlapH); ctx.clip();
        ctx.drawImage(src, -offX, -offY, drawW, drawH);
        ctx.restore();
      }

      // 스트릭(가로 끌림)
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
          ctx.drawImage(baseSrc, -offX, -offY, drawW, drawH);
          ctx.restore();
        }
      }

      // 에지버스(상/하에서 안쪽으로)
      const birthIntensity = getEdgeBirthIntensity(row, N);
      if (birthIntensity > 0) {
        const dir = verticalSign;
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
          const blurPx = (perStripBlur + extraBlur);
          ctx.filter = blurPx > 0 ? `blur(${blurPx}px)` : 'none';
          ctx.globalAlpha = a;
          ctx.translate(0, shiftY);
          ctx.drawImage(src, -offX, -offY, drawW, drawH);
          ctx.filter = prevFilter;
          ctx.restore();
        }

        ctx.globalCompositeOperation = prevComp;
      }

      // 행별 필터 초기화
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

    ctx.restore(); // 거울 해제
    ctx.globalAlpha = 1;
  })();
})();
