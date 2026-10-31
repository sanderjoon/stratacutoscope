import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";
import { SMAAPass } from "three/addons/postprocessing/SMAAPass.js";
import { ShaderPass } from "three/addons/postprocessing/ShaderPass.js";
import { FXAAShader } from "three/addons/shaders/FXAAShader.js";
import { N8AOPass } from "n8ao";
import { MODELS, inkColorFor } from "./models.js";
import { STONE_DEFAULTS, stoneSettings } from "./stone-presets.js";
import { createScratch } from "./scratch.js";
const CUT_ZOOM_SENSITIVITY = 1;
const AO_RADIUS_RATIO = 0.08; // of the model's largest dimension
const ZOOM_OUT_MARGIN = 1.15; // of the model's radius; lets the whole model sit inside the view
const FOG_DEPTH_RATIO = 4; // of the model's radius; how far behind the cut plane the haze is total
const INTRO_HAZE_RATIO = 0.3; // of the model's radius; fog depth at the start of the intro
const INTRO_DURATION = 2000; // ms
const SLIDE_OUT_DURATION = 180; // ms
const SLIDE_IN_DURATION = 420; // ms
const SLIDE_TRAVEL = 0.3; // of the visible half-width; the fade does the rest
// Gallery: every model at once in a grid of equal cells. The camera pulls back
// and the current model glides into its cell while the others fade in.
const GALLERY_DURATION = 1400; // ms; the cut sweeps out and back in over the same time
const GALLERY_PITCH = -Math.PI / 4; // the grid is seen from this far above
const GALLERY_CELL = 2.3; // of the common radius; horizontal spacing between model centres
const GALLERY_ROW = 2; // of the common radius; vertical spacing
const GALLERY_MARGIN = 1.15; // of the grid's half-extent; air around the grid in the view
const TAP_SLOP = 8; // px a press may move and still pick a model
const TAP_DURATION = 500; // ms
const FLICK_WINDOW = 80; // ms; a release later than this after the last move is not a flick
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
// The chips' colours and the rest of the stone's look are set per model and
// cut-face colour in stone-presets.js.
const CHIP_COLOR_COUNT = STONE_DEFAULTS.chipColors.length;
const status = document.querySelector("#status");
const motionButton = document.querySelector("#motion");
const soundButton = document.querySelector("#sound");
const gyroscopeButton = document.querySelector("#gyroscope");
const viewer = document.querySelector(".viewer");
const aboutToggleButton = document.querySelector("#about-toggle");
const aboutOverlay = document.querySelector("#about-overlay");
const modelNameLabel = document.querySelector("#model-name");
const previousModelButton = document.querySelector("#previous-model");
const galleryToggleButton = document.querySelector("#gallery-toggle");
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
  modelNameLabel.textContent = MODELS[index].name;
}
const canvas = document.querySelector("#scene");
const isTouchDevice = navigator.maxTouchPoints > 0 ||
  window.matchMedia("(pointer: coarse)").matches;
// The gyroscope is hidden for now: its rotation misbehaves and wants another look.
gyroscopeButton.hidden = true;

// The page background shows through a transparent canvas, so the per-model
// background colour is exact and unaffected by tone mapping in post-processing.
const scene = new THREE.Scene();
// Only near/far are used: fadeWithDistance() turns fog into transparency.
scene.fog = new THREE.Fog(0x000000, 1, 2);

const camera = new THREE.PerspectiveCamera(34, 1, 0.01, 200);
camera.up.set(0, 1, 0);
camera.layers.enable(1);
const renderer = new THREE.WebGLRenderer({
  canvas,
  antialias: false, // SMAA in the composer instead; MSAA is lost in render targets anyway
  alpha: true,
  stencil: true
});
// Phones have the densest screens and the weakest GPUs: 1.5x is still sharp
// there and costs 44% fewer pixels than 2x.
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, isTouchDevice ? 1.5 : 2));
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
// Phones: half the samples at half the resolution; the occlusion is soft anyway.
if (isTouchDevice) {
  aoPass.configuration.aoSamples = 8;
  aoPass.configuration.denoiseSamples = 4;
  aoPass.configuration.denoiseRadius = 8;
}
composer.addPass(aoPass);
// Fragments carry a distance-based alpha (see fadeWithDistance). The canvas is
// composited premultiplied, so the output shader multiplies colour by alpha as
// its last step, once tone mapping and the sRGB transfer are done.
const outputPass = new OutputPass();
outputPass.material.fragmentShader = outputPass.material.fragmentShader
  .replace(/}\s*$/, "gl_FragColor.rgb *= gl_FragColor.a;\n}");
composer.addPass(outputPass);
// Anti-aliasing: SMAA's three passes on desktop; on phones the single, cheaper
// FXAA pass, whose softness the dense screen hides.
const fxaaPass = isTouchDevice ? new ShaderPass(FXAAShader) : null;
composer.addPass(fxaaPass ?? new SMAAPass(1, 1));

