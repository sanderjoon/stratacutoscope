import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { mergeVertices } from "three/addons/utils/BufferGeometryUtils.js";
import { ConvexHull } from "three/addons/math/ConvexHull.js";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";
import { SMAAPass } from "three/addons/postprocessing/SMAAPass.js";
import { ShaderPass } from "three/addons/postprocessing/ShaderPass.js";
import { N8AOPass } from "n8ao";
import { MODELS, inkColorFor } from "./models.js";
const CUT_ZOOM_SENSITIVITY = 1;
const AO_RADIUS_RATIO = 0.08; // of the model's largest dimension
const ZOOM_OUT_MARGIN = 1.15; // of the model's radius; lets the whole model sit inside the view
const FOG_DEPTH_RATIO = 4; // of the model's radius; how far behind the cut plane the haze is total
const INTRO_HAZE_RATIO = 0.3; // of the model's radius; fog depth at the start of the intro
const INTRO_DURATION = 2000; // ms
const SLIDE_OUT_DURATION = 180; // ms
const SLIDE_IN_DURATION = 420; // ms
const SLIDE_TRAVEL = 0.3; // of the visible half-height; the fade does the rest
const AUTO_ROTATION_SPEED = 0.65; // rad/s, the turntable's motor speed
const DRAG_ROTATION_SENSITIVITY = 0.008;
const VERTICAL_DRAG_ROTATION_SENSITIVITY = 0.002;
const GYROSCOPE_Y_SENSITIVITY = 10;
// Rates (1/s) at which the free-spinning velocity relaxes toward the motor
// speed. They shape drag inertia and play/pause spin-up/coast-down alike.
const HORIZONTAL_INERTIA_DAMPING = 1.1;
const VERTICAL_INERTIA_DAMPING = 4;
// Engineered stone in the cut face: chips of a few tones set in a veined
// resin. Everything is generated in the model's own space, so the cut shows
// cross-sections of the chips and the veins, and they stay put as the plane moves.
const CHIP_CELL_RATIO = 0.05; // of the model's largest dimension; one chip per cell at most
const CHIP_LAYERS = [
  // scale: cells per base cell; density: share of cells that hold a chip
  { scale: 1, density: 0.75 },
  { scale: 1.8, density: 0.6 },
  { scale: 3.2, density: 0.5 },
  { scale: 5.5, density: 0.4 }
];
const CHIP_RADIUS = [0.05, 0.28]; // of the cell size, skewed toward small
// Chips sit on a cylindrical grid about the turntable axis, so a turn of the
// model slides them through the cut instead of flashing new cross-sections.
// Angular cells span a fixed angle, so chips are drawn out along their arc in
// proportion to their radius: this much at the reference radius.
const CHIP_ARC_STRETCH = 3;
const CHIP_ARC_REFERENCE = 0.5; // of the model's radius
const CHIP_COLORS = ["#141414", "#f5efe4", "#8f8c86", "#f5efe4"];
const CHIP_EMBED = 0.5; // how far a chip's tone can sink toward the resin colour
const VEIN_SCALE = 0.22; // in base cells; smaller is a wider, lazier vein pattern
const VEIN_WIDTH = 0.07; // bold veins; the finer second set is half as wide and strong
const VEIN_STRENGTH = 0.7;
const CLOUD_STRENGTH = 0.14; // mottling of the resin's brightness
const CAP_EMISSIVE_INTENSITY = 0.65;
const status = document.querySelector("#status");
const motionButton = document.querySelector("#motion");
const gyroscopeButton = document.querySelector("#gyroscope");
const aboutToggleButton = document.querySelector("#about-toggle");
const aboutOverlay = document.querySelector("#about-overlay");
const modelPicker = document.querySelector(".model-picker");
const modelPickerToggle = document.querySelector("#model-picker-toggle");
const modelPickerMenu = document.querySelector("#model-picker-menu");
const previousModelButton = document.querySelector("#previous-model");
const randomModelButton = document.querySelector("#random-model");
const nextModelButton = document.querySelector("#next-model");
const themeColorMeta = document.querySelector('meta[name="theme-color"]');

// Fallback for browsers without CSS contrast-color(): pick black or white by
// WCAG contrast. White wins once the background's relative luminance drops
// below 0.1791, where both choices have equal contrast.
function applyBackgroundColor(hex) {
  const root = document.documentElement.style;
  root.setProperty("--bg", hex);
  root.setProperty("--ink-fallback", inkColorFor(hex));
  themeColorMeta.content = hex;
}

// Background and name change together, as soon as a switch starts.
function showModelIdentity(index) {
  applyBackgroundColor(MODELS[index].backgroundColor);
  modelPickerToggle.textContent = MODELS[index].name;
}
const canvas = document.querySelector("#scene");
const isTouchDevice = navigator.maxTouchPoints > 0 ||
  window.matchMedia("(pointer: coarse)").matches;
gyroscopeButton.hidden = !isTouchDevice || !("DeviceOrientationEvent" in window);

// The page background shows through a transparent canvas, so the per-model
// background colour is exact and unaffected by tone mapping in post-processing.
const scene = new THREE.Scene();
// Only near/far are used: fadeWithDistance() turns fog into transparency.
scene.fog = new THREE.Fog(0x000000, 1, 2);

const camera = new THREE.PerspectiveCamera(34, 1, 0.01, 100);
camera.up.set(0, 1, 0);
camera.layers.enable(1);
const renderer = new THREE.WebGLRenderer({
  canvas,
  antialias: false, // SMAA in the composer instead; MSAA is lost in render targets anyway
  alpha: true,
  stencil: true
});
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.12;
renderer.localClippingEnabled = true;

// A soft studio environment gives the PBR materials grazing-angle (fresnel)
// reflections and fills in the shadows a little.
const pmremGenerator = new THREE.PMREMGenerator(renderer);
scene.environment = pmremGenerator.fromScene(new RoomEnvironment(), 0.04).texture;
scene.environmentIntensity = 0.35;
pmremGenerator.dispose();

