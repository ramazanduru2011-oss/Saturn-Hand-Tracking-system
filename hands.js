/**
 * hands.js — MediaPipe Hands tracking + pinch gesture detection
 *
 * Runs entirely independently of main.js / Three.js.
 * Draws hand landmarks and gesture state on #hand-canvas.
 *
 * Public API on window.handData (consumed by main.js later):
 *   .hands[]        — smoothed landmark arrays per detected hand
 *   .active         — true when ≥1 hand is visible
 *   .isPinching     — true when primary hand is pinching
 *   .pinchDistance  — raw normalised distance this frame (0‥1)
 */

(function () {

  // ─── DOM refs ──────────────────────────────────────────────────────────────

  const video         = document.getElementById('webcam');
  const overlayCanvas = document.getElementById('hand-canvas');
  const ctx           = overlayCanvas.getContext('2d');

  // Status badge injected by this module
  const status = document.createElement('div');
  status.id    = 'hand-status';
  status.textContent = 'Requesting camera…';
  document.body.appendChild(status);

  function setStatus(msg, autoHide = false) {
    status.classList.remove('hidden');
    status.textContent = msg;
    if (autoHide) setTimeout(() => status.classList.add('hidden'), 2500);
  }
  // Expose so main.js can post calibration confirmations
  window.__setStatus = setStatus;

  // ─── Canvas sizing ─────────────────────────────────────────────────────────

  function resizeOverlay() {
    overlayCanvas.width  = window.innerWidth;
    overlayCanvas.height = window.innerHeight;
  }
  resizeOverlay();
  window.addEventListener('resize', resizeOverlay);

  // ─── Landmark smoothing ────────────────────────────────────────────────────
  // Exponential moving average per joint reduces per-frame jitter.

  const SMOOTH        = 0.65;
  let prevLandmarks   = [];

  function smoothLandmarks(handIndex, rawPoints) {
    if (!prevLandmarks[handIndex]) {
      prevLandmarks[handIndex] = rawPoints.map(p => ({ ...p }));
      return prevLandmarks[handIndex];
    }
    const prev = prevLandmarks[handIndex];
    const out  = rawPoints.map((p, i) => ({
      x: prev[i].x * SMOOTH + p.x * (1 - SMOOTH),
      y: prev[i].y * SMOOTH + p.y * (1 - SMOOTH),
      z: prev[i].z * SMOOTH + p.z * (1 - SMOOTH),
    }));
    prevLandmarks[handIndex] = out;
    return out;
  }

  // ─── Pinch detection ───────────────────────────────────────────────────────
  //
  // MediaPipe landmark indices:
  //   4  = thumb tip
  //   8  = index finger tip
  //   0  = wrist  (used to normalise distance so hand size doesn't matter)
  //   9  = middle MCP (palm centre proxy for normalisation)
  //
  // We normalise the raw distance by the wrist→middleMCP span so the
  // threshold works regardless of how close the hand is to the camera.
  //
  // Hysteresis: two separate thresholds (CLOSE / OPEN) prevent rapid
  // flickering right at the boundary.

  const PINCH_CLOSE_THRESHOLD = 0.10; // normalised — fingers must get THIS close to pinch
  const PINCH_OPEN_THRESHOLD  = 0.16; // must open THIS far to un-pinch
  // gap between the two thresholds is the "dead zone" that kills flicker

  // Smoothed pinch distance — EMA with its own factor for extra stability
  const PINCH_SMOOTH = 0.55;
  let smoothPinchDist = null;

  // Hysteresis state per hand (we track only the primary/first hand for isPinching)
  let _isPinching = false;

  function calcPinch(landmarks) {
    const thumb  = landmarks[4];  // Thumb Tip
    const index  = landmarks[8];  // Index Finger Tip
    const wrist  = landmarks[0];  // Wrist
    const midMCP = landmarks[9];  // Middle-finger MCP (palm centre proxy)

    // ── Raw Euclidean distance between thumb tip and index tip ──────────────
    // Measured in normalised [0..1] screen space, x/y only
    // (z from MediaPipe is depth-estimated and less reliable for 2-D distance).
    const dx      = thumb.x - index.x;
    const dy      = thumb.y - index.y;
    const rawDist = Math.sqrt(dx * dx + dy * dy);

    // ── Palm-size normalisation ─────────────────────────────────────────────
    // Dividing by wrist→middleMCP makes the threshold camera-distance-agnostic:
    // a hand far away will have a smaller rawDist but also a smaller palmSize,
    // so normDist stays consistent regardless of how close the user sits.
    const px       = wrist.x - midMCP.x;
    const py       = wrist.y - midMCP.y;
    const palmSize = Math.sqrt(px * px + py * py) || 0.001;
    const normDist = rawDist / palmSize;

    // ── EMA smoothing on the distance signal ────────────────────────────────
    // Absorbs landmark jitter before it hits the threshold comparisons.
    if (smoothPinchDist === null) smoothPinchDist = normDist;
    smoothPinchDist = smoothPinchDist * PINCH_SMOOTH + normDist * (1 - PINCH_SMOOTH);

    // ── Hysteresis state machine ────────────────────────────────────────────
    // Two different thresholds: fingers must close past CLOSE to enter pinch,
    // and must open past OPEN to exit it.  The gap between them is a dead zone
    // that prevents rapid OPEN/CLOSED flickering when fingers hover at the edge.
    if (_isPinching) {
      if (smoothPinchDist > PINCH_OPEN_THRESHOLD)  _isPinching = false;
    } else {
      if (smoothPinchDist < PINCH_CLOSE_THRESHOLD) _isPinching = true;
    }

    // ── Pinch centre — the rotation handle ─────────────────────────────────
    // Midpoint between thumb tip and index tip, already in normalised space.
    // This point is what we track for delta_x / delta_y during pinch-drag.
    // Using the midpoint (not the full palm centroid) makes rotation feel
    // directly "attached" to the pinch grip — more intuitive and precise.
    // We mirror x (1 - x) to match the selfie / mirror convention used everywhere.
    const pinchCX = 1 - (thumb.x + index.x) * 0.5;
    const pinchCY =     (thumb.y + index.y) * 0.5;

    return {
      isPinching: _isPinching,
      distance:   smoothPinchDist,
      pinchCX,    // normalised screen x of pinch centre (mirrored)
      pinchCY,    // normalised screen y of pinch centre
    };
  }

  // ─── Fist Detection ──────────────────────────────────────────────────────────
  //
  // Strategy: compare each fingertip distance-from-wrist against its MCP joint.
  // If the tip is closer to the wrist than the MCP (× a slack factor), the finger
  // is curled.  Needs ≥3 of 4 fingers curled → fist.
  //
  // Uses only x/y (MediaPipe's z is unreliable for this comparison).
  // Rotation-invariant: works at any hand angle / distance from camera.
  //
  // FIST hysteresis: CURL_OPEN → open; CURL_CLOSE → close (prevents flicker).
  const FIST_CURL_SLACK = 1.15;  // tip must be < MCP_dist × this to count as curled
  const FIST_FINGERS    = 3;     // minimum curled fingers to call it a fist
  let   _isFist         = false;

  function detectFist(landmarks) {
    const wrist = landmarks[0];
    const tips  = [8, 12, 16, 20];
    const mcps  = [5,  9, 13, 17];
    let   curledCount = 0;

    for (let i = 0; i < 4; i++) {
      const tip    = landmarks[tips[i]];
      const mcp    = landmarks[mcps[i]];
      const tipD   = Math.hypot(tip.x - wrist.x, tip.y - wrist.y);
      const mcpD   = Math.hypot(mcp.x - wrist.x, mcp.y - wrist.y);
      if (tipD < mcpD * FIST_CURL_SLACK) curledCount++;
    }

    // Simple on/off hysteresis to prevent flutter
    if (!_isFist && curledCount >= FIST_FINGERS)     _isFist = true;
    if (_isFist  && curledCount < FIST_FINGERS - 1)  _isFist = false;

    return _isFist;
  }


  // ─── Drawing ───────────────────────────────────────────────────────────────

  const FINGERTIPS = [4, 8, 12, 16, 20];
  const TIP_COLORS = ['#ff6b6b', '#ffd93d', '#6bcb77', '#4d96ff', '#c77dff'];

  // Converts normalised landmark to canvas pixel, mirroring x for selfie view
  function toScreen(lm) {
    return {
      x: (1 - lm.x) * overlayCanvas.width,
      y: lm.y       * overlayCanvas.height,
    };
  }

  function drawSkeleton(screenPts, pinching) {
    ctx.save();
    // Skeleton colour shifts to gold when pinching
    ctx.strokeStyle = pinching
      ? 'rgba(255, 210, 80, 0.85)'
      : 'rgba(180, 220, 255, 0.75)';
    ctx.lineWidth   = 2.5;
    ctx.lineJoin    = 'round';
    ctx.lineCap     = 'round';

    for (const [a, b] of HAND_CONNECTIONS) {
      ctx.beginPath();
      ctx.moveTo(screenPts[a].x, screenPts[a].y);
      ctx.lineTo(screenPts[b].x, screenPts[b].y);
      ctx.stroke();
    }
    ctx.restore();
  }

  function drawJoints(screenPts) {
    for (const { x, y } of screenPts) {
      ctx.save();
      ctx.beginPath();
      ctx.arc(x, y, 4, 0, Math.PI * 2);
      ctx.fillStyle   = 'rgba(255,255,255,0.90)';
      ctx.shadowColor = 'rgba(100,180,255,0.9)';
      ctx.shadowBlur  = 8;
      ctx.fill();
      ctx.restore();
    }
  }

  function drawFingertips(screenPts, pinching) {
    FINGERTIPS.forEach((idx, fi) => {
      const { x, y } = screenPts[idx];
      // Thumb (0) and index (1) tips get extra emphasis when pinching
      const isPinchPair = pinching && (fi === 0 || fi === 1);
      const outerR = isPinchPair ? 16 : 11;
      const innerR = isPinchPair ? 8  : 6;

      ctx.save();
      ctx.beginPath();
      ctx.arc(x, y, outerR, 0, Math.PI * 2);
      ctx.strokeStyle = isPinchPair ? '#ffe066' : TIP_COLORS[fi];
      ctx.lineWidth   = isPinchPair ? 2.5 : 2;
      ctx.globalAlpha = 0.65;
      ctx.stroke();

      ctx.beginPath();
      ctx.arc(x, y, innerR, 0, Math.PI * 2);
      ctx.fillStyle   = isPinchPair ? '#ffe066' : TIP_COLORS[fi];
      ctx.globalAlpha = 0.95;
      ctx.shadowColor = isPinchPair ? '#ffe066' : TIP_COLORS[fi];
      ctx.shadowBlur  = isPinchPair ? 20 : 14;
      ctx.fill();
      ctx.restore();
    });
  }

  function drawPinchBridge(screenPts, pinching, distance) {
    // Line connecting thumb tip ↔ index tip — shrinks and brightens on close
    const thumb = screenPts[4];
    const index = screenPts[8];
    const alpha = pinching ? 0.95 : Math.max(0, 0.5 - distance * 1.5);

    ctx.save();
    ctx.beginPath();
    ctx.moveTo(thumb.x, thumb.y);
    ctx.lineTo(index.x, index.y);
    ctx.strokeStyle = pinching ? '#ffe066' : 'rgba(255,255,255,0.6)';
    ctx.lineWidth   = pinching ? 3 : 1.5;
    ctx.globalAlpha = alpha;
    ctx.setLineDash(pinching ? [] : [4, 4]);
    ctx.stroke();
    ctx.restore();
  }

  function drawWristLabel(screenPts, handedness) {
    const { x, y } = screenPts[0];
    ctx.save();
    ctx.font        = '600 13px "SF Mono","Fira Code",monospace';
    ctx.fillStyle   = 'rgba(255,255,255,0.8)';
    ctx.shadowColor = 'rgba(0,0,0,0.8)';
    ctx.shadowBlur  = 6;
    ctx.fillText(handedness, x + 12, y + 5);
    ctx.restore();
  }

  // ── Gesture badge (OPEN / CLOSED) ──────────────────────────────────────────
  //
  // Drawn directly on the canvas so it's layered with the hand,
  // not as a DOM element (avoids HTML reflow on every frame).
  // Positioned top-left at a fixed offset, updates each frame.

  // We animate the badge opacity with a small EMA for a soft fade
  let badgeOpacity = 0;

  function drawGestureBadge(pinching) {
    const label     = pinching ? 'CLOSED' : 'OPEN';
    const color     = pinching ? '#ffe066' : '#6bcb77';
    const targetAlpha = 1.0;

    // Smooth opacity towards 1 when a hand is present (called only when hand exists)
    badgeOpacity = badgeOpacity * 0.85 + targetAlpha * 0.15;

    const W = overlayCanvas.width;
    const pad = 18;
    const bx  = pad;
    const by  = pad;
    const bw  = 130;
    const bh  = 44;
    const r   = 10;

    ctx.save();
    ctx.globalAlpha = badgeOpacity;

    // Background pill
    ctx.beginPath();
    ctx.moveTo(bx + r, by);
    ctx.lineTo(bx + bw - r, by);
    ctx.quadraticCurveTo(bx + bw, by,      bx + bw, by + r);
    ctx.lineTo(bx + bw, by + bh - r);
    ctx.quadraticCurveTo(bx + bw, by + bh, bx + bw - r, by + bh);
    ctx.lineTo(bx + r,  by + bh);
    ctx.quadraticCurveTo(bx,      by + bh, bx, by + bh - r);
    ctx.lineTo(bx, by + r);
    ctx.quadraticCurveTo(bx, by,  bx + r, by);
    ctx.closePath();
    ctx.fillStyle = 'rgba(0,0,0,0.52)';
    ctx.fill();
    ctx.strokeStyle = color;
    ctx.lineWidth   = 1.5;
    ctx.stroke();

    // Status dot
    ctx.beginPath();
    ctx.arc(bx + 20, by + bh / 2, 6, 0, Math.PI * 2);
    ctx.fillStyle   = color;
    ctx.shadowColor = color;
    ctx.shadowBlur  = pinching ? 12 : 6;
    ctx.fill();

    // Label text
    ctx.font        = `700 15px "SF Mono","Fira Code",monospace`;
    ctx.fillStyle   = color;
    ctx.shadowBlur  = 0;
    ctx.fillText(label, bx + 34, by + bh / 2 + 5);

    ctx.restore();
  }

  // Fade badge out when no hand is detected
  function fadeBadge() {
    if (badgeOpacity < 0.01) return;
    badgeOpacity *= 0.88;

    const bx = 18, by = 18, bw = 130, bh = 44;
    ctx.clearRect(bx - 2, by - 2, bw + 4, bh + 4);
  }

  // ─── Per-hand render ───────────────────────────────────────────────────────

  function renderHand(landmarks, handedness, isPrimary) {
    const screenPts             = landmarks.map(toScreen);
    const { isPinching, distance } = isPrimary
      ? calcPinch(landmarks)
      : { isPinching: false, distance: 1 };

    drawSkeleton(screenPts, isPrimary && isPinching);
    drawJoints(screenPts);
    drawFingertips(screenPts, isPrimary && isPinching);
    drawPinchBridge(screenPts, isPrimary && isPinching, distance);
    drawWristLabel(screenPts, handedness);

    return { isPinching, distance };
  }

  // ─── Shared state (consumed by main.js) ───────────────────────────────────

  window.handData = {
    hands:         [],   // array of { landmarks, handedness, score }
    active:        false,
    isPinching:    false,
    pinchDistance: 1.0,
    pinchCX:       0.5,   // normalised x of thumb-index midpoint (mirrored)
    pinchCY:       0.5,   // normalised y of thumb-index midpoint
    // ── Depth-scale gesture (single hand) ────────────────────────────────────
    // palmSpan: Euclidean distance between landmark[0] (wrist) and
    //           landmark[9] (middle-finger MCP base) in normalised [0..1] space.
    //
    // This distance grows as the hand physically moves CLOSER to the webcam
    // (perspective makes the hand appear larger) and shrinks as it moves AWAY.
    // It is immune to hand rotation/tilt because wrist→middleMCP is the stable
    // anatomical spine of the palm, not an extremity.
    //
    // main.js owns calibration, smoothing, clamping, and scale application.
    // hands.js only measures and publishes the raw value each frame.
    palmSpan:      0,     // raw float, typically 0.05 (far) – 0.40 (very close)
    palmSpanReady: false, // true once at least one valid reading exists
    isFist:        false, // true when primary hand is in a fist (triggers ring implosion)
  };

  // ─── MediaPipe Hands — must be created BEFORE onResults is called ──────────

  const hands = new Hands({
    locateFile: (file) =>
      `https://cdn.jsdelivr.net/npm/@mediapipe/hands/${file}`,
  });

  hands.setOptions({
    maxNumHands:            2,
    modelComplexity:        1,
    minDetectionConfidence: 0.75,
    minTrackingConfidence:  0.65,
  });

  // ─── MediaPipe result handler ──────────────────────────────────────────────

  hands.onResults((results) => {
    ctx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);

    const detected = results.multiHandLandmarks || [];
    const labels   = results.multiHandedness   || [];

    prevLandmarks = prevLandmarks.slice(0, detected.length);
    if (detected.length === 0) smoothPinchDist = null;

    window.handData.active = detected.length > 0;
    window.handData.hands  = [];

    let primaryPinch = { isPinching: false, distance: 1.0 };

    detected.forEach((raw, i) => {
      const smoothed   = smoothLandmarks(i, raw);
      const handedness = labels[i]?.label ?? '?';
      const isPrimary  = i === 0;

      const pinch = renderHand(smoothed, handedness, isPrimary);
      if (isPrimary) primaryPinch = pinch;

      window.handData.hands.push({
        landmarks:  smoothed,
        handedness,
        score: labels[i]?.score ?? 0,
      });
    });

    window.handData.isPinching    = primaryPinch.isPinching;
    window.handData.pinchDistance = primaryPinch.distance;
    // Pinch centre in mirrored normalised screen space — used by main.js
    // as the delta-tracking handle for pinch-drag rotation.
    window.handData.pinchCX = primaryPinch.pinchCX ?? 0.5;
    window.handData.pinchCY = primaryPinch.pinchCY ?? 0.5;

    // ── Fist detection ───────────────────────────────────────────────────────
    // Uses the primary hand's smoothed landmarks.  Returns false when no hand
    // is in frame — ring expands back to normal on hand loss.
    if (window.handData.hands.length > 0) {
      window.handData.isFist = detectFist(window.handData.hands[0].landmarks);
    } else {
      window.handData.isFist = false;
    }

    // ── Single-hand depth gesture: palm span ─────────────────────────────────
    // Measure wrist (lm[0]) → middle-finger MCP (lm[9]) distance in normalised
    // screen space.  As the hand moves physically closer to the webcam the
    // projected size of the hand increases, so this distance grows.
    // As the hand retreats the projection shrinks and the distance falls.
    //
    // We always use the PRIMARY hand (index 0) so the gesture works with one
    // hand and doesn't require the user to hold two hands in frame.
    if (window.handData.hands.length > 0) {
      const lm  = window.handData.hands[0].landmarks;
      const dx  = lm[0].x - lm[9].x;
      const dy  = lm[0].y - lm[9].y;
      window.handData.palmSpan      = Math.sqrt(dx * dx + dy * dy);
      window.handData.palmSpanReady = true;
    } else {
      // Hand lost — keep last reading so Saturn doesn't jump on reappearance
      window.handData.palmSpanReady = false;
    }

    if (detected.length > 0) {
      drawGestureBadge(primaryPinch.isPinching);
    } else {
      fadeBadge();
    }
  });

  // ─── Camera init ───────────────────────────────────────────────────────────
  // Prefer an external (USB) webcam over the built-in camera.
  // Strategy: enumerate video devices, pick the last one that isn't labelled
  // as a built-in/integrated/facetime camera. If none found, fall back to default.

  async function startCamera() {
    let deviceId = null;
    try {
      // A brief getUserMedia call is required before enumerateDevices gives labels.
      await navigator.mediaDevices.getUserMedia({ video: true }).then(s => s.getTracks().forEach(t => t.stop()));
      const devices = await navigator.mediaDevices.enumerateDevices();
      const videoCams = devices.filter(d => d.kind === 'videoinput');
      // Prefer last device whose label doesn't look built-in
      const builtinRe = /built.?in|integrated|facetime|isight|front|back/i;
      const external = videoCams.filter(d => d.label && !builtinRe.test(d.label));
      if (external.length > 0) {
        deviceId = external[external.length - 1].deviceId;
      } else if (videoCams.length > 1) {
        // No labels matched — just pick the last device (usually the external one)
        deviceId = videoCams[videoCams.length - 1].deviceId;
      }
    } catch(e) { /* fall through to default */ }

    const constraints = deviceId
      ? { video: { deviceId: { exact: deviceId }, width: 1280, height: 720 } }
      : { video: { facingMode: 'user', width: 1280, height: 720 } };

    try {
      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      video.srcObject = stream;
      video.play();
      // Feed frames into MediaPipe manually
      const sendFrame = async () => {
        if (video.readyState >= 2) await hands.send({ image: video });
        requestAnimationFrame(sendFrame);
      };
      video.addEventListener('loadeddata', () => {
        setStatus('Hand tracking active', true);
        video.classList.add('ready');
        sendFrame();
      }, { once: true });
    } catch(err) {
      console.error('[hands.js] Camera error:', err);
      setStatus('Camera access denied — check browser permissions');
    }
  }

  startCamera();

})();