// Distance haze in the page's background colour. Blending toward a fog colour
// would be shifted by tone mapping, so instead the fragment's alpha falls off
// between fogNear and fogFar and the CSS background shows through.
// Whole-model opacity, used by the switch transition. Shared by every material
// of the specimen; a gallery clone passes its own.
const modelOpacity = { value: 1 };
function fadeWithDistance(material, opacity = modelOpacity) {
  material.onBeforeCompile = (shader) => {
    shader.uniforms.modelOpacity = opacity;
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
// The grid is shared; the look of the stone is a uniform set per cap.
const chipUniforms = {
  capToModel: { value: new THREE.Matrix4() },
  chipCell: { value: 1 },
  chipTurn: { value: 16 } // angular cells in a full turn at the base scale
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
  const stoneUniforms = {
    chipColors: { value: Array.from({ length: CHIP_COLOR_COUNT }, () => new THREE.Color()) },
    veinColor: { value: new THREE.Color() },
    veinWave: { value: 0 },
    veinRipple: { value: 0 },
    veinRippleScale: { value: 1 },
    veinLayers: { value: 0 },
    veinAngle: { value: 0 },
    veinContrast: { value: 0 },
    chipDensity: { value: 1 },
    chipEmbed: { value: 0 },
    veinScale: { value: 1 },
    veinWidth: { value: 0 },
    veinStrength: { value: 0 },
    cloudStrength: { value: 0 },
    capEmissive: { value: 0 }
  };
  material.userData.stoneUniforms = stoneUniforms;
  const fade = material.onBeforeCompile;
  material.onBeforeCompile = (shader) => {
    fade(shader);
    Object.assign(shader.uniforms, chipUniforms, stoneUniforms);
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
        uniform vec3 chipColors[${CHIP_COLOR_COUNT}];
        uniform vec3 veinColor;
        uniform float veinWave;
        uniform float veinRipple;
        uniform float veinRippleScale;
        uniform float veinLayers;
        uniform float veinAngle;
        uniform float veinContrast;
        uniform float chipDensity;
        uniform float chipEmbed;
        uniform float veinScale;
        uniform float veinWidth;
        uniform float veinStrength;
        uniform float cloudStrength;
        uniform float capEmissive;
        vec3 hash3(vec3 p) {
          p = vec3(dot(p, vec3(127.1, 311.7, 74.7)),
                   dot(p, vec3(269.5, 183.3, 246.1)),
                   dot(p, vec3(113.5, 271.9, 124.6)));
          return fract(sin(p) * 43758.5453123);
        }
        // Value noise on a lattice that wraps along y every period cells, so
        // a pattern laid around the axis joins up: a turn of the model slides
        // it through the cut instead of reshaping it. For a pattern that need
        // not wrap, pass a period far beyond its extent.
        float noise(vec3 p, float period) {
          vec3 i = floor(p);
          vec3 f = fract(p);
          f = f * f * (3.0 - 2.0 * f);
          float y0 = mod(i.y, period);
          float y1 = mod(i.y + 1.0, period);
          return mix(
            mix(mix(hash3(vec3(i.x, y0, i.z)).x, hash3(vec3(i.x + 1.0, y0, i.z)).x, f.x),
                mix(hash3(vec3(i.x, y1, i.z)).x, hash3(vec3(i.x + 1.0, y1, i.z)).x, f.x), f.y),
            mix(mix(hash3(vec3(i.x, y0, i.z + 1.0)).x, hash3(vec3(i.x + 1.0, y0, i.z + 1.0)).x, f.x),
                mix(hash3(vec3(i.x, y1, i.z + 1.0)).x, hash3(vec3(i.x + 1.0, y1, i.z + 1.0)).x, f.x), f.y),
            f.z) * 2.0 - 1.0;
        }
        // Each octave doubles the frequency exactly, so the period stays a
        // whole number of cells and keeps wrapping.
        float fbm(vec3 p, float period, int octaves) {
          float sum = 0.0;
          float amplitude = 0.5;
          for (int i = 0; i < octaves; i++) {
            sum += amplitude * noise(p, period);
            p = p * 2.0 + 11.1;
            period *= 2.0;
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
          // A chip reaches at most 0.6 cells from its cell's centre, so only
          // the nearer neighbour on each axis can cover this point: 8 cells
          // to test, not 27.
          vec3 side = sign(u - cell - 0.5);
          for (int x = 0; x <= 1; x++)
          for (int y = 0; y <= 1; y++)
          for (int z = 0; z <= 1; z++) {
            vec3 neighbour = cell + side * vec3(x, y, z);
            vec3 key = vec3(neighbour.x, mod(neighbour.y, turn), neighbour.z);
            vec3 seed = hash3(key);
            if (seed.x > density * chipDensity) continue;
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
              vec3 colour = chipColors[int(seed.z * ${CHIP_COLOR_COUNT}.0)] * (0.8 + tone.z * 0.4);
              colour = mix(colour, resin, tone.x * chipEmbed);
              result = vec4(colour, coverage);
            }
          }
          return result;
        }`)
      .replace("#include <color_fragment>", `#include <color_fragment>
        vec3 stonePoint = (capToModel * vec4(vCapWorld, 1.0)).xyz / chipCell;
        float pixel = length(fwidth(stonePoint)) * 0.7;
        // Resin: the cap's colour, mottled, with thin veins where a noise field crosses zero.
        vec3 resin = diffuseColor.rgb;
        if (cloudStrength > 0.0) resin *= 1.0 + cloudStrength * fbm(stonePoint * veinScale * 0.5 + 5.3, 1e5, 3);
        float stoneRadius = length(stonePoint.xz);
        float stoneTurns = atan(stonePoint.z, stonePoint.x) / 6.2831853 + 0.5;
        // Veins: bands through the model, stacked along the axis and tilted
        // outward by veinAngle (veinLayers per cell), bent by a warped noise
        // (veinWave bands' worth) and by a plain sine wave along the radius
        // (veinRipple). Everything is cylindrical about the turntable axis,
        // like the chips, so a turn slides the bands through the cut. With no
        // layers only the bending is left and the bands become its contours,
        // wandering like marble. Each band's period holds one vein of
        // veinWidth, with edges as hard as veinContrast asks.
        if (veinStrength > 0.0 && veinWidth > 0.0) {
          // A whole number of noise cells per turn, so the noise wraps.
          float arcPeriod = max(1.0, floor(chipTurn * veinScale + 0.5));
          vec3 veinPoint = vec3(stoneRadius * veinScale, stoneTurns * arcPeriod, stonePoint.y * veinScale);
          float wander = 0.0;
          if (veinWave > 0.0) {
            // The warp only needs the broad strokes; the detail is in the field itself.
            vec3 warped = veinPoint + 0.9 * vec3(
              fbm(veinPoint + vec3(3.1, 0.0, 15.9), arcPeriod, 2),
              0.0,
              fbm(veinPoint + vec3(9.7, 0.0, 27.3), arcPeriod, 2));
            wander = fbm(warped, arcPeriod, 4);
          }
          float band = (stonePoint.y * cos(veinAngle) + stoneRadius * sin(veinAngle)) * veinLayers
            + veinWave * wander
            + veinRipple * sin(stoneRadius * veinRippleScale * 6.2831853)
            + 0.5; // so an unbent band's vein sits where the noise crosses zero
          float offCentre = abs(fract(band) - 0.5);
          float halfWidth = veinWidth * 0.5;
          // The edge softens in proportion to the width, so a thin vein still
          // reaches its full colour at its centre.
          float edge = halfWidth * mix(1.0, 0.03, veinContrast);
          float vein = 1.0 - smoothstep(halfWidth - edge, halfWidth + edge, offCentre);
          resin = mix(resin, veinColor, vein * veinStrength);
        }
        vec3 stone = resin;
        if (chipDensity > 0.0) {
          vec4 chip;
          float turn;${chipLayersGlsl}
        }
        diffuseColor.rgb = stone;`)
      .replace("#include <emissivemap_fragment>", `#include <emissivemap_fragment>
        totalEmissiveRadiance = stone * capEmissive;`);
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
// Model switch: the specimen's sideways offset on screen (positive = right).
let slideOffset = 0;
let slideTween = null;
const slideAxis = new THREE.Vector3();
// Gallery: the current model is the specimen itself, moved to its cell and
// scaled to the common size; the others are uncut clones, one group each.
let galleryActive = false;
let galleryTween = null;
let galleryModels = [];
let galleryRadius = 0; // the common radius every model is scaled to
let galleryDistance = 0; // camera distance at which the whole grid is in view
let galleryBlend = 0; // 0: haze as in the single view, 1: lifted clear of the grid
const gallerySlots = []; // cell centres, by model index
const galleryItems = new Map(); // clones by model index
const galleryGroup = new THREE.Group();
scene.add(galleryGroup);
// The clones fade by alpha but still write depth, which would punch holes in
// the specimen wherever one lies in front of it on its way to or from its
// cell. So the clones are drawn first, then the depth buffer is cleared (by
// this empty draw) and the specimen goes on top of them.
const GALLERY_CLONE_ORDER = -2;
const galleryDepthClear = new THREE.Mesh(
  new THREE.PlaneGeometry(1, 1),
  new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false, depthTest: false })
);
galleryDepthClear.renderOrder = GALLERY_CLONE_ORDER + 1;
galleryDepthClear.frustumCulled = false;
galleryDepthClear.visible = false;
galleryDepthClear.onBeforeRender = (activeRenderer) => activeRenderer.clearDepth();
galleryGroup.add(galleryDepthClear);
const galleryOffset = new THREE.Vector3(); // the specimen's shift toward its cell
let galleryScale = 1;
// The cut plane's shift toward the camera beyond what the zoom sets, so the
// gallery transition can sweep the cut on its own clock.
let cutRetreat = 0;
// The view left behind on entering the gallery; coming back to the same model restores it.
let galleryReturn = null;
let pendingGalleryIndex = -1; // a model tapped before the grid had spread
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
// Parsed models are kept, so a switch only assembles meshes.
const modelRequests = new Map();

function fetchModel(index) {
  if (!modelRequests.has(index)) {
    const request = modelLoader.loadAsync(MODELS[index].url).then(prepareModel);
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
  previousModelButton.disabled = disabled;
  galleryToggleButton.disabled = disabled;
  nextModelButton.disabled = disabled;
}

// Geometry is left alone: it belongs to the prepared model, kept for the next visit.
function disposeGroupContents(group) {
  const materials = new Set();
  const textures = new Set();
  group.traverse((object) => {
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
  for (const material of materials) material.dispose();
  for (const texture of textures) texture.dispose();
}

function resize() {
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  if (!width || !height) return;
  renderer.setSize(width, height, false);
  composer.setSize(width, height);
  if (fxaaPass) {
    const pixelRatio = renderer.getPixelRatio();
    fxaaPass.material.uniforms.resolution.value.set(1 / (width * pixelRatio), 1 / (height * pixelRatio));
  }
  camera.aspect = width / height;
  camera.updateProjectionMatrix();
  if (modelBounds.isEmpty() === false) {
    fitCameraToModel();
    if (galleryActive) {
      layoutGallery();
      if (!galleryTween) applyGalleryState(galleryView(), galleryView(), 1);
    }
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

// Zooming moves the cut plane through the model, so limit the zoom range to
// where the plane is useful: zoomed in until the plane passes the far side of
// the model (nothing left), zoomed out until it clears the near side (whole
// model visible). Both depend on the model's current rotation.
// The zoom range is fixed per model so rotating never shifts the camera.
function limitZoomToModel() {
  if (modelBounds.isEmpty()) return;
  if (galleryActive) {
    // The gallery transition drives the camera; nothing may clamp it back.
    controls.minDistance = minCameraDistance;
    controls.maxDistance = Infinity;
    return;
  }
  controls.minDistance = Math.max(
    minCameraDistance,
    fitCameraDistance - modelRadius / CUT_ZOOM_SENSITIVITY
  );
  controls.maxDistance = fitCameraDistance + (modelRadius * ZOOM_OUT_MARGIN) / CUT_ZOOM_SENSITIVITY;
}

// The cut plane always sits fitCameraDistance from the camera (zoom and cut
// move together), so the haze starts exactly at the cut and deepens behind it.
// In the gallery the haze is lifted clear of the grid.
function updateDistanceFade() {
  const near = fitCameraDistance;
  const far = near + modelRadius * THREE.MathUtils.lerp(FOG_DEPTH_RATIO, INTRO_HAZE_RATIO, introHaze);
  scene.fog.near = THREE.MathUtils.lerp(near, galleryDistance * 2, galleryBlend);
  scene.fog.far = THREE.MathUtils.lerp(far, galleryDistance * 4, galleryBlend);
}

// Frame-driven tweens. update() receives eased progress 0..1 and is called once
// synchronously; the promise resolves true on completion, false if cancelled.
const activeTweens = new Set();
const easeOutCubic = (t) => 1 - (1 - t) ** 3;
const easeInCubic = (t) => t * t * t;
const easeInOutCubic = (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);
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

// Sideways travel of the switch transition: a short drift, with the fade
// doing most of the work, so the change feels quick.
function slideDistance() {
  const halfWidth = camera.position.distanceTo(controls.target) *
    Math.tan(THREE.MathUtils.degToRad(camera.fov * 0.5)) * camera.aspect;
  return halfWidth * SLIDE_TRAVEL;
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

// +1 when the new model comes after the current one (it enters from the
// right, as Next points), -1 when it comes before. Picked by the shorter way
// round the list.
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
  const cutDistance = -zoomInDistance * CUT_ZOOM_SENSITIVITY + cutRetreat;
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

// The gallery is seen from a fixed height, so only the turn responds there.
function applyDragRotation(horizontalAngle, verticalAngle) {
  specimenYaw -= horizontalAngle;
  if (!galleryActive) specimenPitch -= verticalAngle;
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
  activePointers.set(event.pointerId, {
    x: event.clientX,
    y: event.clientY,
    startX: event.clientX,
    startY: event.clientY,
    time: event.timeStamp
  });
  if (activePointers.size === 1) {
    previousPointerTime = event.timeStamp;
  } else {
    angularVelocity.set(motorVelocity(), 0);
  }
});

canvas.addEventListener("pointermove", (event) => {
  const previous = activePointers.get(event.pointerId);
  // A mouse released outside the window sends no pointerup; it comes back
  // with no button down, which ends the drag.
  if (previous && event.pointerType === "mouse" && event.buttons === 0) {
    finishPointer(event);
    return;
  }
  if (!previous) {
    if (galleryActive && !galleryTween && !activePointers.size) {
      const cursor = galleryIndexAt(event.clientX, event.clientY) >= 0 ? "pointer" : "";
      if (canvas.style.cursor !== cursor) canvas.style.cursor = cursor;
    }
    return;
  }
  const deltaX = event.clientX - previous.x;
  const deltaY = event.clientY - previous.y;
  previous.x = event.clientX;
  previous.y = event.clientY;
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
  const pointer = activePointers.get(event.pointerId);
  activePointers.delete(event.pointerId);
  // The spin set by the last move carries on as a flick only if the release
  // follows it closely; a finger that stopped first, or a release that only
  // reaches us late, leaves the motor speed.
  if (activePointers.size || event.timeStamp - previousPointerTime > FLICK_WINDOW) {
    angularVelocity.set(motorVelocity(), 0);
  }
  if (activePointers.size) return;
  // A short press that did not drag picks a model from the gallery.
  const isTap = event.type === "pointerup" && pointer &&
    Math.hypot(event.clientX - pointer.startX, event.clientY - pointer.startY) < TAP_SLOP &&
    event.timeStamp - pointer.time < TAP_DURATION;
  if (isTap && galleryActive) {
    const index = galleryIndexAt(event.clientX, event.clientY);
    if (index < 0) return;
    // A tap while the grid is still spreading is kept for when it has.
    if (galleryTween) {
      pendingGalleryIndex = index;
    } else {
      selectFromGallery(index);
    }
  }
};
canvas.addEventListener("pointerup", finishPointer);
canvas.addEventListener("pointercancel", finishPointer);
canvas.addEventListener("lostpointercapture", finishPointer);
// Leaving the window mid-drag can swallow the release too.
window.addEventListener("blur", () => {
  activePointers.clear();
  angularVelocity.set(motorVelocity(), 0);
});

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

// Caps of the current model with their stone settings, one settings object
// per cut-face colour, so the tweak pane can drive them live.
let capEntries = [];
// Stone tuning pane, shown whenever ?tweak is in the URL; its module is only
// loaded then.
let stoneTweaks = null;
if (new URLSearchParams(window.location.search).has("tweak")) {
  import("./tweak.js").then(({ createStoneTweaks }) => {
    stoneTweaks = createStoneTweaks((entry) => {
      for (const material of entry.materials) applyStoneSettings(material, entry.settings);
    });
    if (currentModelIndex >= 0) stoneTweaks.show(MODELS[currentModelIndex], capEntries);
    stoneTweaks.setVisible(true);
  });
}

function applyStoneSettings(material, settings) {
  material.roughness = settings.roughness;
  material.metalness = settings.metalness;
  const uniforms = material.userData.stoneUniforms;
  settings.chipColors.forEach((hex, index) => uniforms.chipColors.value[index].set(hex));
  uniforms.veinColor.value.set(settings.veinColor);
  uniforms.veinWave.value = settings.veinWave;
  uniforms.veinRipple.value = settings.veinRipple;
  uniforms.veinRippleScale.value = settings.veinRippleScale;
  uniforms.veinLayers.value = settings.veinLayers;
  uniforms.veinAngle.value = THREE.MathUtils.degToRad(settings.veinAngle);
  uniforms.veinContrast.value = settings.veinContrast;
  uniforms.chipDensity.value = settings.chipDensity;
  uniforms.chipEmbed.value = settings.chipEmbed;
  uniforms.veinScale.value = settings.veinScale;
  uniforms.veinWidth.value = settings.veinWidth;
  uniforms.veinStrength.value = settings.veinStrength;
  uniforms.cloudStrength.value = settings.cloudStrength;
  uniforms.capEmissive.value = settings.emissive;
}

function createCap(meshMaterial, renderOrder, vertexColor, modelId) {
  const capMaterial = speckleCap(fadeWithDistance(meshMaterial.clone()));
  capMaterial.clippingPlanes = [];
  capMaterial.vertexColors = false;
  capMaterial.color.multiply(vertexColor);
  const hex = `#${vertexColor.getHexString()}`;
  let entry = capEntries.find((candidate) => candidate.hex === hex);
  if (!entry) {
    entry = {
      hex,
      materials: [],
      settings: stoneSettings(modelId, hex, meshMaterial),
      // What the settings fall back to, so the tweak pane can list only the changes.
      base: stoneSettings(null, hex, meshMaterial)
    };
    capEntries.push(entry);
  }
  entry.materials.push(capMaterial);
  applyStoneSettings(capMaterial, entry.settings);
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

const nextIdle = () => new Promise((resolve) =>
  "requestIdleCallback" in window ? requestIdleCallback(resolve) : setTimeout(resolve, 0));

// The GLBs come prepared by scripts/prepare-models.mjs: centred, with one
// colour layer, a welded stencil index under any mesh that needs one (a child
// node flagged in its extras), and the framing numbers in the scene's extras.
// Here they are only read back.
function prepareModel(gltf) {
  const metrics = gltf.scene.userData.stratacutoscope;
  if (!metrics) throw new Error("The GLB has not been prepared; run `yarn prepare-models`.");
  const parts = [];
  gltf.scene.traverse((object) => {
    if (!object.isMesh) return;
    if (object.userData.stratacutoscope === "stencil") {
      const part = parts.find((candidate) => candidate.mesh === object.parent);
      if (part) part.stencilGeometry = object.geometry;
      return;
    }
    const attributeColor = object.geometry.getAttribute("color");
    parts.push({
      mesh: object,
      geometry: object.geometry,
      // A mesh without duplicated vertices is its own closed surface.
      stencilGeometry: object.geometry,
      material: object.material,
      hasVertexColors: Boolean(attributeColor),
      vertexColor: attributeColor
        ? new THREE.Color(attributeColor.getX(0), attributeColor.getY(0), attributeColor.getZ(0))
        : new THREE.Color(1, 1, 1)
    });
  });
  if (!parts.length) throw new Error("The GLB contains no mesh to display.");
  const extremePoints = [];
  for (let i = 0; i < metrics.extremePoints.length; i += 3) {
    extremePoints.push(new THREE.Vector3().fromArray(metrics.extremePoints, i));
  }
  return {
    bounds: new THREE.Box3(
      new THREE.Vector3().fromArray(metrics.bounds.min),
      new THREE.Vector3().fromArray(metrics.bounds.max)
    ),
    maxDimension: metrics.maxDimension,
    parts,
    extremePoints,
    radius: metrics.radius
  };
}

function loadModel(model, modelId) {
  modelBounds.copy(model.bounds);
  const maxDimension = model.maxDimension;
  fitDistance = maxDimension;

  disposeGroupContents(modelOrientation);
  disposeGroupContents(capGroup);
  capEntries = [];
  specimenPitch = 0;
  specimenYaw = 0;
  updateSpecimenRotation();
  modelOrientation.quaternion.identity();
  controls.target.set(0, 0, 0);
  camera.position.copy(viewDirection);

  for (const [index, part] of model.parts.entries()) {
    const material = Array.isArray(part.material)
      ? part.material.map((item) => item.clone())
      : part.material.clone();
    const materialList = Array.isArray(material) ? material : [material];
    for (const item of materialList) {
      item.vertexColors = part.hasVertexColors;
      item.clippingPlanes = [cutPlane];
      fadeWithDistance(item);
    }
    modelOrientation.add(createStencilGroup(part.stencilGeometry, index * 3 + 1));
    const visibleMesh = new THREE.Mesh(part.geometry, material);
    visibleMesh.renderOrder = index * 3 + 3;
    modelOrientation.add(visibleMesh);
    createCap(materialList[0], index * 3 + 2, part.vertexColor, modelId);
  }

  modelExtremePoints = model.extremePoints;
  modelRadius = model.radius;
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

function rememberModelInUrl(index, historyMode) {
  if (!historyMode) return;
  const url = new URL(window.location.href);
  url.searchParams.set("model", MODELS[index].id);
  window.history[`${historyMode}State`]({}, "", url);
}

// Gallery. The grid lies in the plane through the target, facing the camera.
// Cells are one common size so every model shows at the same size; the last
// row is centred.
function layoutGallery() {
  const count = MODELS.length;
  const columns = THREE.MathUtils.clamp(Math.round(Math.sqrt(count * camera.aspect)), 1, count);
  const rows = Math.ceil(count / columns);
  const cell = GALLERY_CELL * galleryRadius;
  const rowHeight = GALLERY_ROW * galleryRadius;
  const right = new THREE.Vector3(1, 0, 0).applyQuaternion(camera.quaternion);
  const up = new THREE.Vector3(0, 1, 0).applyQuaternion(camera.quaternion);
  for (let index = 0; index < count; index++) {
    const row = Math.floor(index / columns);
    const inRow = Math.min(columns, count - row * columns);
    const column = index - row * columns;
    gallerySlots[index] = (gallerySlots[index] ?? new THREE.Vector3())
      .copy(right).multiplyScalar((column - (inRow - 1) / 2) * cell)
      .addScaledVector(up, ((rows - 1) / 2 - row) * rowHeight);
  }
  const verticalTangent = Math.tan(THREE.MathUtils.degToRad(camera.fov * 0.5));
  const horizontalTangent = verticalTangent * camera.aspect;
  galleryDistance = Math.max(
    (columns * cell) / 2 / horizontalTangent,
    (rows * rowHeight) / 2 / verticalTangent
  ) * GALLERY_MARGIN + galleryRadius;
  // Never closer than where the current model is clear of the cut.
  galleryDistance = Math.max(galleryDistance, uncutDistance() * 1.05);
  for (const [index, item] of galleryItems) item.group.position.copy(gallerySlots[index]);
}

// Zoomed out to here, the cut plane clears the whole model.
function uncutDistance() {
  return fitCameraDistance + modelRadius * ZOOM_OUT_MARGIN;
}

function cameraDistance() {
  return camera.position.distanceTo(controls.target);
}

function setCameraDistance(distance) {
  cameraDirection.copy(camera.position).sub(controls.target).normalize();
  camera.position.copy(controls.target).addScaledVector(cameraDirection, distance);
}

// One end of the gallery transition: where the camera is, how far the
// specimen is tilted, where the cut plane sits (from the model's centre, in
// radii, toward the camera) and how far the grid is spread (0: single view).
function galleryView() {
  return { distance: galleryDistance, pitch: GALLERY_PITCH, cut: ZOOM_OUT_MARGIN, spread: 1 };
}

function singleView(distance, pitch) {
  return { distance, pitch, cut: (distance - fitCameraDistance) / modelRadius, spread: 0 };
}

// Everything moves together on one clock: the camera, the tilt, the grid's
// spread (the specimen gliding to its cell and shrinking to the common size,
// the clones fading in at theirs, the haze lifting) and the cut, which sweeps
// out through the model as it goes and back in as it returns.
function applyGalleryState(from, to, progress) {
  const distance = THREE.MathUtils.lerp(from.distance, to.distance, progress);
  const spread = THREE.MathUtils.lerp(from.spread, to.spread, progress);
  specimenPitch = THREE.MathUtils.lerp(from.pitch, to.pitch, progress);
  updateSpecimenRotation();
  galleryBlend = spread;
  // As seen from the camera, the specimen glides straight to its place and
  // grows evenly, however far the camera has come: its offset and size are
  // eased between the two views in screen terms, then scaled by the distance.
  const seen = (view) => ({
    offset: view.spread / view.distance,
    size: THREE.MathUtils.lerp(1, galleryRadius / modelRadius, view.spread) / view.distance
  });
  const a = seen(from);
  const b = seen(to);
  galleryOffset.copy(gallerySlots[currentModelIndex])
    .multiplyScalar(THREE.MathUtils.lerp(a.offset, b.offset, progress) * distance);
  galleryScale = THREE.MathUtils.lerp(a.size, b.size, progress) * distance;
  // The clones stay put while the camera closes in and would loom over the
  // view, so they are gone before the camera is half-way there.
  const fade = THREE.MathUtils.smoothstep(spread, 0.5, 1);
  for (const item of galleryItems.values()) item.opacity.value = fade;
  setCameraDistance(distance);
  const cut = THREE.MathUtils.lerp(from.cut, to.cut, progress) * modelRadius * galleryScale;
  cutRetreat = cut - (distance - fitCameraDistance) * CUT_ZOOM_SENSITIVITY;
  updateDistanceFade();
}

// The model under a point on the screen: its cell in the grid's plane, as
// seen from the gallery's resting camera even while the camera is on its way.
const galleryRaycaster = new THREE.Raycaster();
const galleryPointer = new THREE.Vector2();
const galleryPlane = new THREE.Plane();
const galleryHit = new THREE.Vector3();
const galleryCameraPosition = new THREE.Vector3();
function galleryIndexAt(clientX, clientY) {
  const rect = canvas.getBoundingClientRect();
  galleryPointer.set(
    ((clientX - rect.left) / rect.width) * 2 - 1,
    -((clientY - rect.top) / rect.height) * 2 + 1
  );
  galleryCameraPosition.copy(camera.position);
  setCameraDistance(galleryDistance);
  camera.updateMatrixWorld();
  galleryRaycaster.setFromCamera(galleryPointer, camera);
  camera.position.copy(galleryCameraPosition);
  camera.updateMatrixWorld();
  cameraDirection.copy(camera.position).sub(controls.target).normalize();
  galleryPlane.setFromNormalAndCoplanarPoint(cameraDirection, controls.target);
  if (!galleryRaycaster.ray.intersectPlane(galleryPlane, galleryHit)) return -1;
  const right = new THREE.Vector3(1, 0, 0).applyQuaternion(camera.quaternion);
  const up = new THREE.Vector3(0, 1, 0).applyQuaternion(camera.quaternion);
  const offset = new THREE.Vector3();
  return gallerySlots.findIndex((slot) => {
    offset.copy(galleryHit).sub(slot);
    return Math.abs(offset.dot(right)) < GALLERY_CELL * galleryRadius * 0.5 &&
      Math.abs(offset.dot(up)) < GALLERY_ROW * galleryRadius * 0.5;
  });
}

// An uncut copy of a model in its cell, sharing the prepared geometry. The
// spinner follows the specimen's turn, so a drag spins the whole grid.
function createGalleryItem(index) {
  const model = galleryModels[index];
  const opacity = { value: 0 };
  const group = new THREE.Group();
  const spinner = new THREE.Group();
  group.add(spinner);
  for (const part of model.parts) {
    const material = Array.isArray(part.material)
      ? part.material.map((item) => item.clone())
      : part.material.clone();
    for (const item of Array.isArray(material) ? material : [material]) {
      item.vertexColors = part.hasVertexColors;
      fadeWithDistance(item, opacity);
    }
    const mesh = new THREE.Mesh(part.geometry, material);
    mesh.renderOrder = GALLERY_CLONE_ORDER;
    spinner.add(mesh);
  }
  group.position.copy(gallerySlots[index]);
  group.scale.setScalar(galleryRadius / model.radius);
  galleryGroup.add(group);
  galleryItems.set(index, { group, spinner, opacity });
}

function removeGalleryItem(index) {
  const item = galleryItems.get(index);
  if (!item) return;
  galleryItems.delete(index);
  galleryGroup.remove(item.group);
  item.group.traverse((object) => {
    if (!object.material) return;
    for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
      material.dispose();
    }
  });
}

// to is read every frame, so a resize mid-way lands where the grid now is.
function galleryTransition(from, to) {
  galleryTween = tween(GALLERY_DURATION, easeInOutCubic, (progress) => {
    applyGalleryState(from, to(), progress);
  });
  return galleryTween;
}

async function openGallery() {
  if (galleryActive || galleryTween || modelLoading || currentModelIndex < 0) return;
  endIntro();
  modelLoading = true;
  setModelNavigationDisabled(true);
  let models;
  try {
    const requests = MODELS.map((_, index) => fetchModel(index));
    if (!requests.every((request) => request.ready)) setLoading(true);
    models = await Promise.all(requests);
  } catch (error) {
    for (const [index, request] of modelRequests) {
      if (!request.ready) modelRequests.delete(index);
    }
    console.error("Could not load every model:", error);
    setStatus(`Could not load every model: ${error.message}`, true);
  } finally {
    setLoading(false);
    modelLoading = false;
    setModelNavigationDisabled(false);
  }
  if (!models) return;
  galleryModels = models;
  galleryRadius = Math.max(...models.map((model) => model.radius));
  galleryReturn = { index: currentModelIndex, distance: cameraDistance(), pitch: specimenPitch };
  galleryActive = true;
  galleryDepthClear.visible = true;
  viewer.dataset.gallery = "true";
  galleryToggleButton.setAttribute("aria-pressed", "true");
  controls.enableZoom = false;
  limitZoomToModel();
  layoutGallery();
  for (let index = 0; index < MODELS.length; index++) {
    if (index !== currentModelIndex) createGalleryItem(index);
  }
  await galleryTransition(singleView(galleryReturn.distance, galleryReturn.pitch), galleryView);
  galleryTween = null;
  if (pendingGalleryIndex >= 0) {
    const index = pendingGalleryIndex;
    pendingGalleryIndex = -1;
    selectFromGallery(index);
  }
}

// Back to the single view of the current model, the cut sweeping in: the view
// left on entering if it is the same model, otherwise cut through the middle
// and seen from the side.
async function closeGallery() {
  if (!galleryActive || galleryTween) return;
  pendingGalleryIndex = -1;
  viewer.dataset.gallery = "false";
  const to = galleryReturn.index === currentModelIndex
    ? singleView(galleryReturn.distance, galleryReturn.pitch)
    : singleView(fitCameraDistance, 0);
  await galleryTransition(galleryView(), () => to);
  galleryTween = null;
  cutRetreat = 0;
  galleryActive = false;
  galleryDepthClear.visible = false;
  galleryToggleButton.setAttribute("aria-pressed", "false");
  for (const index of [...galleryItems.keys()]) removeGalleryItem(index);
  galleryBlend = 0;
  galleryOffset.set(0, 0, 0);
  galleryScale = 1;
  canvas.style.cursor = "";
  controls.enableZoom = true;
  limitZoomToModel();
  updateDistanceFade();
}

// Picks a model from the grid. Its clone is swapped for the real thing in the
// same cell (and the old model for a clone), which the zoom then closes in on.
async function selectFromGallery(index, historyMode = "push") {
  if (!galleryActive || galleryTween || modelLoading) return;
  if (index !== currentModelIndex) {
    const previous = currentModelIndex;
    const yaw = specimenYaw;
    removeGalleryItem(index);
    currentModelIndex = index;
    loadModel(galleryModels[index], MODELS[index].id);
    specimenYaw = yaw;
    createGalleryItem(previous);
    applyGalleryState(galleryView(), galleryView(), 1);
    showModelIdentity(index);
    stoneTweaks?.show(MODELS[index], capEntries);
    rememberModelInUrl(index, historyMode);
  }
  await closeGallery();
}

async function changeModel(index, historyMode = "push", direction = 0) {
  if (galleryActive) return selectFromGallery(index, historyMode);
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
  let model;
  try {
    model = await request;
  } catch (error) {
    modelRequests.delete(index);
    if (currentModelIndex >= 0) showModelIdentity(currentModelIndex);
    if (exit) slideTo(0, 1, SLIDE_IN_DURATION, easeOutCubic);
    console.error("Could not load the model:", error);
    setStatus(`Could not load ${MODELS[index].name}: ${error.message || "check that the GLB is beside index.html."}`, true);
  }
  try {
    if (!model) return;
    await exit;
    loadModel(model, MODELS[index].id);
    currentModelIndex = index;
    stoneTweaks?.show(MODELS[index], capEntries);
    if (isFirstModel) {
      playIntro();
    } else {
      slideOffset = direction * slideDistance();
      modelOpacity.value = 0;
      slideTo(0, 1, SLIDE_IN_DURATION, easeOutCubic);
    }
    rememberModelInUrl(index, historyMode);
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

// Turntable sound. The record plays at the specimen's spin: the motor speed
// is normal playback, a drag scratches, pause lets it wind down.
const SCRATCH_TRACK = "./assets/audio/moulinet.m4a";
const SOUND_TIP_DURATION = 3000; // ms
const soundTip = document.querySelector("#sound-tip");
let scratch = null;
let soundOn = false;
let previousYaw = null;
let soundTipTimer = null;

// The track loads once the first model is up, without holding the page: the
// speaker spins meanwhile, then settles as muted and points itself out.
async function preloadSound() {
  scratch ??= createScratch(SCRATCH_TRACK);
  try {
    await scratch.preload();
  } catch (error) {
    console.warn("Could not load the sound:", error);
    soundButton.hidden = true;
    return;
  }
  soundButton.dataset.loading = "false";
  soundButton.removeAttribute("aria-busy");
  soundButton.disabled = false;
  soundTip.dataset.visible = "true";
  soundTipTimer = setTimeout(hideSoundTip, SOUND_TIP_DURATION);
}

function hideSoundTip() {
  clearTimeout(soundTipTimer);
  soundTip.dataset.visible = "false";
}
soundButton.addEventListener("click", async () => {
  hideSoundTip();
  soundOn = !soundOn;
  soundButton.dataset.sound = String(soundOn);
  soundButton.setAttribute("aria-pressed", String(soundOn));
  const label = soundOn ? "Turn sound off" : "Turn sound on";
  soundButton.setAttribute("aria-label", label);
  soundButton.title = label;
  if (!soundOn) {
    scratch?.stop();
    return;
  }
  try {
    scratch ??= createScratch(SCRATCH_TRACK);
    await scratch.start();
  } catch (error) {
    console.error("Could not start the sound:", error);
    setStatus(`Could not start the sound: ${error.message}`, true);
    soundOn = false;
    soundButton.dataset.sound = "false";
    soundButton.setAttribute("aria-pressed", "false");
  }
});

// The spin this frame, as a multiple of the motor speed; 0 across a model
// change, where the yaw is reset.
function playbackSpeed(delta) {
  const yaw = specimenYaw;
  const change = previousYaw === null ? 0 : yaw - previousYaw;
  previousYaw = yaw;
  if (!delta || Math.abs(change) > Math.PI) return 0;
  return change / delta / AUTO_ROTATION_SPEED;
}

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
galleryToggleButton.addEventListener("click", () => {
  if (galleryActive) {
    closeGallery();
  } else {
    openGallery();
  }
});

function closeAboutOverlay() {
  aboutOverlay.hidden = true;
  viewer.dataset.help = "false";
  aboutToggleButton.setAttribute("aria-expanded", "false");
  aboutToggleButton.setAttribute("aria-label", "About this project");
}

function openAboutOverlay() {
  aboutOverlay.hidden = false;
  viewer.dataset.help = "true";
  aboutToggleButton.setAttribute("aria-expanded", "true");
  aboutToggleButton.setAttribute("aria-label", "Close");
  aboutOverlay.focus();
}

aboutToggleButton.addEventListener("click", () => {
  if (aboutOverlay.hidden) {
    openAboutOverlay();
  } else {
    closeAboutOverlay();
  }
});
aboutOverlay.addEventListener("click", () => {
  closeAboutOverlay();
  aboutToggleButton.focus();
});
window.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  if (!aboutOverlay.hidden) {
    closeAboutOverlay();
  } else if (galleryActive) {
    closeGallery();
  }
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
    await nextIdle();
    try {
      await fetchModel(index);
    } catch {
      modelRequests.delete(index);
    }
  }
}

changeModel(modelIndexFromUrl(), "replace").then(() => {
  preloadSound();
  return prefetchRemainingModels();
});

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
  if (soundOn) scratch.setSpeed(playbackSpeed(delta));
  controls.update();
  updateCutPlane();
  slideAxis.set(1, 0, 0).applyQuaternion(camera.quaternion);
  specimen.position.copy(slideAxis).multiplyScalar(slideOffset).add(galleryOffset);
  specimen.scale.setScalar(galleryScale);
  for (const item of galleryItems.values()) item.spinner.quaternion.copy(specimen.quaternion);
  composer.render();
}
resize();
animate();
