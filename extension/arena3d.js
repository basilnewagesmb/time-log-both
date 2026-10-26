// 3D target range (Three.js + bloom). It mirrors the targets worklog.js renders into
// #targets, so all the page logic stays in worklog.js; clicks are forwarded to those
// DOM targets. Without WebGL 2 the CSS arena is left as it is.
import * as THREE from "./vendor/three/three.module.min.js";
import { EffectComposer } from "./vendor/three/postprocessing/EffectComposer.js";
import { RenderPass } from "./vendor/three/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "./vendor/three/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "./vendor/three/postprocessing/OutputPass.js";

const arena = document.querySelector(".arena");
const domTargets = document.getElementById("targets");
const lastShot = document.getElementById("last-shot");
const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;

const CAMERA_Y = 1.7;
const CAMERA_Z = 7;
const BOARD_R = 0.8;
const BOARD_Y = BOARD_R + 0.85; // stand + post below the board
const FRAME_DEPTH = 3; // hangar frame distance from the camera

// ---------- Helpers ----------

function hasWebGL2() {
  try { return !!document.createElement("canvas").getContext("webgl2"); } catch (_) { return false; }
}

function seeded(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Colours above 1 are what the bloom pass picks up.
function glow(color, strength) { return new THREE.Color(color).multiplyScalar(strength); }

function canvasTexture(size, draw) {
  const c = document.createElement("canvas");
  c.width = c.height = size;
  draw(c.getContext("2d"), size);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

const softDot = canvasTexture(128, (g, s) => {
  const grad = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
  grad.addColorStop(0, "rgba(255,255,255,1)");
  grad.addColorStop(0.4, "rgba(255,255,255,.45)");
  grad.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = grad;
  g.fillRect(0, 0, s, s);
});

function mixHex(a, b, t) {
  return "#" + new THREE.Color(a).lerp(new THREE.Color(b), t).getHexString();
}

// Same rings as the CSS target, painted onto the board's face.
function ringTexture(color) {
  const rings = [
    [1, "#101f44"], [0.68, color], [0.64, "#0d1b3d"], [0.5, mixHex(color, "#ffffff", 0.3)],
    [0.44, "#0a1430"], [0.34, color], [0.24, "#0a1430"], [0.18, "#ff7a1a"],
    [0.1, mixHex(color, "#ffd76a", 0.6)], [0.04, "#ffffff"],
  ];
  return canvasTexture(512, (g, s) => {
    for (const [r, fill] of rings) {
      g.beginPath();
      g.arc(s / 2, s / 2, (s / 2) * r, 0, Math.PI * 2);
      g.fillStyle = fill;
      g.fill();
    }
  });
}

function disposeTree(obj) {
  obj.traverse((o) => {
    if (o.geometry) o.geometry.dispose();
    const mats = Array.isArray(o.material) ? o.material : o.material ? [o.material] : [];
    for (const m of mats) {
      if (m.map && m.map !== softDot) m.map.dispose();
      m.dispose();
    }
  });
}

// ---------- Scene ----------

function start() {
  const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.9;
  renderer.domElement.className = "arena-canvas";

  const labels = document.createElement("div");
  labels.className = "arena-labels";
  arena.prepend(renderer.domElement);
  arena.append(labels);
  arena.classList.add("is-3d");

  const scene = new THREE.Scene();
  scene.fog = new THREE.Fog(0x6f9bdc, 45, 210);

  const camera = new THREE.PerspectiveCamera(48, 2, 0.05, 260);
  const lookAt = new THREE.Vector3(0, 1.75, 0);
  camera.position.set(0, CAMERA_Y, CAMERA_Z);
  scene.add(camera);

  const composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  const bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), 0.7, 0.4, 0.9);
  composer.addPass(bloom);
  composer.addPass(new OutputPass());

  // Lights
  scene.add(new THREE.HemisphereLight(0x8fb4ff, 0x0a1430, 1));
  const sun = new THREE.DirectionalLight(0xdfe9ff, 1.3);
  sun.position.set(6, 12, 8);
  scene.add(sun);

  buildSky(scene);
  const clouds = buildClouds(scene);
  buildMountains(scene);
  buildFloor(scene);
  const dust = reduceMotion ? null : buildDust(scene);
  const frame = buildFrame(camera);
  const gun = buildGun(camera);

  // ---------- Targets ----------

  const views = new Map(); // key -> view
  let message = null;

  function makeView(t) {
    const group = new THREE.Group();
    const color = new THREE.Color(t.color);
    const face = ringTexture(t.color);
    const metal = new THREE.MeshStandardMaterial({ color: 0x1b2b52, metalness: 0.55, roughness: 0.4 });

    const stand = new THREE.Mesh(new THREE.CylinderGeometry(0.32, 0.72, 0.6, 4, 1), metal);
    stand.rotation.y = Math.PI / 4;
    stand.position.y = 0.3;
    const strip = new THREE.Mesh(new THREE.BoxGeometry(0.55, 0.05, 0.02), new THREE.MeshBasicMaterial({ color: glow(t.color, 3) }));
    strip.position.set(0, 0.18, 0.43);
    const post = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.4, 0.14), metal);
    post.position.y = 0.75;

    const board = new THREE.Group();
    board.position.y = BOARD_Y;
    const faceMat = new THREE.MeshStandardMaterial({ map: face, emissive: 0xffffff, emissiveMap: face, emissiveIntensity: 0.5, roughness: 0.45 });
    const disc = new THREE.Mesh(new THREE.CylinderGeometry(BOARD_R, BOARD_R, 0.14, 64), [metal, faceMat, metal]);
    disc.rotation.x = Math.PI / 2;
    const rimMat = new THREE.MeshBasicMaterial({ color: glow(t.color, 2) });
    const rim = new THREE.Mesh(new THREE.TorusGeometry(BOARD_R + 0.03, 0.04, 12, 96), rimMat);
    const lineMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.75 });
    const h = new THREE.Mesh(new THREE.BoxGeometry(BOARD_R * 2.4, 0.012, 0.01), lineMat);
    const v = new THREE.Mesh(new THREE.BoxGeometry(0.012, BOARD_R * 2.4, 0.01), lineMat);
    h.position.z = v.position.z = 0.09;
    const halo = new THREE.Sprite(new THREE.SpriteMaterial({ map: softDot, color, transparent: true, opacity: 0.45, blending: THREE.AdditiveBlending, depthWrite: false }));
    halo.scale.setScalar(BOARD_R * 3.6);
    halo.position.z = -0.15;
    board.add(halo, disc, rim, h, v);

    const pool = new THREE.Mesh(new THREE.CircleGeometry(1.5, 48), new THREE.MeshBasicMaterial({ map: softDot, color, transparent: true, opacity: 0.35, blending: THREE.AdditiveBlending, depthWrite: false }));
    pool.rotation.x = -Math.PI / 2;
    pool.position.set(0, 0.02, 0.4);

    const light = new THREE.PointLight(color, 5, 5, 1.5);
    light.position.set(0, 0.9, 1);

    group.add(stand, strip, post, board, pool, light);
    group.traverse((o) => { o.userData.key = t.key; });
    scene.add(group);

    const label = document.createElement("div");
    label.className = "target-plate label3d";
    label.style.setProperty("--c", t.color);
    label.dataset.key = t.key;
    const icon = document.createElement("span");
    icon.className = "p-icon";
    const text = document.createElement("span");
    const name = document.createElement("b");
    const sub = document.createElement("small");
    text.append(name, sub);
    label.append(icon, text);
    labels.append(label);

    return {
      key: t.key, group, board, faceMat, rimMat, halo, label, name, sub, icon, color: t.color,
      x: 0, scale: 1, active: false, hitAt: -1,
    };
  }

  function removeView(view) {
    scene.remove(view.group);
    disposeTree(view.group);
    view.label.remove();
    views.delete(view.key);
  }

  // Read what worklog.js rendered into #targets.
  function syncFromDom() {
    const items = [...domTargets.children].filter((n) => n.dataset.key).map((n) => ({
      key: n.dataset.key,
      color: n.style.getPropertyValue("--c").trim() || "#29d3ff",
      name: n.querySelector("b")?.textContent || n.dataset.key,
      sub: n.querySelector("small")?.textContent || "",
      active: n.classList.contains("is-active"),
    }));
    const keys = new Set(items.map((t) => t.key));
    for (const view of [...views.values()]) if (!keys.has(view.key)) removeView(view);
    for (const t of items) {
      const view = views.get(t.key) || views.set(t.key, makeView(t)).get(t.key);
      view.active = t.active;
      view.order = items.indexOf(t);
      view.label.classList.toggle("is-active", t.active);
      if (view.name.textContent !== t.name) view.name.textContent = t.name;
      if (view.sub.textContent !== t.sub) view.sub.textContent = t.sub;
      view.icon.textContent = t.name.charAt(0).toUpperCase();
    }
    measureLabels();

    const empty = domTargets.querySelector(".targets-empty");
    if (empty && !message) {
      message = document.createElement("div");
      message.className = "arena-msg";
      labels.append(message);
    }
    if (message) {
      message.textContent = empty ? empty.textContent : "";
      message.hidden = !empty;
    }
    layout();
    kick();
  }

  function measureLabels() {
    for (const view of views.values()) { view.labelH = view.label.offsetHeight; view.labelW = view.label.offsetWidth; }
  }

  // Spread the targets across the clear part of the screen (left of the last-shot card).
  function layout() {
    const list = [...views.values()].sort((a, b) => a.order - b.order);
    if (!list.length) return;
    const halfW = CAMERA_Z * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) * camera.aspect;
    const cardShown = lastShot && getComputedStyle(lastShot).display !== "none";
    const sign = arena.querySelector(".sign");
    const signShown = sign && getComputedStyle(sign).display !== "none";
    const edge = camera.aspect < 2 ? 0.22 : 0.16; // narrow screens: keep clear of the pillars
    const left = -halfW + 2 * halfW * (signShown ? 0.2 : edge);
    const right = -halfW + 2 * halfW * (cardShown ? 0.69 : 1 - edge);
    const step = list.length > 1 ? (right - left) / (list.length - 1) : 0;
    const fit = Math.min(1, Math.max(0.5, (step || 99) / (BOARD_R * 2 * 1.55)));
    list.forEach((view, i) => {
      view.x = list.length > 1 ? left + step * i : (left + right) / 2;
      view.fit = fit;
    });
  }

  new MutationObserver(syncFromDom).observe(domTargets, {
    childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ["class"],
  });

  // ---------- Picking ----------

  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2(0, 0);
  let pointerSeen = false;

  function keyAt(clientX, clientY) {
    const r = renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
    raycaster.setFromCamera(ndc, camera);
    const hit = raycaster.intersectObjects([...views.values()].map((v) => v.group), true)
      .find((i) => !(i.object instanceof THREE.Sprite) && i.object.geometry.type !== "CircleGeometry");
    return hit ? hit.object.userData.key : null;
  }

  function pick(key) {
    const node = key && [...domTargets.children].find((n) => n.dataset.key === key);
    if (node) node.click();
  }

  renderer.domElement.addEventListener("click", (e) => pick(keyAt(e.clientX, e.clientY)));
  labels.addEventListener("click", (e) => pick(e.target.closest(".label3d")?.dataset.key));
  renderer.domElement.addEventListener("pointermove", (e) => {
    const r = renderer.domElement.getBoundingClientRect();
    pointer.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    pointerSeen = true;
    renderer.domElement.style.cursor = keyAt(e.clientX, e.clientY) ? "pointer" : "";
    kick();
  });
  renderer.domElement.addEventListener("pointerleave", () => { pointer.set(0, 0); kick(); });

  // ---------- Shots ----------

  const effects = []; // { update(t) -> false when finished, dispose() }
  let shake = 0;

  function boardCenter(view) { return view.board.getWorldPosition(new THREE.Vector3()); }

  function fire(key, text) {
    const view = views.get(key);
    gun.recoil = 1;
    gun.flash = 1;
    if (!view) return;
    gun.lockOn = view; // snap aim to the target being hit
    const now = performance.now();
    const from = gun.muzzle.getWorldPosition(new THREE.Vector3());
    const to = boardCenter(view);
    effects.push(beam(from, to, now));
    setTimeout(() => impact(view, text), reduceMotion ? 0 : 110);
    kick();
  }

  function impact(view, text) {
    const now = performance.now();
    view.hitAt = now;
    shake = reduceMotion ? 0 : 1;
    const at = boardCenter(view);
    if (!reduceMotion) {
      effects.push(sparks(at, view.color, now), shockwave(at, view.color, now));
    }
    const pop = document.createElement("span");
    pop.className = "hit-pop";
    pop.textContent = text;
    labels.append(pop);
    placeAt(pop, at.clone().add(new THREE.Vector3(BOARD_R * 0.9, BOARD_R * 0.3, 0)));
    setTimeout(() => pop.remove(), 1700);
    kick();
  }

  function beam(from, to, born) {
    const dir = to.clone().sub(from);
    const len = dir.length();
    const group = new THREE.Group();
    const outer = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 1, 10, 1, true),
      new THREE.MeshBasicMaterial({ color: glow("#29d3ff", 4), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }));
    const core = new THREE.Mesh(new THREE.CylinderGeometry(0.016, 0.016, 1, 8, 1, true),
      new THREE.MeshBasicMaterial({ color: glow("#ffffff", 6), transparent: true, depthWrite: false }));
    group.add(outer, core);
    group.position.copy(from).addScaledVector(dir, 0.5);
    group.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.clone().normalize());
    group.scale.set(1, len, 1);
    scene.add(group);
    return {
      update(t) {
        const k = (t - born) / 380;
        if (k >= 1) return false;
        const fade = 1 - k;
        outer.material.opacity = fade;
        core.material.opacity = fade;
        group.scale.x = group.scale.z = 1 + k * 1.5;
        return true;
      },
      dispose() { scene.remove(group); disposeTree(group); },
    };
  }

  function sparks(at, color, born) {
    const n = 160;
    const pos = new Float32Array(n * 3);
    const vel = [];
    const cols = new Float32Array(n * 3);
    const palette = [glow(color, 3), glow("#ffb347", 4), glow("#ffffff", 4)];
    for (let i = 0; i < n; i++) {
      pos.set([at.x, at.y, at.z], i * 3);
      const v = new THREE.Vector3(Math.random() - 0.5, Math.random() - 0.3, Math.random() * 0.8 + 0.1).normalize()
        .multiplyScalar(2 + Math.random() * 4);
      vel.push(v);
      const c = palette[i % 3];
      cols.set([c.r, c.g, c.b], i * 3);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    geo.setAttribute("color", new THREE.BufferAttribute(cols, 3));
    const points = new THREE.Points(geo, new THREE.PointsMaterial({
      size: 0.09, map: softDot, vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false,
    }));
    scene.add(points);
    let last = born;
    return {
      update(t) {
        const k = (t - born) / 900;
        if (k >= 1) return false;
        const dt = Math.min(0.05, (t - last) / 1000);
        last = t;
        for (let i = 0; i < n; i++) {
          vel[i].y -= 6 * dt;
          vel[i].multiplyScalar(1 - 1.5 * dt);
          pos[i * 3] += vel[i].x * dt;
          pos[i * 3 + 1] += vel[i].y * dt;
          pos[i * 3 + 2] += vel[i].z * dt;
        }
        geo.attributes.position.needsUpdate = true;
        points.material.opacity = 1 - k;
        return true;
      },
      dispose() { scene.remove(points); disposeTree(points); },
    };
  }

  function shockwave(at, color, born) {
    const ring = new THREE.Mesh(new THREE.TorusGeometry(BOARD_R, 0.05, 8, 64),
      new THREE.MeshBasicMaterial({ color: glow(color, 4), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }));
    ring.position.copy(at).add(new THREE.Vector3(0, 0, 0.15));
    scene.add(ring);
    return {
      update(t) {
        const k = (t - born) / 600;
        if (k >= 1) return false;
        ring.scale.setScalar(1 + k * 1.6);
        ring.material.opacity = 1 - k;
        return true;
      },
      dispose() { scene.remove(ring); disposeTree(ring); },
    };
  }

  document.addEventListener("dwl:fire", (e) => fire(e.detail.key, e.detail.text));
  document.addEventListener("dwl:miss", () => { gun.miss = 1; kick(); });

  // ---------- Frame loop ----------

  const tmp = new THREE.Vector3();
  let width = 0;
  let height = 0;

  // minTop keeps a label (anchored by its bottom edge) from leaving the top of the arena.
  function placeAt(node, world, minTop = 0, halfWidth = 0) {
    tmp.copy(world).project(camera);
    const x = Math.min(Math.max((tmp.x + 1) / 2 * width, halfWidth + 4), width - halfWidth - 4);
    const y = Math.max((1 - tmp.y) / 2 * height, minTop);
    node.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px) translate(-50%, -100%)`;
  }

  function resize() {
    width = arena.clientWidth;
    height = arena.clientHeight;
    if (!width || !height) return;
    renderer.setSize(width, height, false);
    composer.setSize(width, height);
    camera.aspect = width / height;
    // Keep the range in view on tall, narrow screens.
    camera.fov = camera.aspect < 1.2 ? 62 : 48;
    camera.updateProjectionMatrix();
    frame.fit(camera);
    measureLabels();
    layout();
    kick();
  }

  let running = false;
  let visible = true;
  let last = performance.now();
  let settleUntil = 0;

  function kick() {
    settleUntil = performance.now() + 900;
    if (running || !visible || document.hidden) return;
    running = true;
    last = performance.now();
    requestAnimationFrame(tick);
  }

  function damp(current, target, rate, dt) { return current + (target - current) * (1 - Math.exp(-rate * dt)); }

  function tick(t) {
    if (!visible || document.hidden) { running = false; return; }
    const dt = Math.min(0.05, (t - last) / 1000);
    last = t;
    const time = t / 1000;
    const idle = reduceMotion ? 0 : 1;

    // Camera: gentle parallax toward the pointer, plus a kick on impact.
    shake = damp(shake, 0, 6, dt);
    const px = pointerSeen ? pointer.x : 0;
    const py = pointerSeen ? pointer.y : 0;
    camera.position.x = damp(camera.position.x, px * 0.35 * idle + (Math.random() - 0.5) * shake * 0.08, 4, dt);
    camera.position.y = damp(camera.position.y, CAMERA_Y + py * 0.15 * idle + Math.sin(time * 0.8) * 0.02 * idle, 4, dt);
    camera.lookAt(lookAt);

    let active = null;
    for (const view of views.values()) {
      if (view.active) active = view;
      const target = (view.active ? 1.25 : 0.9) * (view.fit || 1);
      view.scale = damp(view.scale, target, 8, dt);
      view.group.scale.setScalar(view.scale);
      view.group.position.x = damp(view.group.position.x, view.x, 6, dt);
      view.group.position.z = damp(view.group.position.z, view.active ? 0.6 : 0, 6, dt);

      const since = view.hitAt < 0 ? 99 : (t - view.hitAt) / 1000;
      const hit = Math.max(0, 1 - since / 0.6);
      view.board.rotation.z = Math.sin(since * 40) * 0.12 * hit;
      view.board.position.x = Math.sin(since * 55) * 0.06 * hit;
      const pulse = view.active ? 0.5 + 0.5 * Math.sin(time * 3) * idle : 0;
      view.faceMat.emissiveIntensity = (view.active ? 0.75 : 0.35) + hit * 2.5;
      view.rimMat.color.set(view.color).multiplyScalar((view.active ? 2.5 + pulse * 1.5 : 1.2) + hit * 4);
      view.halo.material.opacity = (view.active ? 0.55 + pulse * 0.2 : 0.25) + hit * 0.5;
    }

    gun.update(dt, time * idle, gun.lockOn || active, camera);
    if (gun.lockOn && gun.recoil < 0.05) gun.lockOn = null;

    for (let i = effects.length - 1; i >= 0; i--) {
      if (!effects[i].update(t)) { effects[i].dispose(); effects.splice(i, 1); }
    }
    if (idle) {
      for (const c of clouds) {
        c.position.x += c.userData.speed * dt;
        if (c.position.x > 110) c.position.x = -110;
      }
      if (dust) dust.update(dt);
    }

    composer.render();

    // Labels sit above each board.
    for (const view of views.values()) {
      placeAt(view.label, tmp.set(0, BOARD_Y + BOARD_R + 0.3, 0).applyMatrix4(view.group.matrixWorld).clone(),
        view.labelH + 46, view.labelW / 2); // clear of the hangar beam
    }

    const animating = !reduceMotion || effects.length || t < settleUntil;
    if (animating) requestAnimationFrame(tick);
    else running = false;
  }

  new ResizeObserver(resize).observe(arena);
  new IntersectionObserver(([entry]) => { visible = entry.isIntersecting; kick(); }).observe(arena);
  document.addEventListener("visibilitychange", kick);

  resize();
  syncFromDom();
}

// ---------- Scenery ----------

function buildSky(scene) {
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    uniforms: {
      top: { value: new THREE.Color(0x0f3a9c) },
      mid: { value: new THREE.Color(0x3b7ddb) },
      horizon: { value: new THREE.Color(0x8ab8ee) },
    },
    vertexShader: `
      varying vec3 vDir;
      void main() {
        vDir = normalize(position);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: `
      uniform vec3 top; uniform vec3 mid; uniform vec3 horizon;
      varying vec3 vDir;
      void main() {
        float h = vDir.y;
        vec3 c = mix(horizon, mid, smoothstep(0.0, 0.05, h));
        c = mix(c, top, smoothstep(0.05, 0.3, h));
        gl_FragColor = vec4(c, 1.0);
      }`,
  });
  scene.add(new THREE.Mesh(new THREE.SphereGeometry(200, 32, 16), mat));
}