// Post-processing: screen-space ambient occlusion, then tone mapping / sRGB,
// then SMAA (hardware MSAA does not apply once rendering goes through targets).
// N8AO derives normals from depth, so the clipped model and the stencil caps
// are occluded exactly as drawn.
const composer = new EffectComposer(renderer);
const aoPass = new N8AOPass(scene, camera, 1, 1);
aoPass.configuration.stencil = true;
aoPass.configuration.gammaCorrection = false;
aoPass.configuration.intensity = 2;
aoPass.configuration.distanceFalloff = 1;
aoPass.configuration.halfRes = isTouchDevice;
composer.addPass(aoPass);
composer.addPass(new OutputPass());
// Fragments carry a distance-based alpha (see fadeWithDistance). The canvas is
// composited premultiplied, so multiply colour by alpha once tone mapping is done.
composer.addPass(new ShaderPass({
  uniforms: { tDiffuse: { value: null } },
  vertexShader: `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }`,
  fragmentShader: `
    uniform sampler2D tDiffuse;
    varying vec2 vUv;
    void main() {
      vec4 texel = texture2D(tDiffuse, vUv);
      gl_FragColor = vec4(texel.rgb * texel.a, texel.a);
    }`
}));
composer.addPass(new SMAAPass(1, 1));

// Distance haze in the page's background colour. Blending toward a fog colour
// would be shifted by tone mapping, so instead the fragment's alpha falls off
// between fogNear and fogFar and the CSS background shows through.
// Whole-model opacity, used by the switch transition. Shared by every material.
const modelOpacity = { value: 1 };
function fadeWithDistance(material) {
  material.onBeforeCompile = (shader) => {
    shader.uniforms.modelOpacity = modelOpacity;
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <fog_pars_fragment>", "#include <fog_pars_fragment>\nuniform float modelOpacity;")
      .replace(
        "#include <fog_fragment>",
        "#ifdef USE_FOG\n  gl_FragColor.a *= (1.0 - smoothstep(fogNear, fogFar, vFogDepth)) * modelOpacity;\n#endif"
      );
  };
  material.customProgramCacheKey = () => "fade-with-distance";
  return material;
}

// Cut-face stone. Chips are random polyhedra, one per cell of a 3D grid in
// model space, over a resin whose brightness is mottled and cut by thin veins.
const chipUniforms = {
  capToModel: { value: new THREE.Matrix4() },
  chipCell: { value: 1 },
  chipTurn: { value: 16 }, // angular cells in a full turn at the base scale
  chipColors: { value: CHIP_COLORS.map((hex) => new THREE.Color(hex)) }
};
// Fine chips first so the coarse ones land on top. Each layer's angular cell
// count is rounded so the grid still wraps cleanly around the axis.
const chipLayersGlsl = [...CHIP_LAYERS].reverse().map((layer, index) => `
        turn = floor(chipTurn * ${layer.scale.toFixed(3)} + 0.5);
        chip = chips(
          vec3(stoneRadius * ${layer.scale.toFixed(3)} + ${(17.3 * index).toFixed(1)}, stoneTurns * turn, stonePoint.y * ${layer.scale.toFixed(3)} + ${(17.3 * index).toFixed(1)}),
          turn, ${layer.density.toFixed(3)}, resin, pixel * ${layer.scale.toFixed(3)});
        stone = mix(stone, chip.rgb, chip.a);`).join("");
