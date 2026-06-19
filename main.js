import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.165.0/build/three.module.js';

// ─── Scene Setup ─────────────────────────────────────────────────────────────

const scene    = new THREE.Scene();
const camera   = new THREE.PerspectiveCamera(45, innerWidth / innerHeight, 0.1, 1000);
const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });

renderer.setPixelRatio(devicePixelRatio);
renderer.setSize(innerWidth, innerHeight);
renderer.toneMapping         = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.2;
document.body.appendChild(renderer.domElement);

const CAM_HOME = new THREE.Vector3(0, 6, 22);
camera.position.copy(CAM_HOME);
camera.lookAt(0, 0, 0);

// ─── Starfield ────────────────────────────────────────────────────────────────

function makeStarfield() {
  const count     = 10000;
  const positions = new Float32Array(count * 3);
  const colors    = new Float32Array(count * 3);

  for (let i = 0; i < count; i++) {
    const r     = 300 + Math.random() * 500;
    const theta = Math.random() * Math.PI * 2;
    const phi   = Math.acos(2 * Math.random() - 1);
    positions[i*3]   = r * Math.sin(phi) * Math.cos(theta);
    positions[i*3+1] = r * Math.sin(phi) * Math.sin(theta);
    positions[i*3+2] = r * Math.cos(phi);

    // Mostly white, occasional faint cyan tint
    const t = Math.random();
    colors[i*3]   = t > 0.85 ? 0.6 : 1.0;
    colors[i*3+1] = t > 0.85 ? 0.85 : 1.0;
    colors[i*3+2] = 1.0;
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('color',    new THREE.BufferAttribute(colors, 3));

  scene.add(new THREE.Points(geo, new THREE.PointsMaterial({
    vertexColors:    true,
    size:            0.55,
    sizeAttenuation: true,
    transparent:     true,
    opacity:         0.80,
    blending:        THREE.AdditiveBlending,
    depthWrite:      false,
  })));
}

makeStarfield();

// ─── Glow Dot Sprite ─────────────────────────────────────────────────────────
// Shared radial-gradient texture for every particle.

function makeGlowSprite(innerColor = '#ffffff', outerColor = 'rgba(0,140,255,0)') {
  const size = 128;
  const c    = document.createElement('canvas');
  c.width = c.height = size;
  const ctx  = c.getContext('2d');
  const mid  = size / 2;
  const grad = ctx.createRadialGradient(mid, mid, 0, mid, mid, mid);
  // Tight core — drops to transparent quickly so particles stay distinct
  grad.addColorStop(0.00, innerColor);
  grad.addColorStop(0.12, 'rgba(180,230,255,0.95)');
  grad.addColorStop(0.30, 'rgba(0,160,255,0.35)');
  grad.addColorStop(0.55, 'rgba(0,80,200,0.08)');
  grad.addColorStop(1.00, outerColor);
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, size, size);
  return new THREE.CanvasTexture(c);
}

const glowSprite = makeGlowSprite();

// ─── Particle Vertex / Fragment Shaders ──────────────────────────────────────
// We use a custom ShaderMaterial so each particle can have its own size
// stored in a per-vertex attribute — PointsMaterial only supports uniform size.

const VERT = /* glsl */`
  attribute float pSize;
  attribute vec3  pColor;
  uniform   float uFistProg;
  varying   vec3  vColor;
  varying   float vAlpha;

  void main() {
    float t      = uFistProg * uFistProg;
    vec3 finalPos = mix(position, vec3(0.0), t);

    vec3 hotColor = vec3(0.6, 0.95, 1.0);
    vColor = mix(pColor, hotColor, t * 0.85);
    vAlpha = (0.28 + length(pColor) * 0.10) * (1.0 + t * 2.0);

    vec4 mv = modelViewMatrix * vec4(finalPos, 1.0);
    gl_PointSize = pSize * (200.0 / -mv.z) * (1.0 + t * 3.5);
    gl_Position  = projectionMatrix * mv;
  }
`;