function buildClouds(scene) {
  const rand = seeded(7);
  const out = [];
  for (let i = 0; i < 14; i++) {
    const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: softDot, color: 0xc4d8f5, transparent: true, opacity: 0.4 + rand() * 0.3, fog: false, depthWrite: false }));
    s.scale.set(26 + rand() * 30, 6 + rand() * 5, 1);
    s.position.set(-110 + rand() * 220, 16 + rand() * 22, -110 - rand() * 50);
    s.userData.speed = 0.3 + rand() * 0.6;
    scene.add(s);
    out.push(s);
  }
  return out;
}

function buildMountains(scene) {
  const rand = seeded(42);
  const rock = new THREE.MeshStandardMaterial({ color: 0x31507f, roughness: 1, flatShading: true });
  const snow = new THREE.MeshStandardMaterial({ color: 0xc9dcf5, roughness: 0.9, flatShading: true });
  for (let i = 0; i < 46; i++) {
    const far = rand();
    const h = 8 + rand() * 22 + far * 12;
    const r = h * (0.45 + rand() * 0.35);
    const segs = 5 + Math.floor(rand() * 3);
    const x = -130 + rand() * 260;
    const z = -45 - far * 70;
    const cone = new THREE.Mesh(new THREE.ConeGeometry(r, h, segs, 1), rock);
    cone.position.set(x, h / 2 - 0.5, z);
    cone.rotation.y = rand() * Math.PI;
    scene.add(cone);
    if (h > 16) {
      const k = 0.28;
      const cap = new THREE.Mesh(new THREE.ConeGeometry(r * k + 0.05, h * k, segs, 1), snow);
      cap.position.set(x, h - (h * k) / 2 - 0.5 + 0.02, z);
      cap.rotation.y = cone.rotation.y;
      scene.add(cap);
    }
  }
  // A far-off spire, like the reference skyline.
  const tower = new THREE.Group();
  const towerMat = new THREE.MeshStandardMaterial({ color: 0x3a5a90, roughness: 0.6, metalness: 0.3 });
  const levels = [[2.4, 3.2, 14], [1.4, 2.2, 12], [0.7, 1.2, 10], [0.08, 0.6, 9]];
  let y = 0;
  for (const [rt, rb, hh] of levels) {
    const seg = new THREE.Mesh(new THREE.CylinderGeometry(rt, rb, hh, 8), towerMat);
    seg.position.y = y + hh / 2;
    y += hh;
    tower.add(seg);
  }
  const beacon = new THREE.Mesh(new THREE.SphereGeometry(0.5, 12, 8), new THREE.MeshBasicMaterial({ color: glow("#9fe8ff", 4) }));
  beacon.position.y = y;
  tower.add(beacon);
  tower.position.set(36, 0, -78);
  scene.add(tower);
}

