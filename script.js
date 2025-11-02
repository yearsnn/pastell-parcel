/* =========================
   16:9 스테이지 사이징
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

const MAX_DELAY_MS   = 1000; // 전체 지연
const MAX_BUFFER_SEC = 5;
const DELAY_CURVE    = 2; // 지연 곡선

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
const MODEL_URL = "./tm-outfit/"; // 끝에 / 유지
const LABELS = ["y2k", "gorp", "ballet", "grunge"];

// 90% 이상이 2초 지속될 때만 표시
const INFER_INTERVAL_MS    = 120;
const CONFIDENCE_THRESHOLD = 0.90;
const STABLE_MS            = 2000;
// 오브젝트 “사라짐” 판정(락 해제용)
const LOW_CONF_TO_CLEAR    = 0.30;
const CLEAR_MS             = 800;
// 표시 시간(페이드 인/아웃은 CSS transition이 처리)
const SHOW_MS              = 1500;

const INFER_SIZE = 224;
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

  // TM 모델 로드 (모델 없어도 이펙트는 동작)
  try {
    tmModel = await tmImage.load(
      MODEL_URL + "model.json",
      MODEL_URL + "metadata.json"
    );
  } catch (e) {
    console.error("Teachable Machine 모델 로드 실패:", e);
    alert("모델 로드 실패: /tm-outfit/ 경로와 파일들을 확인하세요.");
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
    // 회전 적용 후 소스 크기(폭/높이)는 영상의 세로/가로와 동일
    c.width  = 1080; // 초기값(회전 후 폭)
    c.height = 1920; // 초기값(회전 후 높이)
    return c;
  });
  const bctx = buffer.map(c => c.getContext('2d', { alpha: false }));
  let head = 0, framesFilled = 0;

  // 🔄 카메라 프레임을 버퍼에 적재할 때 "시계 방향 90° 회전" 적용
  function pushFrame() {
    const vw = video.videoWidth  || 1920; // 원본 영상 폭
    const vh = video.videoHeight || 1080; // 원본 영상 높이

    const rotW = vh; // 회전 후 폭
    const rotH = vw; // 회전 후 높이

    const c = buffer[head], b = bctx[head];
    if (c.width !== rotW || c.height !== rotH) { c.width = rotW; c.height = rotH; }

    b.save();
    b.clearRect(0, 0, rotW, rotH);
    // 캔버스 좌표계를 회전: (rotW, 0)로 평행이동 이후 90° 회전
    b.translate(rotW, 0);
    b.rotate(Math.PI / 2);
    // 회전된 좌표계에서 원본 영상을 그대로 그리면 결과가 시계 방향 90°
    b.drawImage(video, 0, 0, vw, vh);
    b.restore();

    head = (head + 1) % BUF_LEN;
    if (framesFilled < BUF_LEN) framesFilled++;
  }

  // ===== 감지 배지 표시 (겹침 방지: 한 번에 하나만) =====
  const badgeEls = {
    y2k:    document.getElementById('badge-y2k'),
    gorp:   document.getElementById('badge-gorp'),
    ballet: document.getElementById('badge-ballet'),
    grunge: document.getElementById('badge-grunge')
  };
  function showOnly(label) {
    Object.entries(badgeEls).forEach(([k, el]) => {
      if (!el) return;
      if (k === label) el.classList.add('show');
      else el.classList.remove('show');
    });
  }
  function hideAll() {
    Object.values(badgeEls).forEach(el => el && el.classList.remove('show'));
  }

  // ===== 안정 인식 + 1회 표시 + lock 상태 머신 =====
  const detectState = {
    candidateLabel: null,
    candidateSince: 0,
    activeLabel: null,
    showing: false,
    lock: false,
    clearSince: 0
  };

  function triggerOnce(label) {
    detectState.activeLabel = label;
    detectState.showing = true;
    detectState.lock = true;
    detectState.clearSince = 0;

    showOnly(label);
    setTimeout(() => {
      hideAll();
      detectState.showing = false;
    }, SHOW_MS);
  }

  // ===== TM 추론 루프 (표시 회전과 무관, 기존 유지) =====
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

    if (detectState.lock) {
      const active = detectState.activeLabel;
      const activeProb = predictions.find(p => p.className === active)?.probability ?? 0;
      if (activeProb < LOW_CONF_TO_CLEAR) {
        if (!detectState.clearSince) detectState.clearSince = now;
        else if (now - detectState.clearSince >= CLEAR_MS) {
          detectState.lock = false;
          detectState.candidateLabel = null;
          detectState.candidateSince = 0;
          detectState.clearSince = 0;
        }
      } else {
        detectState.clearSince = 0;
      }
      return;
    }

    let best = { className: "", probability: 0 };
    for (const p of predictions) if (p.probability > best.probability) best = p;

    if (LABELS.includes(best.className) && best.probability >= CONFIDENCE_THRESHOLD) {
      if (detectState.candidateLabel !== best.className) {
        detectState.candidateLabel = best.className;
        detectState.candidateSince = now;
      } else {
        if (now - detectState.candidateSince >= STABLE_MS && !detectState.showing) {
          triggerOnce(best.className);
        }
      }
    } else {
      detectState.candidateLabel = null;
      detectState.candidateSince = 0;
    }
  }

  // ===== 메인 렌더 루프 =====
  (function loop() {
    requestAnimationFrame(loop);
    if (video.readyState < 2) return;

    pushFrame();   // 버퍼에 "회전된" 현재 프레임 저장
    maybeInfer();  // (주기적으로) TM 추론

    const W  = canvas.width, H = canvas.height;

    // 최근(회전된) 프레임의 소스 크기
    const lastIdx = (head - 1 + BUF_LEN) % BUF_LEN;
    const srcW = buffer[lastIdx].width;   // = video.videoHeight
    const srcH = buffer[lastIdx].height;  // = video.videoWidth

    // cover 스케일 (회전된 소스 → 캔버스)
    const scale = Math.max(W / srcW, H / srcH);
    const drawW = srcW * scale, drawH = srcH * scale;
    const offX  = (drawW - W) / 2, offY = (drawH - H) / 2;

    ctx.clearRect(0, 0, W, H);
    ctx.globalCompositeOperation = 'source-over';

    // 좌우 반전(거울) 유지
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