const FRAG = /* glsl */`
  uniform sampler2D sprite;
  varying vec3  vColor;
  varying float vAlpha;

  void main() {
    vec4 tex = texture2D(sprite, gl_PointCoord);
    gl_FragColor = vec4(vColor, tex.a * vAlpha);
  }
`;

let planetMaterial = null;

function makeParticleMaterial() {
  planetMaterial = new THREE.ShaderMaterial({
    uniforms: {
      sprite:    { value: glowSprite },
      uFistProg: { value: 0.0 },
    },
    vertexShader:   VERT,
    fragmentShader: FRAG,
    transparent:    true,
    depthWrite:     false,
    blending:       THREE.AdditiveBlending,
  });
  return planetMaterial;
}

// ─── Ring Fist Shader ─────────────────────────────────────────────────────────
//
// The ring uses its own ShaderMaterial so one float uniform (uFistProg 0→1)
// can animate all 40 000 particles on the GPU with zero per-particle CPU work.
//
// uFistProg = 0  →  particles at original orbital positions (ring intact)
// uFistProg = 1  →  all particles at vec3(0,0,0) (collapsed to Saturn's core)
//
// IMPLOSION easing  — quadratic ease-in  (t²):
//   At fistProg=0.1 the pull is only 1% — particles barely move at first,
//   then snap violently inward as fistProg approaches 1.  Feels like gravity.
//
// RESTORATION easing — the lerp-back on the CPU already produces ease-out:
//   fistProg decreases slowly (FIST_RESTORE_SPEED = 0.025), so the GPU sees
//   smooth values and the quadratic curve naturally gives ease-in-out expansion.
//
// PARTICLE SIZE & COLOR during collapse:
//   Particles grow and shift toward bright white-blue as they compress —
//   simulating matter heating up as it falls into a singularity.

const RING_VERT = /* glsl */`
  attribute float pSize;
  attribute vec3  pColor;

  // 0 = ring intact, 1 = fully collapsed to core
  uniform float uFistProg;

  varying vec3  vColor;
  varying float vAlpha;

  void main() {
    // ── Easing: quadratic ease-in ───────────────────────────────────────────
    // Small fistProg values have almost no effect; high values snap hard.
    // This makes the pull feel gravitational rather than mechanical.
    float t = uFistProg * uFistProg;

    // ── Position: lerp each particle from its orbit toward the core ─────────
    // 'position' is the original ring position baked into the attribute buffer
    // and NEVER modified on the CPU — the GPU handles all interpolation.
    vec3 finalPos = mix(position, vec3(0.0, 0.0, 0.0), t);

    // ── Visual feedback during collapse ─────────────────────────────────────
    // Shift colour toward hot white-cyan and increase brightness so the
    // imploding particles look like superheated matter falling inward.
    vec3 hotColor = vec3(0.6, 0.95, 1.0);
    vColor = mix(pColor, hotColor, t * 0.85);

    // Alpha scales up so particles stay visible as they converge
    vAlpha = (0.28 + length(pColor) * 0.10) * (1.0 + t * 2.0);

    // Point size grows as particles collapse — compression / singularity feel
    float sizeBoost = 1.0 + t * 3.5;

    vec4 mv = modelViewMatrix * vec4(finalPos, 1.0);
    gl_PointSize = pSize * (200.0 / -mv.z) * sizeBoost;
    gl_Position  = projectionMatrix * mv;
  }
`;

// Fragment shader is identical to the standard one — sprite texture + alpha
const RING_FRAG = /* glsl */`
  uniform sampler2D sprite;
  varying vec3  vColor;
  varying float vAlpha;

  void main() {
    vec4 tex = texture2D(sprite, gl_PointCoord);
    gl_FragColor = vec4(vColor, tex.a * vAlpha);
  }
`;

// Exported so updateFistEffect() can write to it each frame
let ringMaterial = null;