function buildFloor(scene) {
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(240, 240),
    new THREE.MeshStandardMaterial({ color: 0x0a1a3a, metalness: 0.5, roughness: 0.3 }));
  floor.rotation.x = -Math.PI / 2;
  scene.add(floor);
  const grid = new THREE.GridHelper(240, 120, 0x29e0ff, 0x29e0ff);
  grid.material.transparent = true;
  grid.material.opacity = 0.45;
  grid.material.color.setScalar(1.6); // multiplies the cyan line colours into bloom range
  grid.position.y = 0.01;
  scene.add(grid);
}

function buildDust(scene) {
  const n = 220;
  const pos = new Float32Array(n * 3);
  const rand = seeded(3);
  for (let i = 0; i < n; i++) pos.set([-14 + rand() * 28, rand() * 5, -12 + rand() * 18], i * 3);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  const pts = new THREE.Points(geo, new THREE.PointsMaterial({
    size: 0.04, map: softDot, color: glow("#9fe8ff", 1.5), transparent: true, opacity: 0.6, blending: THREE.AdditiveBlending, depthWrite: false,
  }));
  scene.add(pts);
  return {
    update(dt) {
      for (let i = 0; i < n; i++) {
        pos[i * 3 + 1] += dt * 0.12;
        if (pos[i * 3 + 1] > 5) pos[i * 3 + 1] = 0;
      }
      geo.attributes.position.needsUpdate = true;
    },
  };
}

