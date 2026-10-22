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
const AUTO_ROTATION_SPEED = 0.65; // rad/s, the turntable's motor speed
const DRAG_ROTATION_SENSITIVITY = 0.008;
const VERTICAL_DRAG_ROTATION_SENSITIVITY = 0.002;
const GYROSCOPE_Y_SENSITIVITY = 10;
// Rates (1/s) at which the free-spinning velocity relaxes toward the motor
// speed. They shape drag inertia and play/pause spin-up/coast-down alike.
const HORIZONTAL_INERTIA_DAMPING = 1.1;
const VERTICAL_INERTIA_DAMPING = 4;
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
function fadeWithDistance(material) {
  material.onBeforeCompile = (shader) => {
    shader.fragmentShader = shader.fragmentShader.replace(
      "#include <fog_fragment>",
      "#ifdef USE_FOG\n  gl_FragColor.a *= 1.0 - smoothstep(fogNear, fogFar, vFogDepth);\n#endif"
    );
  };
  material.customProgramCacheKey = () => "fade-with-distance";
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
let previousTwoFingerCenter = null;
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
let currentModelIndex = -1;
let modelLoading = false;
let motionEnabled = true;
let previousDeviceOrientation = null;
let gyroscopeEnabled = false;
let lastFrameTime = 0;
const viewDirection = new THREE.Vector3(1, 0, 0);
const cameraDirection = new THREE.Vector3();
const panOffset = new THREE.Vector3();
const panRight = new THREE.Vector3();
const panUp = new THREE.Vector3();
const cutPoint = new THREE.Vector3();
const cutPlane = new THREE.Plane();
const planeNormal = new THREE.Vector3(0, 0, 1);
const capGeometry = new THREE.PlaneGeometry(1, 1);
const cameraDirectionForFit = new THREE.Vector3();
let previousPointerTime = 0;
const modelLoader = new GLTFLoader();
// Parsed GLBs are kept so switching back to a model needs no network or parse work.
const modelRequests = new Map();

function fetchModel(index, onProgress) {
  if (!modelRequests.has(index)) {
    const request = modelLoader.loadAsync(MODELS[index].url, (event) => {
      request.progress = event.total ? event.loaded / event.total : 0;
      request.onProgress?.(request.progress);
    });
    request.progress = 0;
    request.then(() => { request.ready = true; });
    modelRequests.set(index, request);
  }
  const request = modelRequests.get(index);
  request.onProgress = onProgress;
  return request;
}

function setStatus(message, isError = false) {
  status.textContent = message;
  status.dataset.error = String(isError);
  status.hidden = !message;
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
  modelPickerToggle.textContent = MODELS[currentModelIndex].name;
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
  scene.fog.far = fitCameraDistance + modelRadius * FOG_DEPTH_RATIO;
}

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

canvas.addEventListener("touchstart", (event) => {
  previousTwoFingerCenter = event.touches.length === 2
    ? {
        x: (event.touches[0].clientX + event.touches[1].clientX) * 0.5,
        y: (event.touches[0].clientY + event.touches[1].clientY) * 0.5
      }
    : null;
}, { passive: true });

canvas.addEventListener("touchmove", (event) => {
  if (event.touches.length === 2) {
    const center = {
      x: (event.touches[0].clientX + event.touches[1].clientX) * 0.5,
      y: (event.touches[0].clientY + event.touches[1].clientY) * 0.5
    };
    if (previousTwoFingerCenter && canvas.clientHeight > 0) {
      const unitsPerPixel = 2 * camera.position.distanceTo(controls.target) *
        Math.tan(THREE.MathUtils.degToRad(camera.fov * 0.5)) / canvas.clientHeight;
      panRight.set(1, 0, 0).applyQuaternion(camera.quaternion);
      panUp.set(0, 1, 0).applyQuaternion(camera.quaternion);
      panOffset.copy(panRight).multiplyScalar(
        -(center.x - previousTwoFingerCenter.x) * unitsPerPixel
      ).addScaledVector(panUp, (center.y - previousTwoFingerCenter.y) * unitsPerPixel);
      camera.position.add(panOffset);
      controls.target.add(panOffset);
    }
    previousTwoFingerCenter = center;
  } else {
    previousTwoFingerCenter = null;
  }
}, { passive: true });

canvas.addEventListener("touchend", (event) => {
  if (event.touches.length !== 2) previousTwoFingerCenter = null;
}, { passive: true });

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
  const capMaterial = fadeWithDistance(meshMaterial.clone());
  capMaterial.clippingPlanes = [];
  capMaterial.vertexColors = false;
  capMaterial.color.multiply(vertexColor);
  if (capMaterial.emissive) {
    capMaterial.emissive.copy(capMaterial.color);
    capMaterial.emissiveIntensity = 0.65;
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

async function changeModel(index, historyMode = "push") {
  if (modelLoading || index < 0 || index >= MODELS.length) return;
  modelLoading = true;
  setModelNavigationDisabled(true);
  const request = fetchModel(index, (progress) => {
    const percent = Math.min(Math.round(progress * 100), 99);
    setStatus(`Loading ${MODELS[index].name}… ${percent}%`);
  });
  if (!request.ready) setStatus(`Loading ${MODELS[index].name}…`);
  // Colour the page straight away so the switch feels immediate even while the GLB downloads.
  applyBackgroundColor(MODELS[index].backgroundColor);
  let gltf;
  try {
    gltf = await request;
  } catch (error) {
    modelRequests.delete(index);
    if (currentModelIndex >= 0) applyBackgroundColor(MODELS[currentModelIndex].backgroundColor);
    console.error("Could not load the model:", error);
    setStatus(`Could not load ${MODELS[index].name}: ${error.message || "check that the GLB is beside index.html."}`, true);
  }
  try {
    if (!gltf) return;
    loadModel(gltf);
    currentModelIndex = index;
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
    request.onProgress = null;
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

motionButton.addEventListener("click", () => {
  motionEnabled = !motionEnabled;
  motionButton.dataset.playing = String(motionEnabled);
  motionButton.setAttribute("aria-pressed", String(motionEnabled));
  const label = motionEnabled ? "Pause rotation" : "Play rotation";
  motionButton.setAttribute("aria-label", label);
  motionButton.title = label;
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
  changeModel(index);
});
nextModelButton.addEventListener("click", () => {
  const index = (currentModelIndex + 1) % MODELS.length;
  changeModel(index);
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
  controls.update();
  updateCutPlane();
  composer.render();
}
resize();
animate();