function makeRingMaterial() {
  ringMaterial = new THREE.ShaderMaterial({
    uniforms: {
      sprite:    { value: glowSprite },
      uFistProg: { value: 0.0 },       // ← driven by updateFistEffect()
    },
    vertexShader:   RING_VERT,
    fragmentShader: RING_FRAG,
    transparent:    true,
    depthWrite:     false,
    blending:       THREE.AdditiveBlending,
  });
  return ringMaterial;
}

// ─── Saturn Particle Sphere ───────────────────────────────────────────────────
//
// Two layers — surface shell only (no inner volume to avoid centre blowout):
//   1. Surface shell  — particles sit ON the sphere ± tiny jitter
//   2. Accent sparks  — very few slightly-larger bright dots

function makeSaturnParticles(baseRadius = 3.5) {
  const SURFACE_COUNT = 28000;
  const SPARK_COUNT   =   600;
  const TOTAL         = SURFACE_COUNT + SPARK_COUNT;

  const positions = new Float32Array(TOTAL * 3);
  const pColors   = new Float32Array(TOTAL * 3);
  const pSizes    = new Float32Array(TOTAL);

  let idx = 0;

  const goldenAngle = Math.PI * (1 + Math.sqrt(5));

  function fibSphere(i, n, radius) {
    const theta  = Math.acos(1 - 2 * (i + 0.5) / n);
    const phi    = goldenAngle * i;
    // Shallow jitter — keep particles near the surface, not inside
    const jitter = (Math.random() - 0.5) * 0.22;
    const r      = radius + jitter;
    return [
      r * Math.sin(theta) * Math.cos(phi),
      r * Math.sin(theta) * Math.sin(phi),
      r * Math.cos(theta),
    ];
  }

  function cyanColor(brightness) {
    const h = 0.52 + Math.random() * 0.10;
    const s = 0.75 + Math.random() * 0.25;
    const l = brightness * (0.5 + Math.random() * 0.5);
    const a = s * Math.min(l, 1 - l);
    function f(n) {
      const k = (n + h * 12) % 12;
      return l - a * Math.max(-1, Math.min(k - 3, Math.min(9 - k, 1)));
    }
    return [Math.max(0, f(0)), Math.max(0, f(8)), Math.max(0, f(4))];
  }

  // ── Layer 1: surface shell ──────────────────────────────────────────────────
  for (let i = 0; i < SURFACE_COUNT; i++, idx++) {
    const [x, y, z] = fibSphere(i, SURFACE_COUNT, baseRadius);
    positions[idx*3]   = x;
    positions[idx*3+1] = y;
    positions[idx*3+2] = z;

    const bright = 0.35 + Math.random() * 0.65;
    const [r, g, b] = cyanColor(bright);
    pColors[idx*3]   = r;
    pColors[idx*3+1] = g;
    pColors[idx*3+2] = b;

    pSizes[idx] = 0.18 + Math.random() * 0.52;
  }

  // ── Layer 2: accent sparks ──────────────────────────────────────────────────
  for (let i = 0; i < SPARK_COUNT; i++, idx++) {
    const [x, y, z] = fibSphere(i * 47, SPARK_COUNT * 47, baseRadius);
    positions[idx*3]   = x;
    positions[idx*3+1] = y;
    positions[idx*3+2] = z;

    const t = Math.random();
    pColors[idx*3]   = 0.6 + t * 0.4;
    pColors[idx*3+1] = 0.85 + t * 0.15;
    pColors[idx*3+2] = 1.0;

    pSizes[idx] = 0.55 + Math.random() * 0.85;
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('pColor',   new THREE.BufferAttribute(pColors,   3));
  geo.setAttribute('pSize',    new THREE.BufferAttribute(pSizes,    1));

  return new THREE.Points(geo, makeParticleMaterial());
}

// ─── Ring Particle Band ───────────────────────────────────────────────────────
// The ring is also converted to particles for visual consistency.

function makeRingParticles(innerR = 4.8, outerR = 9.5) {
  const COUNT     = 40000;
  const positions = new Float32Array(COUNT * 3);
  const pColors   = new Float32Array(COUNT * 3);
  const pSizes    = new Float32Array(COUNT);

  for (let i = 0; i < COUNT; i++) {
    // Random angle and radial position, weighted so more particles fill the inner bands
    const angle = Math.random() * Math.PI * 2;
    const t     = Math.pow(Math.random(), 0.7); // bias toward inner ring
    const r     = innerR + t * (outerR - innerR);
    const vJitter = (Math.random() - 0.5) * 0.12; // slight vertical scatter

    positions[i*3]   = Math.cos(angle) * r;
    positions[i*3+1] = vJitter;
    positions[i*3+2] = Math.sin(angle) * r;

    // Cassini division: near-gap region dims out
    const normR   = (r - innerR) / (outerR - innerR);
    const cassini  = Math.abs(normR - 0.39); // gap centre at 39%
    const dimmed   = cassini < 0.03 ? cassini / 0.03 : 1.0;
    const bright   = dimmed * (0.35 + Math.random() * 0.65);

    pColors[i*3]   = 0.05 * bright;
    pColors[i*3+1] = 0.65 * bright;
    pColors[i*3+2] = bright;

    pSizes[i] = 0.4 + Math.random() * 1.0;
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('pColor',   new THREE.BufferAttribute(pColors,   3));
  geo.setAttribute('pSize',    new THREE.BufferAttribute(pSizes,    1));

  const pts = new THREE.Points(geo, makeRingMaterial());
  // Ring lies flat; tilt to match Saturn's axial tilt
  pts.rotation.z = THREE.MathUtils.degToRad(-26.7);
  return pts;
}

// ─── Saturn Group ─────────────────────────────────────────────────────────────

const TILT        = THREE.MathUtils.degToRad(26.7);
const saturnGroup = new THREE.Group();
scene.add(saturnGroup);

// Planet body — particle sphere
const saturn = makeSaturnParticles(3.5);
saturn.rotation.z = TILT;
saturnGroup.add(saturn);

// Ring system — particle band
const ringParticles = makeRingParticles(4.8, 9.5);
saturnGroup.add(ringParticles);


// ─── Minimal Lighting (mostly irrelevant for additive particles) ──────────────

scene.add(new THREE.AmbientLight(0x001020, 1.0));

// ─── Resize ───────────────────────────────────────────────────────────────────

window.addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

// ─── Interaction State ────────────────────────────────────────────────────────

const interaction = {
  // ── Mode ───────────────────────────────────────────────────────────────────
  // 'idle'     — no hand detected; auto-spin + cinematic camera drift
  // 'tracking' — open hand; Saturn follows palm position in world space
  // 'grabbed'  — pinch active; pinch-centre delta drives rotation
  mode: 'idle',

  // ── Position spring ────────────────────────────────────────────────────────
  targetPos:  new THREE.Vector3(),  // where palm says Saturn should go
  currentPos: new THREE.Vector3(),  // where Saturn actually is (spring output)
  velocity:   new THREE.Vector3(),  // spring velocity accumulator

  // ── Rotation accumulator ───────────────────────────────────────────────────
  // Total accumulated angles applied to saturnGroup (both axes).
  // Both live on the GROUP so rings + planet always transform together —
  // no drift, no misalignment, regardless of how many rotations stack up.
  rotY: 0,   // horizontal drag  → spin around world Y
  rotX: 0,   // vertical drag    → tilt around world X

  // ── Angular velocity (inertia) ────────────────────────────────────────────
  // Set each frame while pinching; decays by ROT_FRICTION after release.
  rotVelY: 0,
  rotVelX: 0,

  // ── Pinch-drag tracking ────────────────────────────────────────────────────
  // Previous frame's pinch-centre position — used to compute per-frame delta.
  // Reset to null when pinch is released so the first frame of a new pinch
  // doesn't produce a large spurious delta.
  prevPinchX: null,
  prevPinchY: null,

  // ── Auto-spin ──────────────────────────────────────────────────────────────
  autoSpin:      0,     // ever-incrementing angle for idle planet rotation
  autoSpinBlend: 1.0,   // 1 = full auto-spin, 0 = hand has taken over
};

// ── Position spring ──────────────────────────────────────────────────────────
const POS_STIFFNESS   = 0.10;   // spring pull strength toward target each frame
const POS_DAMPING     = 0.78;   // velocity retention (friction) for position

// ── Rotation ─────────────────────────────────────────────────────────────────
// ROT_SENSITIVITY   — how much screen-space delta maps to rotation angle.
//                     Higher = faster spin for the same hand movement.
// ROT_FRICTION      — angular velocity multiplier applied every frame after
//                     pinch is released.  0.95 = loses 5 % speed per frame,
//                     giving ~1–2 seconds of glide before coming to rest.
//                     (Previous value was 0.88 — too abrupt.)
const ROT_SENSITIVITY = 4.0;
const ROT_FRICTION    = 0.95;   // inertia decay — applied every frame, not just on release

// ── Auto-spin (idle, no hand present) ────────────────────────────────────────
const AUTO_SPIN_SPEED = 0.08;   // radians / second

// ── World-space mapping for open-hand position tracking ──────────────────────
const WORLD_X_RANGE   = 8;      // ± world units across full screen width
const WORLD_Y_MIN     =  3.5;   // top of screen maps to this world Y
const WORLD_Y_MAX     = -2.5;   // bottom of screen maps to this world Y
const PALM_INDICES    = [0, 5, 9, 13, 17]; // landmarks averaged for palm centroid

// ─── Single-Hand Depth Scale Configuration ───────────────────────────────────
//
// GESTURE
//   The user moves one hand toward / away from the webcam.
//   We track palmSpan = dist(wrist lm[0], middleMCP lm[9]) in normalised [0..1]
//   screen space.  Closer hand → larger projection → bigger palmSpan → scale up.
//
// CALIBRATION  (auto, rolling-average over first CALIB_FRAMES readings)
//   On the first CALIB_FRAMES valid frames we accumulate palmSpan readings and
//   compute their mean.  That mean becomes PALM_REF — the "neutral" distance
//   that maps to scale 1.0.  This adapts to every user's hand size and sitting
//   distance automatically, with zero manual setup needed.
//   After calibration a brief on-canvas badge confirms it's done.
//
// MAPPING
//   rawRatio  = palmSpan / PALM_REF          (1.0 = neutral / calibration distance)
//   scaled    = rawRatio ^ DEPTH_EXPONENT    (non-linear: feels more responsive)
//   target    = clamp(scaled, MIN_SCALE, MAX_SCALE)
//
//   DEPTH_EXPONENT > 1  →  small movements near neutral have less effect;
//                          large movements (hand very close/far) amplify strongly.
//   1.6 is a good perceptual sweet-spot.
//
// SMOOTHING  (two-stage)
//   Stage 1 — EMA on raw palmSpan (PALM_EMA):
//     Absorbs per-frame landmark jitter before it reaches the mapper.
//   Stage 2 — lerp on target scale (SCALE_LERP):
//     The planet glides smoothly toward the target; sudden hand snaps
//     produce a cinematic ease-in rather than an instant jump.

const MIN_SCALE      = 0.20;   // planet never shrinks below 20 % of default
const MAX_SCALE      = 3.50;   // planet never grows beyond 350 % of default
const DEPTH_EXPONENT = 1.6;    // non-linear depth response curve
const PALM_EMA       = 0.80;   // EMA factor for raw palmSpan  (0=instant, 1=frozen)
const SCALE_LERP     = 0.07;   // lerp rate toward targetScale per frame
const CALIB_FRAMES   = 45;     // how many readings to average for calibration

// Scale runtime state
const scaleState = {
  // Calibration
  calibSamples: [],     // raw palmSpan readings collected during warm-up
  palmRef:      null,   // set after calibration; null = not yet calibrated
  calibDone:    false,

  // Per-frame
  smoothSpan:   0,      // EMA-smoothed palmSpan
  targetScale:  1.0,    // mapped + clamped scale we lerp toward
  currentScale: 1.0,    // scale actually applied to saturnGroup this frame
};

function getPalmNorm(landmarks) {
  let x = 0, y = 0;
  for (const i of PALM_INDICES) { x += landmarks[i].x; y += landmarks[i].y; }
  return { x: 1 - x / PALM_INDICES.length, y: y / PALM_INDICES.length };
}

function palmToWorld(nx, ny) {
  return new THREE.Vector3(
    (nx - 0.5) * 2 * WORLD_X_RANGE,
    THREE.MathUtils.lerp(WORLD_Y_MIN, WORLD_Y_MAX, ny),
    0
  );
}

function updateInteraction(dt) {
  const hd      = window.handData;
  const hasHand = hd && hd.active && hd.hands.length > 0;

  // ── Determine mode ──────────────────────────────────────────────────────────
  if (!hasHand) {
    interaction.mode       = 'idle';
    interaction.prevPinchX = null;   // discard stale tracking point
    interaction.prevPinchY = null;
  } else {
    interaction.mode = hd.isPinching ? 'grabbed' : 'tracking';
  }

  const { mode } = interaction;

  // ── Auto-spin blend ─────────────────────────────────────────────────────────
  // Smoothly fade the idle rotation out when a hand appears (and back in when
  // the hand leaves) so there is no abrupt speed jump.
  const spinTarget = (mode === 'idle') ? 1.0 : 0.0;
  interaction.autoSpinBlend += (spinTarget - interaction.autoSpinBlend) * 0.05;
  interaction.autoSpin      += dt * AUTO_SPIN_SPEED;

  // ════════════════════════════════════════════════════════════════════════════
  // MODE: IDLE — no hand in frame
  // ════════════════════════════════════════════════════════════════════════════
  if (mode === 'idle') {
    // Cinematic camera drift — disabled as soon as a hand appears
    const t = performance.now() / 1000;
    camera.position.x = Math.sin(t * 0.04) * 2;
    camera.position.y = 6 + Math.sin(t * 0.025) * 1.5;
    camera.lookAt(0, 0, 0);

    // Saturn drifts back to world origin when no hand is present
    interaction.targetPos.set(0, 0, 0);

    // ── Inertia decay while idle ────────────────────────────────────────────
    // ROT_FRICTION is applied here too so the spin-down from a released pinch
    // continues naturally even if the hand leaves the frame mid-glide.
    interaction.rotVelY *= ROT_FRICTION;
    interaction.rotVelX *= ROT_FRICTION;
    interaction.rotY    += interaction.rotVelY;
    interaction.rotX    += interaction.rotVelX;
  }

  // ════════════════════════════════════════════════════════════════════════════
  // MODE: TRACKING — open hand; position frozen, no rotation
  // ════════════════════════════════════════════════════════════════════════════
  if (mode === 'tracking') {
    camera.position.copy(CAM_HOME);
    camera.lookAt(0, 0, 0);
    interaction.targetPos.copy(interaction.currentPos); // position stays frozen
    interaction.prevPinchX = null; // discard so grabbed mode starts fresh
    interaction.prevPinchY = null;
  }

  // ════════════════════════════════════════════════════════════════════════════
  // MODE: GRABBED — pinch active (same rotation, position also frozen)
  // ════════════════════════════════════════════════════════════════════════════
  if (mode === 'grabbed') {
    camera.position.copy(CAM_HOME);
    camera.lookAt(0, 0, 0);
    interaction.targetPos.copy(interaction.currentPos);

    const palm = getPalmNorm(hd.hands[0].landmarks);

    if (interaction.prevPinchX !== null) {
      const deltaX = palm.x - interaction.prevPinchX;
      const deltaY = palm.y - interaction.prevPinchY;
      interaction.rotVelY = deltaX * ROT_SENSITIVITY;
      interaction.rotVelX = deltaY * ROT_SENSITIVITY;
      interaction.rotY   += interaction.rotVelY;
      interaction.rotX   += interaction.rotVelX;
      interaction.rotX    = THREE.MathUtils.clamp(interaction.rotX, -Math.PI * 0.48, Math.PI * 0.48);
    }

    interaction.prevPinchX = palm.x;
    interaction.prevPinchY = palm.y;
  }

  // ── Position spring physics ────────────────────────────────────────────────
  // Runs every frame regardless of mode.
  // F = stiffness * (target - current); velocity decays by damping each frame.
  const springDelta = interaction.targetPos.clone().sub(interaction.currentPos);
  interaction.velocity.addScaledVector(springDelta, POS_STIFFNESS);
  interaction.velocity.multiplyScalar(POS_DAMPING);
  interaction.currentPos.add(interaction.velocity);
  saturnGroup.position.copy(interaction.currentPos);

  // ── Apply rotation to the GROUP, not the individual mesh ──────────────────
  // Both rotY and rotX live on saturnGroup so planet sphere AND ring particles
  // always transform together as a single rigid body — no drift, ever.
  //
  // Auto-spin (rotY from idle spin) is applied only to saturn (the sphere mesh)
  // inside the group's local space, giving the planet a separate axial spin
  // without spinning the rings — accurate to real Saturn.
  saturnGroup.rotation.order = 'YXZ';          // Y first avoids gimbal lock on tilt
  saturnGroup.rotation.y     = interaction.rotY;
  saturnGroup.rotation.x     = interaction.rotX;

  // Planet-only auto-spin in the mesh's own local Y — rings stay still
  saturn.rotation.y = interaction.autoSpin * interaction.autoSpinBlend;
  saturn.rotation.z = TILT;  // fixed axial tilt, never modified by gestures
}

// ─── Scale Update ─────────────────────────────────────────────────────────────
//
// Called every frame from animate().
// Pipeline:  palmSpan → EMA → calibration → power-curve map → clamp → lerp → apply
//
// saturnGroup contains every particle (planet + rings) so one setScalar() call
// scales the entire system proportionally — no per-particle math needed.

function updateScale() {
  const hd = window.handData;

  // Only act when a hand is present and has produced a valid palmSpan reading
  if (hd && hd.palmSpanReady && hd.palmSpan > 0 && !hd.isPinching) {

    // ── Stage 1: EMA — smooth the raw palmSpan signal ──────────────────────
    // Absorbs MediaPipe's per-frame landmark noise.
    // Formula:  smooth = smooth * α  +  raw * (1 − α)
    // α = PALM_EMA (0.80) → ~5-frame rolling average feel.
    if (scaleState.smoothSpan === 0) {
      scaleState.smoothSpan = hd.palmSpan; // seed on first reading
    }
    scaleState.smoothSpan =
      scaleState.smoothSpan * PALM_EMA +
      hd.palmSpan           * (1 - PALM_EMA);

    // ── Stage 2: Auto-calibration ───────────────────────────────────────────
    // Collect CALIB_FRAMES readings at the user's natural resting distance.
    // Their mean becomes palmRef — the span that maps to scale 1.0.
    // This adapts to any hand size or webcam-to-user distance automatically.
    if (!scaleState.calibDone) {
      scaleState.calibSamples.push(scaleState.smoothSpan);

      if (scaleState.calibSamples.length >= CALIB_FRAMES) {
        const sum = scaleState.calibSamples.reduce((a, b) => a + b, 0);
        scaleState.palmRef   = sum / scaleState.calibSamples.length;
        scaleState.calibDone = true;
        // Brief confirmation flash on the status badge (reuses existing helper)
        if (window.__setStatus) window.__setStatus('Scale calibrated ✓', true);
      }
      // During calibration keep scale at 1.0 — planet holds steady while
      // we gather reference data, so the user doesn't see it drifting.
      return;
    }

    // ── Stage 3: Map smoothed span → target scale ───────────────────────────
    //
    // rawRatio = how much bigger/smaller the hand appears vs calibration.
    //   > 1.0  →  hand is closer  →  scale up
    //   < 1.0  →  hand is farther →  scale down
    //   = 1.0  →  hand at calibration distance → scale 1.0
    const rawRatio = scaleState.smoothSpan / scaleState.palmRef;

    // Power curve: Math.pow(ratio, DEPTH_EXPONENT) compresses small movements
    // near neutral (less accidental scaling) and amplifies large movements
    // (reaching forward/back feels very responsive).
    // DEPTH_EXPONENT = 1.6 is a good perceptual balance.
    const mappedScale = Math.pow(rawRatio, DEPTH_EXPONENT);

    // ── Stage 4: Clamp ──────────────────────────────────────────────────────
    // Hard limits prevent the planet from disappearing or overflowing the viewport
    // even if the user presses their hand against the lens or drops it out of frame.
    scaleState.targetScale = THREE.MathUtils.clamp(mappedScale, MIN_SCALE, MAX_SCALE);
  }
  // If no hand present: targetScale holds its last value.
  // The planet stays frozen at the last scale until the hand reappears,
  // then smoothly resumes from wherever currentScale is.

  // ── Stage 5: Lerp currentScale → targetScale ───────────────────────────
  // Each frame we move only SCALE_LERP (7 %) of the remaining gap.
  // This produces a buttery ease-in feel — fast initial response, then
  // decelerates as it approaches the target.  No overshoot, no snap.
  scaleState.currentScale = THREE.MathUtils.lerp(
    scaleState.currentScale,
    scaleState.targetScale,
    SCALE_LERP
  );

  // ── Stage 6: Apply ──────────────────────────────────────────────────────
  // Uniform scale on the group — x = y = z = currentScale.
  // Every child (planet particles, ring particles, glow shell) scales together.
  saturnGroup.scale.setScalar(scaleState.currentScale);
}

// ─── Fist Implosion Effect ────────────────────────────────────────────────────
//
// When the user makes a fist, uFistProg ramps toward 1.0.
// The ring vertex shader reads this uniform and collapses all ring particles
// toward vec3(0,0,0) entirely on the GPU — zero per-particle CPU cost.
//
// FIST_SNAP_SPEED    — fast: fist closes and ring implodes in ~12 frames
// FIST_RESTORE_SPEED — slow: ring re-expands gracefully when hand opens
//
// Lerp values → no abrupt jumps; quadratic easing lives inside the shader.

const FIST_SNAP_SPEED    = 0.08;
const FIST_RESTORE_SPEED = 0.025;
let   fistProgress       = 0.0;

function updateFistEffect() {
  const isFist = window.handData?.isFist ?? false;
  const target  = isFist ? 1.0 : 0.0;
  const speed   = isFist ? FIST_SNAP_SPEED : FIST_RESTORE_SPEED;
  fistProgress  = THREE.MathUtils.lerp(fistProgress, target, speed);
  if (ringMaterial)   ringMaterial.uniforms.uFistProg.value   = fistProgress;
  if (planetMaterial) planetMaterial.uniforms.uFistProg.value = fistProgress;
}

// ─── Animation Loop ───────────────────────────────────────────────────────────

const clock = new THREE.Clock();

function animate() {
  requestAnimationFrame(animate);
  const dt = clock.getDelta();
  updateInteraction(dt);
  updateScale();
  updateFistEffect();
  renderer.render(scene, camera);
}

animate();

// Press S to save a screenshot
let _shotIndex = 1;
addEventListener('keydown', e => {
  if (e.key !== 's' && e.key !== 'S') return;
  renderer.render(scene, camera); // ensure fresh frame
  renderer.domElement.toBlob(blob => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `saturn-screenshot-${_shotIndex++}.png`;
    a.click();
    URL.revokeObjectURL(a.href);
  }, 'image/png');
});