// Hangar opening: beam, pillars and lamps, fixed to the camera so they always frame the view.
function buildFrame(camera) {
  const group = new THREE.Group();
  const metal = new THREE.MeshStandardMaterial({ color: 0x0b1838, metalness: 0.5, roughness: 0.5 });
  const beam = new THREE.Mesh(new THREE.BoxGeometry(1, 0.55, 0.5), metal);
  const pillars = [-1, 1].map((side) => {
    const p = new THREE.Group();
    const body = new THREE.Mesh(new THREE.BoxGeometry(0.5, 1, 0.5), metal);
    const strip = new THREE.Mesh(new THREE.BoxGeometry(0.03, 1, 0.03), new THREE.MeshBasicMaterial({ color: glow("#29b6ff", 2.5) }));
    strip.position.set(-side * 0.26, 0, 0.2);
    p.add(body, strip);
    p.userData.side = side;
    p.userData.body = body;
    p.userData.strip = strip;
    return p;
  });
  const lampMat = new THREE.MeshBasicMaterial({ color: glow("#ffa646", 3) });
  const lamps = [-0.55, -0.22, 0.22, 0.55].map((f) => {
    const l = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.035, 0.08), lampMat);
    l.userData.f = f;
    return l;
  });
  const warm = [-0.4, 0.4].map((f) => {
    const l = new THREE.PointLight(0xffa646, 4, 7, 1.6);
    l.userData.f = f;
    return l;
  });
  group.add(beam, ...pillars, ...lamps, ...warm);
  group.position.z = -FRAME_DEPTH;
  camera.add(group);

  return {
    fit(cam) {
      const hh = FRAME_DEPTH * Math.tan(THREE.MathUtils.degToRad(cam.fov / 2));
      const hw = hh * cam.aspect;
      beam.scale.x = hw * 2 + 1;
      beam.position.y = hh + 0.05;
      for (const p of pillars) {
        p.position.set(p.userData.side * (hw + 0.08), 0, 0);
        p.userData.body.scale.y = p.userData.strip.scale.y = hh * 2 + 1;
      }
      for (const l of lamps) l.position.set(l.userData.f * hw, hh - 0.24, 0.1);
      for (const l of warm) l.position.set(l.userData.f * hw, hh - 0.5, 0.5);
    },
  };
}