function speckleCap(material) {
  const fade = material.onBeforeCompile;
  material.onBeforeCompile = (shader) => {
    fade(shader);
    Object.assign(shader.uniforms, chipUniforms);
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nvarying vec3 vCapWorld;")
      .replace(
        "#include <worldpos_vertex>",
        "#include <worldpos_vertex>\nvCapWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;"
      );
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", `#include <common>
        varying vec3 vCapWorld;
        uniform mat4 capToModel;
        uniform float chipCell;
        uniform float chipTurn;
        uniform vec3 chipColors[${CHIP_COLORS.length}];
        vec3 hash3(vec3 p) {
          p = vec3(dot(p, vec3(127.1, 311.7, 74.7)),
                   dot(p, vec3(269.5, 183.3, 246.1)),
                   dot(p, vec3(113.5, 271.9, 124.6)));
          return fract(sin(p) * 43758.5453123);
        }
        float noise(vec3 p) {
          vec3 i = floor(p);
          vec3 f = fract(p);
          f = f * f * (3.0 - 2.0 * f);
          return mix(
            mix(mix(hash3(i).x, hash3(i + vec3(1, 0, 0)).x, f.x),
                mix(hash3(i + vec3(0, 1, 0)).x, hash3(i + vec3(1, 1, 0)).x, f.x), f.y),
            mix(mix(hash3(i + vec3(0, 0, 1)).x, hash3(i + vec3(1, 0, 1)).x, f.x),
                mix(hash3(i + vec3(0, 1, 1)).x, hash3(i + vec3(1, 1, 1)).x, f.x), f.y),
            f.z) * 2.0 - 1.0;
        }
        float fbm(vec3 p) {
          float sum = 0.0;
          float amplitude = 0.5;
          for (int i = 0; i < 4; i++) {
            sum += amplitude * noise(p);
            p = p * 2.03 + 11.1;
            amplitude *= 0.5;
          }
          return sum;
        }
        // u is cylindrical, in cells: (radius, angle, height), with the angle
        // wrapping every turn cells. rgb: chip colour, a: coverage
        // (anti-aliased). pixel is the fragment's footprint in cells;
        // derivatives are undefined inside the loop's branches, so it is
        // taken outside.
        vec4 chips(vec3 u, float turn, float density, vec3 resin, float pixel) {
          vec3 cell = floor(u);
          vec4 result = vec4(0.0);
          // One pixel spans more angular cells the closer it is to the axis.
          vec3 footprint = vec3(pixel, pixel * turn / max(u.x * 6.2831853, 1e-3), pixel);
          for (int x = -1; x <= 1; x++)
          for (int y = -1; y <= 1; y++)
          for (int z = -1; z <= 1; z++) {
            vec3 neighbour = cell + vec3(x, y, z);
            vec3 key = vec3(neighbour.x, mod(neighbour.y, turn), neighbour.z);
            vec3 seed = hash3(key);
            if (seed.x > density) continue;
            vec3 shape = hash3(key + 17.3);
            vec3 spin = hash3(key + 41.9);
            vec3 tone = hash3(key + 73.1);
            vec3 centre = neighbour + 0.5 + (seed - 0.5) * 0.4;
            vec3 offset = u - centre;
            offset.y = mod(offset.y + turn * 0.5, turn) - turn * 0.5;
            // Mostly small chips, a few large ones.
            float radius = ${CHIP_RADIUS[0].toFixed(3)} *
              pow(${(CHIP_RADIUS[1] / CHIP_RADIUS[0]).toFixed(3)}, shape.x * shape.x);
            vec3 extent = radius * (0.6 + shape * 0.8);
            // A random roll about the arc, then a shard somewhere between a
            // box, an octahedron and a sphere.
            float roll = spin.x * 6.2831853;
            vec3 q = abs(vec3(
              cos(roll) * offset.x - sin(roll) * offset.z,
              offset.y,
              sin(roll) * offset.x + cos(roll) * offset.z)) / extent;
            float box = max(max(q.x, q.y), q.z);
            float octahedron = (q.x + q.y + q.z) / (1.0 + spin.y * 1.2);
            float sphere = length(q);
            float distance = mix(max(box, octahedron), sphere, tone.y * 0.7);
            float width = length(footprint / extent);
            float coverage = 1.0 - smoothstep(1.0 - width, 1.0 + width, distance);
            if (coverage > result.a) {
              vec3 colour = chipColors[int(seed.z * ${CHIP_COLORS.length}.0)] * (0.8 + tone.z * 0.4);
              colour = mix(colour, resin, tone.x * ${CHIP_EMBED.toFixed(3)});
              result = vec4(colour, coverage);
            }
          }
          return result;
        }`)
      .replace("#include <color_fragment>", `#include <color_fragment>
        vec3 stonePoint = (capToModel * vec4(vCapWorld, 1.0)).xyz / chipCell;
        float pixel = length(fwidth(stonePoint)) * 0.7;
        // Resin: the cap's colour, mottled, with thin veins where a noise field crosses zero.
        vec3 resin = diffuseColor.rgb * (1.0 + ${CLOUD_STRENGTH.toFixed(3)} * fbm(stonePoint * ${(VEIN_SCALE * 0.5).toFixed(4)} + 5.3));
        // Veins are the zero crossings of a noise field, warped by another so
        // they wander and branch like marble. A finer set lies underneath.
        vec3 veinPoint = stonePoint * ${VEIN_SCALE.toFixed(4)};
        veinPoint += 0.9 * vec3(fbm(veinPoint + 3.1), fbm(veinPoint + 9.7), fbm(veinPoint + 15.9));
        float vein = 1.0 - smoothstep(0.0, ${VEIN_WIDTH.toFixed(3)}, abs(fbm(veinPoint)));
        float fineVein = 1.0 - smoothstep(0.0, ${(VEIN_WIDTH / 2).toFixed(3)}, abs(fbm(veinPoint * 2.1 + 27.3)));
        vec3 veinColour = mix(diffuseColor.rgb * 0.45, chipColors[0], 0.4);
        resin = mix(resin, veinColour, max(vein, fineVein * 0.5) * ${VEIN_STRENGTH.toFixed(3)});
        float stoneRadius = length(stonePoint.xz);
        float stoneTurns = atan(stonePoint.z, stonePoint.x) / 6.2831853 + 0.5;
        vec3 stone = resin;
        vec4 chip;
        float turn;${chipLayersGlsl}
        diffuseColor.rgb = stone;`)
      .replace("#include <emissivemap_fragment>", `#include <emissivemap_fragment>
        totalEmissiveRadiance = stone * ${CAP_EMISSIVE_INTENSITY};`);
  };
  material.customProgramCacheKey = () => "speckled-cap";
  return material;
}

const ambient = new THREE.HemisphereLight(0xfff8ec, 0x77736c, 0);
ambient.position.set(0, 0, 1);
//scene.add(ambient);
const keyLight = new THREE.DirectionalLight(0xfff3e3, 1.7);
keyLight.position.set(-3.5, 5, -10);
scene.add(keyLight);
const fillLight = new THREE.DirectionalLight(0xdce5ef, 0.2);
fillLight.position.set(4, 1.5, -4);
scene.add(fillLight);
const capFillLight = new THREE.DirectionalLight(0xffffff, 2.5);
capFillLight.layers.set(1);
scene.add(capFillLight);
scene.add(capFillLight.target);

const specimen = new THREE.Group();
specimen.rotation.order = "YXZ";
scene.add(specimen);
const modelOrientation = new THREE.Group();
specimen.add(modelOrientation);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.075;
controls.enablePan = false;
controls.enableZoom = true;
controls.enableRotate = false;
controls.zoomSpeed = 0.3375;
controls.rotateSpeed = 0.62;
controls.target.set(0, 0, 0);

let fitDistance = 4;
let fitCameraDistance = 0;
const activePointers = new Map();
// Current spin, in the units applyDragRotation() takes (x: yaw, y: pitch).
// A drag sets it directly; otherwise it relaxes toward the motor speed.
const angularVelocity = new THREE.Vector2(-AUTO_ROTATION_SPEED, 0);
let specimenPitch = 0;
let specimenYaw = 0;
const pitchRotation = new THREE.Quaternion();
const yawRotation = new THREE.Quaternion();
const specimenRotation = new THREE.Quaternion();
const worldZAxis = new THREE.Vector3(0, 0, 1);
const localYAxis = new THREE.Vector3(0, 1, 0);
const modelBounds = new THREE.Box3();
let minCameraDistance = 0;
// Convex hull vertices of the model (local space); enough to find its extent in any direction.
let modelExtremePoints = [];
// Distance from the model's centre to its farthest point; the cut plane clears
// the whole model in every orientation once it is this far from the target.
let modelRadius = 0;
// Intro: how far the haze is pulled in toward the cut plane (1 = right up to it).
let introHaze = 0;
let introTween = null;
// Model switch: the specimen's screen-vertical offset (positive = up).
let slideOffset = 0;
let slideTween = null;
const slideAxis = new THREE.Vector3();
const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
let currentModelIndex = -1;
let modelLoading = false;
let motionEnabled = true;
let previousDeviceOrientation = null;
let gyroscopeEnabled = false;
let lastFrameTime = 0;
const viewDirection = new THREE.Vector3(1, 0, 0);
const cameraDirection = new THREE.Vector3();
const cutPoint = new THREE.Vector3();
const cutPlane = new THREE.Plane();
const planeNormal = new THREE.Vector3(0, 0, 1);
const capGeometry = new THREE.PlaneGeometry(1, 1);
const cameraDirectionForFit = new THREE.Vector3();
let previousPointerTime = 0;
const modelLoader = new GLTFLoader();
// Parsed GLBs are kept so switching back to a model needs no network or parse work.
const modelRequests = new Map();

function fetchModel(index) {
  if (!modelRequests.has(index)) {
    const request = modelLoader.loadAsync(MODELS[index].url);
    request.then(() => { request.ready = true; });
    modelRequests.set(index, request);
  }
  return modelRequests.get(index);
}

const statusText = status.querySelector(".status-text");
function setStatus(message, isError = false) {
  statusText.textContent = message;
  status.dataset.error = String(isError);
  status.hidden = !message && status.dataset.loading !== "true";
}

// The loading indicator is the animated dots in the HTML; this only shows or hides them.
function setLoading(loading) {
  status.dataset.loading = String(loading);
  status.hidden = !loading && !statusText.textContent;
}

function setModelNavigationDisabled(disabled) {
  modelPickerToggle.disabled = disabled;
  previousModelButton.disabled = disabled;
  randomModelButton.disabled = disabled;
  nextModelButton.disabled = disabled;
  modelPickerMenu.querySelectorAll("button").forEach((button) => {
    button.disabled = disabled;
  });
  if (disabled) closeModelPicker();
}

function closeModelPicker() {
  modelPickerMenu.hidden = true;
  modelPickerToggle.setAttribute("aria-expanded", "false");
}

MODELS.forEach((model, index) => {
  const option = document.createElement("button");
  option.type = "button";
  option.textContent = model.name;
  option.setAttribute("role", "menuitem");
  option.addEventListener("click", () => {
    closeModelPicker();
    modelPickerToggle.focus();
    changeModel(index);
  });
  modelPickerMenu.append(option);
});

modelPickerToggle.addEventListener("click", () => {
  const isOpening = modelPickerMenu.hidden;
  modelPickerMenu.hidden = !isOpening;
  modelPickerToggle.setAttribute("aria-expanded", String(isOpening));
});

document.addEventListener("click", (event) => {
  if (!modelPicker.contains(event.target)) closeModelPicker();
});

window.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !modelPickerMenu.hidden) {
    closeModelPicker();
    modelPickerToggle.focus();
  }
});

function updateModelPickerSelection() {
  modelPickerMenu.querySelectorAll("button").forEach((button, index) => {
    if (index === currentModelIndex) {
      button.setAttribute("aria-current", "true");
    } else {
      button.removeAttribute("aria-current");
    }
  });
}

function disposeGroupContents(group, disposeGeometry) {
  const geometries = new Set();
  const materials = new Set();
  const textures = new Set();
  group.traverse((object) => {
    if (object.geometry && disposeGeometry) geometries.add(object.geometry);
    if (object.material) {
      for (const material of Array.isArray(object.material)
        ? object.material
        : [object.material]) {
        materials.add(material);
        for (const value of Object.values(material)) {
          if (value?.isTexture) textures.add(value);
        }
      }
    }
  });
  for (const child of [...group.children]) group.remove(child);
  for (const geometry of geometries) geometry.dispose();
  for (const material of materials) material.dispose();
  for (const texture of textures) texture.dispose();
}

function resize() {
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  if (!width || !height) return;
  renderer.setSize(width, height, false);
  composer.setSize(width, height);
  camera.aspect = width / height;
  camera.updateProjectionMatrix();
  if (modelBounds.isEmpty() === false) {
    fitCameraToModel();
  }
}

function fitCameraToModel() {
  cameraDirectionForFit.copy(camera.position).sub(controls.target).normalize();
  if (cameraDirectionForFit.lengthSq() === 0) {
    cameraDirectionForFit.copy(viewDirection);
  }
  camera.position.copy(controls.target).add(cameraDirectionForFit);
  camera.lookAt(controls.target);
  const verticalTangent = Math.tan(THREE.MathUtils.degToRad(camera.fov * 0.5));
  const horizontalTangent = verticalTangent * camera.aspect;
  const cameraRight = new THREE.Vector3(1, 0, 0).applyQuaternion(camera.quaternion);
  const cameraUp = new THREE.Vector3(0, 1, 0).applyQuaternion(camera.quaternion);
  const distanceToFit = (point) => {
    const depth = point.dot(cameraDirectionForFit);
    const horizontal = Math.abs(point.dot(cameraRight)) / horizontalTangent;
    const vertical = Math.abs(point.dot(cameraUp)) / verticalTangent;
    return depth + Math.max(horizontal, vertical);
  };
  let distance = 0;
  for (let x = 0; x < 2; x += 1) {
    for (let y = 0; y < 2; y += 1) {
      for (let z = 0; z < 2; z += 1) {
        const point = new THREE.Vector3(
          x ? modelBounds.max.x : modelBounds.min.x,
          y ? modelBounds.max.y : modelBounds.min.y,
          z ? modelBounds.max.z : modelBounds.min.z
        );
        distance = Math.max(distance, distanceToFit(point));
      }
    }
  }
  camera.position.copy(controls.target).addScaledVector(
    cameraDirectionForFit,
    distance * 0.9
  );
  camera.lookAt(controls.target);
  fitCameraDistance = camera.position.distanceTo(controls.target);
  limitZoomToModel();
  updateDistanceFade();
}

function hullVertices(points) {
  try {
    const hull = new ConvexHull().setFromPoints(points);
    const unique = new Set();
    for (const face of hull.faces) {
      let edge = face.edge;
      do {
        unique.add(edge.head().point);
        edge = edge.next;
      } while (edge !== face.edge);
    }
    return [...unique];
  } catch {
    // Degenerate input (e.g. flat or tiny); fall back to the bounding box corners.
    return Array.from({ length: 8 }, (_, i) => new THREE.Vector3(
      i & 1 ? modelBounds.max.x : modelBounds.min.x,
      i & 2 ? modelBounds.max.y : modelBounds.min.y,
      i & 4 ? modelBounds.max.z : modelBounds.min.z
    ));
  }
}

// Zooming moves the cut plane through the model, so limit the zoom range to
// where the plane is useful: zoomed in until the plane passes the far side of
// the model (nothing left), zoomed out until it clears the near side (whole
// model visible). Both depend on the model's current rotation.
// The zoom range is fixed per model so rotating never shifts the camera.
function limitZoomToModel() {
  if (modelBounds.isEmpty()) return;
  controls.minDistance = Math.max(
    minCameraDistance,
    fitCameraDistance - modelRadius / CUT_ZOOM_SENSITIVITY
  );
  controls.maxDistance = fitCameraDistance + (modelRadius * ZOOM_OUT_MARGIN) / CUT_ZOOM_SENSITIVITY;
}

// The cut plane always sits fitCameraDistance from the camera (zoom and cut
// move together), so the haze starts exactly at the cut and deepens behind it.
function updateDistanceFade() {
  scene.fog.near = fitCameraDistance;
  scene.fog.far = fitCameraDistance +
    modelRadius * THREE.MathUtils.lerp(FOG_DEPTH_RATIO, INTRO_HAZE_RATIO, introHaze);
}

// Frame-driven tweens. update() receives eased progress 0..1 and is called once
// synchronously; the promise resolves true on completion, false if cancelled.
const activeTweens = new Set();
const easeOutCubic = (t) => 1 - (1 - t) ** 3;
const easeInCubic = (t) => t * t * t;
function tween(duration, easing, update) {
  if (reducedMotion.matches) duration = 0;
  const start = performance.now();
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  const entry = {
    step(now) {
      const progress = duration ? Math.min((now - start) / duration, 1) : 1;
      update(easing(progress));
      if (progress === 1) {
        activeTweens.delete(entry);
        resolve(true);
      }
    },
    cancel() {
      if (!activeTweens.has(entry)) return;
      activeTweens.delete(entry);
      resolve(false);
    }
  };
  activeTweens.add(entry);
  update(easing(0));
  promise.cancel = entry.cancel;
  return promise;
}

// Vertical travel of the switch transition: a short drift, with the fade
// doing most of the work, so the change feels quick.
function slideDistance() {
  const halfHeight = camera.position.distanceTo(controls.target) *
    Math.tan(THREE.MathUtils.degToRad(camera.fov * 0.5));
  return halfHeight * SLIDE_TRAVEL;
}

function slideTo(targetOffset, targetOpacity, duration, easing) {
  slideTween?.cancel();
  const fromOffset = slideOffset;
  const fromOpacity = modelOpacity.value;
  slideTween = tween(duration, easing, (progress) => {
    slideOffset = THREE.MathUtils.lerp(fromOffset, targetOffset, progress);
    modelOpacity.value = THREE.MathUtils.lerp(fromOpacity, targetOpacity, progress);
  });
  return slideTween;
}

// +1 when the new model comes after the current one (it enters from above),
// -1 when it comes before. Picked by the shorter way round the list.
function switchDirection(index) {
  const forward = (index - currentModelIndex + MODELS.length) % MODELS.length;
  return forward <= MODELS.length / 2 ? 1 : -1;
}

// First appearance: the camera starts at the zoomed-out limit, where the cut
// plane clears the whole model, with the haze pulled right up to the cut. It
// then zooms in to the fit, so the slice sweeps into the model as the haze recedes.
function playIntro() {
  introTween?.cancel();
  const startDistance = controls.maxDistance;
  introTween = tween(INTRO_DURATION, easeOutCubic, (progress) => {
    introHaze = 1 - progress;
    updateDistanceFade();
    cameraDirection.copy(camera.position).sub(controls.target).normalize();
    camera.position.copy(controls.target).addScaledVector(
      cameraDirection,
      THREE.MathUtils.lerp(startDistance, fitCameraDistance, progress)
    );
  });
  return introTween;
}

// Any zoom or drag takes over from the intro.
function endIntro() {
  if (!introTween) return;
  introTween.cancel();
  introTween = null;
  introHaze = 0;
  updateDistanceFade();
}
canvas.addEventListener("wheel", endIntro, { passive: true });

function updateCutPlane() {
  cameraDirection.copy(camera.position).sub(controls.target).normalize();
  const zoomInDistance = fitCameraDistance - camera.position.distanceTo(controls.target);
  const cutDistance = -zoomInDistance * CUT_ZOOM_SENSITIVITY;
  cutPoint.copy(controls.target).addScaledVector(cameraDirection, cutDistance);
  cutPlane.setFromNormalAndCoplanarPoint(cameraDirection.clone().negate(), cutPoint);
  capGroup.position.copy(cutPoint);
  capGroup.quaternion.setFromUnitVectors(planeNormal, cameraDirection);
  capGroup.scale.setScalar(fitDistance * 4);
  capFillLight.position.copy(camera.position);
  capFillLight.target.position.copy(controls.target);
}

function relaxToward(value, target, rate, delta) {
  const next = target + (value - target) * Math.exp(-rate * delta);
  return Math.abs(next - target) < 1e-4 ? target : next;
}

// applyDragRotation() subtracts yaw, so the motor turns in the negative direction.
function motorVelocity() {
  return motionEnabled ? -AUTO_ROTATION_SPEED : 0;
}

function applyDragRotation(horizontalAngle, verticalAngle) {
  specimenYaw -= horizontalAngle;
  specimenPitch -= verticalAngle;
  updateSpecimenRotation();
}

function updateSpecimenRotation() {
  pitchRotation.setFromAxisAngle(worldZAxis, specimenPitch);
  yawRotation.setFromAxisAngle(localYAxis, specimenYaw);
  specimenRotation.copy(pitchRotation).multiply(yawRotation);
  specimen.quaternion.copy(specimenRotation);
}

canvas.addEventListener("pointerdown", (event) => {
  endIntro();
  activePointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
  if (activePointers.size === 1) {
    previousPointerTime = event.timeStamp;
  } else {
    angularVelocity.set(motorVelocity(), 0);
  }
});

canvas.addEventListener("pointermove", (event) => {
  const previous = activePointers.get(event.pointerId);
  if (!previous) return;
  const deltaX = event.clientX - previous.x;
  const deltaY = event.clientY - previous.y;
  activePointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
  if (activePointers.size !== 1) return;

  const elapsed = Math.max((event.timeStamp - previousPointerTime) / 1000, 1 / 120);
  const horizontalAngle = deltaX * DRAG_ROTATION_SENSITIVITY;
  const verticalAngle = deltaY * VERTICAL_DRAG_ROTATION_SENSITIVITY;
  applyDragRotation(horizontalAngle, verticalAngle);
  // The finger's speed rides on top of the motor, so a flick along the spin
  // speeds it up and one against it slows it down.
  angularVelocity.set(
    motorVelocity() + THREE.MathUtils.clamp(horizontalAngle / elapsed, -12, 12),
    THREE.MathUtils.clamp(verticalAngle / elapsed, -12, 12)
  );
  previousPointerTime = event.timeStamp;
});

const finishPointer = (event) => {
  activePointers.delete(event.pointerId);
  if (activePointers.size) angularVelocity.set(motorVelocity(), 0);
};
canvas.addEventListener("pointerup", finishPointer);
canvas.addEventListener("pointercancel", finishPointer);

const capGroup = new THREE.Group();
scene.add(capGroup);

function createStencilGroup(geometry, renderOrder) {
  const group = new THREE.Group();
  const baseMaterial = new THREE.MeshBasicMaterial();
  baseMaterial.depthWrite = false;
  baseMaterial.depthTest = false;
  baseMaterial.colorWrite = false;
  baseMaterial.stencilWrite = true;
  baseMaterial.stencilFunc = THREE.AlwaysStencilFunc;

  const backMaterial = baseMaterial.clone();
  backMaterial.side = THREE.BackSide;
  backMaterial.clippingPlanes = [cutPlane];
  backMaterial.stencilFail = THREE.IncrementWrapStencilOp;
  backMaterial.stencilZFail = THREE.IncrementWrapStencilOp;
  backMaterial.stencilZPass = THREE.IncrementWrapStencilOp;
  const backFaces = new THREE.Mesh(geometry, backMaterial);
  backFaces.renderOrder = renderOrder;
  group.add(backFaces);

  const frontMaterial = baseMaterial.clone();
  frontMaterial.side = THREE.FrontSide;
  frontMaterial.clippingPlanes = [cutPlane];
  frontMaterial.stencilFail = THREE.DecrementWrapStencilOp;
  frontMaterial.stencilZFail = THREE.DecrementWrapStencilOp;
  frontMaterial.stencilZPass = THREE.DecrementWrapStencilOp;
  const frontFaces = new THREE.Mesh(geometry, frontMaterial);
  frontFaces.renderOrder = renderOrder;
  group.add(frontFaces);
  baseMaterial.dispose();
  return group;
}

function createStencilGeometry(geometry) {
  const positionGeometry = new THREE.BufferGeometry();
  positionGeometry.setAttribute("position", geometry.getAttribute("position"));
  positionGeometry.setIndex(geometry.getIndex());
  const stencilGeometry = mergeVertices(positionGeometry);
  positionGeometry.dispose();
  return stencilGeometry;
}

function createCap(meshMaterial, renderOrder, vertexColor) {
  const capMaterial = speckleCap(fadeWithDistance(meshMaterial.clone()));
  capMaterial.clippingPlanes = [];
  capMaterial.vertexColors = false;
  capMaterial.color.multiply(vertexColor);
  if (capMaterial.emissive) {
    capMaterial.emissive.copy(capMaterial.color);
    capMaterial.emissiveIntensity = CAP_EMISSIVE_INTENSITY;
  }
  capMaterial.stencilWrite = true;
  capMaterial.stencilRef = 0;
  capMaterial.stencilFunc = THREE.NotEqualStencilFunc;
  capMaterial.stencilFail = THREE.ReplaceStencilOp;
  capMaterial.stencilZFail = THREE.ReplaceStencilOp;
  capMaterial.stencilZPass = THREE.ReplaceStencilOp;

  const cap = new THREE.Mesh(capGeometry, capMaterial);
  cap.layers.enable(1);
  cap.renderOrder = renderOrder;
  cap.onBeforeRender = () => {
    chipUniforms.capToModel.value.copy(modelOrientation.matrixWorld).invert();
  };
  cap.onAfterRender = (activeRenderer) => activeRenderer.clearStencil();
  capGroup.add(cap);
}

function loadModel(gltf) {
  const source = gltf.scene;
  source.updateMatrixWorld(true);
  const bounds = new THREE.Box3().setFromObject(source);
  const center = bounds.getCenter(new THREE.Vector3());
  modelBounds.copy(bounds);
  modelBounds.min.sub(center);
  modelBounds.max.sub(center);
  const size = bounds.getSize(new THREE.Vector3());
  const maxDimension = Math.max(size.x, size.y, size.z);
  if (!Number.isFinite(maxDimension) || maxDimension <= 0) {
    throw new Error("The GLB does not contain measurable geometry.");
  }

  fitDistance = maxDimension;
  const meshes = [];
  source.traverse((object) => {
    if (object.isMesh) meshes.push(object);
  });
  if (!meshes.length) throw new Error("The GLB contains no mesh to display.");

  disposeGroupContents(modelOrientation, true);
  disposeGroupContents(capGroup, false);
  specimenPitch = 0;
  specimenYaw = 0;
  updateSpecimenRotation();
  modelOrientation.quaternion.identity();
  controls.target.set(0, 0, 0);
  camera.position.copy(viewDirection);
  const hullInput = [];

  for (const [index, mesh] of meshes.entries()) {
    const geometry = mesh.geometry.clone();
    // glTF stores Blender color layers by channel index, not by their original names.
    const attributeColor = geometry.getAttribute("Attribute") ||
      geometry.getAttribute("attribute") ||
      geometry.getAttribute("color_3") ||
      geometry.getAttribute("color_2") ||
      geometry.getAttribute("color_1") ||
      geometry.getAttribute("color");
    const vertexColor = attributeColor
      ? new THREE.Color(attributeColor.getX(0), attributeColor.getY(0), attributeColor.getZ(0))
      : new THREE.Color(1, 1, 1);
    if (attributeColor) {
      geometry.setAttribute("color", attributeColor);
    } else {
      geometry.deleteAttribute("color");
    }
    geometry.deleteAttribute("color_1");
    geometry.deleteAttribute("color_2");
    geometry.deleteAttribute("color_3");
    geometry.deleteAttribute("Attribute");
    geometry.deleteAttribute("attribute");
    const centeredTransform = new THREE.Matrix4()
      .makeTranslation(-center.x, -center.y, -center.z)
      .multiply(mesh.matrixWorld);
    geometry.applyMatrix4(centeredTransform);
    const position = geometry.getAttribute("position");
    const stride = Math.max(1, Math.ceil(position.count / 50000));
    for (let i = 0; i < position.count; i += stride) {
      hullInput.push(new THREE.Vector3().fromBufferAttribute(position, i));
    }
    const stencilGeometry = createStencilGeometry(geometry);
    const material = Array.isArray(mesh.material)
      ? mesh.material.map((item) => item.clone())
      : mesh.material.clone();
    const materialList = Array.isArray(material) ? material : [material];
    for (const item of materialList) {
      item.vertexColors = Boolean(attributeColor);
      item.clippingPlanes = [cutPlane];
      fadeWithDistance(item);
    }
    modelOrientation.add(createStencilGroup(stencilGeometry, index * 3 + 1));
    const visibleMesh = new THREE.Mesh(geometry, material);
    visibleMesh.renderOrder = index * 3 + 3;
    modelOrientation.add(visibleMesh);
    createCap(materialList[0], index * 3 + 2, vertexColor);
  }

  modelExtremePoints = hullVertices(hullInput);
  modelRadius = Math.max(...modelExtremePoints.map((point) => point.length()));
  aoPass.configuration.aoRadius = maxDimension * AO_RADIUS_RATIO;
  chipUniforms.chipCell.value = maxDimension * CHIP_CELL_RATIO;
  chipUniforms.chipTurn.value = Math.max(4, Math.round(
    (2 * Math.PI * CHIP_ARC_REFERENCE * modelRadius) / (CHIP_ARC_STRETCH * chipUniforms.chipCell.value)));
  minCameraDistance = maxDimension * 0.03;
  controls.minDistance = minCameraDistance;
  camera.position.copy(viewDirection);
  resize();
  controls.update();
  updateCutPlane();
  setStatus("");
}

const degree = Math.PI / 180;

function angleDelta(current, previous) {
  return THREE.MathUtils.euclideanModulo(current - previous + 180, 360) - 180;
}

function onDeviceOrientation(event) {
  if (!Number.isFinite(event.gamma)) return;
  if (!previousDeviceOrientation) {
    previousDeviceOrientation = { gamma: event.gamma };
    return;
  }

  const yAxisAngle = angleDelta(event.gamma, previousDeviceOrientation.gamma) *
    degree * GYROSCOPE_Y_SENSITIVITY;
  applyDragRotation(yAxisAngle, 0);
  previousDeviceOrientation.gamma = event.gamma;
}

async function enableGyroscope() {
  previousDeviceOrientation = null;
  try {
    if (typeof DeviceOrientationEvent.requestPermission === "function") {
      const permission = await DeviceOrientationEvent.requestPermission();
      if (permission !== "granted") {
        setStatus("Gyroscope permission was not granted.");
        return;
      }
    }
    window.addEventListener("deviceorientation", onDeviceOrientation, { passive: true });
    gyroscopeEnabled = true;
    gyroscopeButton.textContent = "Gyroscope on";
    gyroscopeButton.setAttribute("aria-pressed", "true");
    setStatus("");
  } catch (error) {
    console.warn("Could not enable phone gyroscope:", error);
    setStatus("Could not enable the gyroscope. Check browser permission settings.");
  }
}

async function changeModel(index, historyMode = "push", direction = 0) {
  if (modelLoading || index < 0 || index >= MODELS.length) return;
  modelLoading = true;
  setModelNavigationDisabled(true);
  const isFirstModel = currentModelIndex < 0;
  direction ||= isFirstModel ? 1 : switchDirection(index);
  // The current model drifts away and fades while the next one is fetched.
  const exit = isFirstModel
    ? null
    : slideTo(-direction * slideDistance(), 0, SLIDE_OUT_DURATION, easeInCubic);
  const request = fetchModel(index);
  setStatus("");
  if (!request.ready) setLoading(true);
  // Name and colour the page straight away so the switch feels immediate even while the GLB downloads.
  showModelIdentity(index);
  let gltf;
  try {
    gltf = await request;
  } catch (error) {
    modelRequests.delete(index);
    if (currentModelIndex >= 0) showModelIdentity(currentModelIndex);
    if (exit) slideTo(0, 1, SLIDE_IN_DURATION, easeOutCubic);
    console.error("Could not load the model:", error);
    setStatus(`Could not load ${MODELS[index].name}: ${error.message || "check that the GLB is beside index.html."}`, true);
  }
  try {
    if (!gltf) return;
    await exit;
    loadModel(gltf);
    currentModelIndex = index;
    if (isFirstModel) {
      playIntro();
    } else {
      slideOffset = direction * slideDistance();
      modelOpacity.value = 0;
      slideTo(0, 1, SLIDE_IN_DURATION, easeOutCubic);
    }
    updateModelPickerSelection();
    if (historyMode) {
      const url = new URL(window.location.href);
      url.searchParams.set("model", MODELS[index].id);
      window.history[`${historyMode}State`]({}, "", url);
    }
  } catch (error) {
    console.error("Could not display the model:", error);
    setStatus(`Could not display the model: ${error.message}`, true);
  } finally {
    setLoading(false);
    modelLoading = false;
    setModelNavigationDisabled(false);
  }
}

function stopGyroscope() {
  window.removeEventListener("deviceorientation", onDeviceOrientation);
  gyroscopeEnabled = false;
  previousDeviceOrientation = null;
  gyroscopeButton.textContent = "Gyroscope off";
  gyroscopeButton.setAttribute("aria-pressed", "false");
}

function toggleMotion() {
  motionEnabled = !motionEnabled;
  motionButton.dataset.playing = String(motionEnabled);
  motionButton.setAttribute("aria-pressed", String(motionEnabled));
  const label = motionEnabled ? "Pause rotation" : "Play rotation";
  motionButton.setAttribute("aria-label", label);
  motionButton.title = label;
}

motionButton.addEventListener("click", toggleMotion);

// Space toggles the turntable too, unless a focused control would already
// react to it (a focused button clicks on Space, which would toggle twice).
window.addEventListener("keydown", (event) => {
  if (event.key !== " " || event.repeat) return;
  const target = event.target;
  if (target instanceof HTMLElement && target.closest("button, input, select, textarea, a[href]")) return;
  event.preventDefault();
  toggleMotion();
});

gyroscopeButton.addEventListener("click", () => {
  if (gyroscopeEnabled) {
    stopGyroscope();
  } else {
    enableGyroscope();
  }
});

previousModelButton.addEventListener("click", () => {
  const index = (currentModelIndex - 1 + MODELS.length) % MODELS.length;
  changeModel(index, "push", -1);
});
nextModelButton.addEventListener("click", () => {
  const index = (currentModelIndex + 1) % MODELS.length;
  changeModel(index, "push", 1);
});
let diceTurns = 0;
randomModelButton.addEventListener("click", () => {
  diceTurns += 1;
  randomModelButton.style.setProperty("--dice-turn", `${diceTurns * 90}deg`);
  const offset = Math.floor(Math.random() * (MODELS.length - 1)) + 1;
  changeModel((currentModelIndex + offset) % MODELS.length);
});

function closeAboutOverlay() {
  aboutOverlay.hidden = true;
  aboutToggleButton.setAttribute("aria-expanded", "false");
}

aboutToggleButton.addEventListener("click", () => {
  aboutOverlay.hidden = false;
  aboutToggleButton.setAttribute("aria-expanded", "true");
  aboutOverlay.focus();
});
aboutOverlay.addEventListener("click", () => {
  closeAboutOverlay();
  aboutToggleButton.focus();
});
window.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !aboutOverlay.hidden) closeAboutOverlay();
});

window.addEventListener("resize", resize);

function modelIndexFromUrl() {
  const modelId = new URLSearchParams(window.location.search).get("model");
  const index = MODELS.findIndex((model) => model.id === modelId);
  return index >= 0
    ? index
    : Math.floor(Math.random() * MODELS.length);
}

window.addEventListener("popstate", () => {
  changeModel(modelIndexFromUrl(), false);
});

// Once the first model is on screen, fetch the others one at a time so later
// switches are instant. Neighbours of the current model come first.
async function prefetchRemainingModels() {
  const count = MODELS.length;
  const order = [];
  for (let step = 1; step <= count / 2; step++) {
    order.push((currentModelIndex + step) % count, (currentModelIndex - step + count) % count);
  }
  for (const index of new Set(order)) {
    if (modelRequests.has(index)) continue;
    await new Promise((resolve) =>
      "requestIdleCallback" in window ? requestIdleCallback(resolve) : setTimeout(resolve, 200));
    try {
      await fetchModel(index);
    } catch {
      modelRequests.delete(index);
    }
  }
}

changeModel(modelIndexFromUrl(), "replace").then(prefetchRemainingModels);

function animate() {
  requestAnimationFrame(animate);
  const now = performance.now();
  const delta = lastFrameTime ? Math.min((now - lastFrameTime) / 1000, 0.05) : 0;
  lastFrameTime = now;
  // The model behaves like a turntable. While nobody holds it, the spin relaxes
  // exponentially toward the motor speed (zero when paused), so a flick eases
  // back into the auto-rotation and pause coasts to a stop. While a finger is
  // on it the motor keeps turning underneath; the drag is added on top.
  if (activePointers.size) {
    applyDragRotation(motorVelocity() * delta, 0);
  } else {
    angularVelocity.x = relaxToward(angularVelocity.x, motorVelocity(), HORIZONTAL_INERTIA_DAMPING, delta);
    angularVelocity.y = relaxToward(angularVelocity.y, 0, VERTICAL_INERTIA_DAMPING, delta);
    if (angularVelocity.lengthSq() > 0) {
      applyDragRotation(angularVelocity.x * delta, angularVelocity.y * delta);
    }
  }
  for (const entry of [...activeTweens]) entry.step(now);
  controls.update();
  updateCutPlane();
  slideAxis.set(0, 1, 0).applyQuaternion(camera.quaternion);
  specimen.position.copy(slideAxis).multiplyScalar(slideOffset);
  composer.render();
}
resize();
animate();