// First-person blaster, built along +z so Object3D.lookAt points the barrel at the target.
function buildGun(camera) {
  const pivot = new THREE.Group();
  pivot.position.set(0.08, -0.5, -0.55);
  camera.add(pivot);
  const body = new THREE.Group();
  pivot.add(body);

  const metal = new THREE.MeshStandardMaterial({ color: 0x5573b8, metalness: 0.45, roughness: 0.3, emissive: 0x0c1c44 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x22345f, metalness: 0.4, roughness: 0.45, emissive: 0x08132e });
  const cyan = new THREE.MeshBasicMaterial({ color: glow("#29d3ff", 1.4) });
  const orange = new THREE.MeshBasicMaterial({ color: glow("#ff8f2e", 1.6) });
  const box = (w, h, d, mat, x, y, z) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
    m.position.set(x, y, z);
    body.add(m);
    return m;
  };
  box(0.44, 0.36, 0.45, dark, 0, -0.02, -0.12);
  box(0.36, 0.27, 0.9, metal, 0, 0, 0.45);
  box(0.24, 0.12, 0.62, dark, 0, 0.18, 0.42);
  for (const z of [0.62, 0.7, 0.78]) box(0.07, 0.02, 0.035, orange, 0, 0.245, z);
  box(0.016, 0.04, 0.82, cyan, 0.182, 0.03, 0.45);
  box(0.016, 0.04, 0.82, cyan, -0.182, 0.03, 0.45);
  box(0.3, 0.02, 0.05, cyan, 0, -0.08, 0.91);
  const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.065, 0.085, 0.62, 20), metal);
  barrel.rotation.x = Math.PI / 2;
  barrel.position.set(0, 0.04, 1.2);
  body.add(barrel);
  for (const z of [1.0, 1.28]) {
    const ring = new THREE.Mesh(new THREE.TorusGeometry(0.083, 0.013, 8, 24), cyan);
    ring.position.set(0, 0.04, z);
    body.add(ring);
  }
  const tip = new THREE.Mesh(new THREE.TorusGeometry(0.07, 0.02, 8, 24), cyan);
  tip.position.set(0, 0.04, 1.5);
  body.add(tip);

  const muzzle = new THREE.Object3D();
  muzzle.position.set(0, 0.04, 1.56);
  body.add(muzzle);
  const flashSprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: softDot, color: glow("#bff6ff", 4), transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false }));
  flashSprite.scale.setScalar(0.6);
  muzzle.add(flashSprite);
  const flashLight = new THREE.PointLight(0x7fe3ff, 0, 6, 1.5);
  muzzle.add(flashLight);

  const aimer = new THREE.Object3D();
  pivot.parent.add(aimer);
  const ahead = new THREE.Vector3();
  const goal = new THREE.Vector3();

  const gun = {
    muzzle, recoil: 0, flash: 0, miss: 0, lockOn: null,
    update(dt, time, target, cam) {
      if (target) target.board.getWorldPosition(goal);
      else goal.copy(cam.localToWorld(ahead.set(0, -0.2, -20)));
      aimer.position.copy(pivot.position);
      aimer.lookAt(goal);
      const rate = gun.lockOn ? 30 : 7;
      pivot.quaternion.slerp(aimer.quaternion, 1 - Math.exp(-rate * dt));

      gun.recoil = Math.max(0, gun.recoil - dt * 5);
      gun.flash = Math.max(0, gun.flash - dt * 7);
      gun.miss = Math.max(0, gun.miss - dt * 2.5);
      body.position.z = -0.18 * gun.recoil;
      body.rotation.x = -0.12 * gun.recoil;
      body.rotation.z = Math.sin(gun.miss * 30) * 0.15 * gun.miss;
      body.position.y = Math.sin(time * 1.6) * 0.012;
      flashSprite.material.opacity = gun.flash;
      flashSprite.scale.setScalar(0.4 + gun.flash * 0.6);
      flashLight.intensity = gun.flash * 12;
    },
  };
  return gun;
}

// ---------- Boot ----------

if (window.top === window.self && arena && domTargets && hasWebGL2()) {
  try {
    start();
  } catch (err) {
    console.warn("[Daily Work Log] 3D arena unavailable, using the flat one:", err);
    arena.classList.remove("is-3d");
    arena.querySelectorAll(".arena-canvas, .arena-labels").forEach((n) => n.remove());
  }
}
