// Turns the source GLBs in models/ into the ones the page loads from
// public/assets/models/, doing once, here, what the page would otherwise do on
// every load:
//   - bakes node transforms into the vertices and centres the model on the origin
//   - replaces the normals with smooth ones averaged across split vertices
//   - keeps one colour layer per mesh as COLOR_0 and drops the rest (Blender
//     exports its colour attributes by index; the real one is the highest
//     layer that is not all zeros)
//   - where a mesh has duplicated vertices (split normals), adds a child node
//     flagged in its extras whose primitive shares the mesh's positions but
//     indexes them welded, so the stencil passes see a closed surface
//   - stores the bounds, the convex-hull vertices and the radius in the
//     scene's extras, where the page reads them from gltf.scene.userData
// Run with `yarn prepare-models` after adding or changing a model.
import { readdir, mkdir, stat } from "node:fs/promises";
import { join, parse } from "node:path";
import { NodeIO, PropertyType, getBounds } from "@gltf-transform/core";
import { dedup, flatten, prune, transformMesh } from "@gltf-transform/functions";
import { Vector3 } from "three";
import { ConvexHull } from "three/addons/math/ConvexHull.js";

const SOURCE_DIR = new URL("../models/", import.meta.url).pathname;
const OUTPUT_DIR = new URL("../public/assets/models/", import.meta.url).pathname;
const STENCIL_FLAG = { stratacutoscope: "stencil" };
const HULL_SAMPLE_LIMIT = 50000; // vertices per mesh fed to the hull
const HULL_DIGITS = 4; // significant digits kept for hull vertices; they only frame the view

function isAllZero(accessor) {
  const element = [];
  for (let i = 0; i < accessor.getCount(); i++) {
    if (accessor.getElement(i, element).some((value) => value !== 0)) return false;
  }
  return true;
}

// The colour layer to keep: the highest-numbered COLOR_n with any colour in it.
function chooseColourLayer(primitive) {
  const layers = primitive.listSemantics()
    .filter((semantic) => /^COLOR_\d+$/.test(semantic))
    .sort((a, b) => Number(b.slice(6)) - Number(a.slice(6)));
  return layers.find((semantic) => !isAllZero(primitive.getAttribute(semantic))) ?? null;
}

// For each vertex, the first vertex at the same position.
function weldRemap(primitive) {
  const position = primitive.getAttribute("POSITION");
  const count = position.getCount();
  const firstAt = new Map();
  const remap = new Uint32Array(count);
  const element = [];
  for (let i = 0; i < count; i++) {
    const key = position.getElement(i, element).join(",");
    const first = firstAt.get(key);
    remap[i] = first ?? i;
    if (first === undefined) firstAt.set(key, i);
  }
  return remap;
}

// Indices with every vertex replaced by the first one at the same position,
// or null when no vertex repeats.
function weldedIndices(primitive) {
  const position = primitive.getAttribute("POSITION");
  const count = position.getCount();
  const remap = weldRemap(primitive);
  const source = primitive.getIndices()?.getArray() ?? Uint32Array.from({ length: count }, (_, i) => i);
  const welded = count > 0xffff ? new Uint32Array(source.length) : new Uint16Array(source.length);
  let changed = false;
  for (let i = 0; i < source.length; i++) {
    welded[i] = remap[source[i]];
    if (welded[i] !== source[i]) changed = true;
  }
  return changed ? welded : null;
}

// Normals averaged over every face that meets at a position, so the surface
// shades smoothly everywhere: no creases where Blender split the vertices.
function smoothNormals(document, primitive) {
  const position = primitive.getAttribute("POSITION");
  const count = position.getCount();
  const remap = weldRemap(primitive);
  const indices = primitive.getIndices()?.getArray() ?? Uint32Array.from({ length: count }, (_, i) => i);
  const points = position.getArray();
  const sums = new Float64Array(count * 3);
  for (let i = 0; i + 2 < indices.length; i += 3) {
    const a = indices[i] * 3;
    const b = indices[i + 1] * 3;
    const c = indices[i + 2] * 3;
    const abx = points[b] - points[a], aby = points[b + 1] - points[a + 1], abz = points[b + 2] - points[a + 2];
    const acx = points[c] - points[a], acy = points[c + 1] - points[a + 1], acz = points[c + 2] - points[a + 2];
    // The cross product's length is twice the area: larger faces weigh more.
    const nx = aby * acz - abz * acy;
    const ny = abz * acx - abx * acz;
    const nz = abx * acy - aby * acx;
    for (const corner of [indices[i], indices[i + 1], indices[i + 2]]) {
      const target = remap[corner] * 3;
      sums[target] += nx;
      sums[target + 1] += ny;
      sums[target + 2] += nz;
    }
  }
  const normals = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    const source = remap[i] * 3;
    const length = Math.hypot(sums[source], sums[source + 1], sums[source + 2]) || 1;
    normals[i * 3] = sums[source] / length;
    normals[i * 3 + 1] = sums[source + 1] / length;
    normals[i * 3 + 2] = sums[source + 2] / length;
  }
  const previous = primitive.getAttribute("NORMAL");
  primitive.setAttribute("NORMAL", document.createAccessor()
    .setType("VEC3")
    .setArray(normals)
    .setBuffer(document.getRoot().listBuffers()[0]));
  previous?.dispose();
}

function hullVertices(points, bounds) {
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
    return Array.from({ length: 8 }, (_, i) => new Vector3(
      i & 1 ? bounds.max[0] : bounds.min[0],
      i & 2 ? bounds.max[1] : bounds.min[1],
      i & 4 ? bounds.max[2] : bounds.min[2]
    ));
  }
}

async function prepare(name) {
  const io = new NodeIO();
  const document = await io.read(join(SOURCE_DIR, `${name}.glb`));
  await document.transform(flatten());
  const root = document.getRoot();
  const scene = root.getDefaultScene() ?? root.listScenes()[0];
  const summary = [];

  // Bake every node's transform, shifted so the whole model is centred.
  const worldBounds = getBounds(scene);
  const center = worldBounds.min.map((value, axis) => (value + worldBounds.max[axis]) / 2);
  const meshNodes = [];
  for (const node of scene.listChildren()) {
    const mesh = node.getMesh();
    if (!mesh) {
      node.dispose();
      continue;
    }
    if (mesh.listParents().filter((parent) => parent.propertyType === "Node").length > 1) {
      throw new Error(`${name}: mesh "${mesh.getName()}" is shared by several nodes; split it first.`);
    }
    if (mesh.listPrimitives().length !== 1) {
      throw new Error(`${name}: mesh "${mesh.getName()}" has ${mesh.listPrimitives().length} primitives; one is expected.`);
    }
    const matrix = node.getWorldMatrix();
    matrix[12] -= center[0];
    matrix[13] -= center[1];
    matrix[14] -= center[2];
    transformMesh(mesh, matrix);
    node.setTranslation([0, 0, 0]).setRotation([0, 0, 0, 1]).setScale([1, 1, 1]);
    meshNodes.push(node);
  }
  if (!meshNodes.length) throw new Error(`${name}: no mesh found.`);

  const hullInput = [];
  for (const node of meshNodes) {
    const mesh = node.getMesh();
    const [primitive] = mesh.listPrimitives();

    const chosen = chooseColourLayer(primitive);
    for (const semantic of primitive.listSemantics()) {
      if (!/^COLOR_\d+$/.test(semantic) || semantic === chosen) continue;
      primitive.setAttribute(semantic, null);
    }
    if (chosen && chosen !== "COLOR_0") {
      primitive.setAttribute("COLOR_0", primitive.getAttribute(chosen));
      primitive.setAttribute(chosen, null);
    }

    const position = primitive.getAttribute("POSITION");
    const stride = Math.max(1, Math.ceil(position.getCount() / HULL_SAMPLE_LIMIT));
    const element = [];
    for (let i = 0; i < position.getCount(); i += stride) {
      hullInput.push(new Vector3(...position.getElement(i, element)));
    }

    smoothNormals(document, primitive);

    const welded = weldedIndices(primitive);
    if (welded) {
      const indices = document.createAccessor()
        .setType("SCALAR")
        .setArray(welded)
        .setBuffer(root.listBuffers()[0]);
      const stencilPrimitive = document.createPrimitive()
        .setMode(primitive.getMode())
        .setAttribute("POSITION", position)
        .setIndices(indices);
      const stencilMesh = document.createMesh(`${mesh.getName()} stencil`).addPrimitive(stencilPrimitive);
      node.addChild(document.createNode(stencilMesh.getName()).setMesh(stencilMesh).setExtras(STENCIL_FLAG));
    }

    summary.push(`${mesh.getName()}: ${position.getCount()} vertices, colour ${chosen ?? "none"}, ` +
      `stencil ${welded ? `${new Set(welded).size} welded vertices` : "shares the mesh"}`);
  }

  const bounds = getBounds(scene);
  const size = bounds.max.map((value, axis) => value - bounds.min[axis]);
  const extremePoints = hullVertices(hullInput, bounds);
  scene.setExtras({
    stratacutoscope: {
      bounds,
      maxDimension: Math.max(...size),
      radius: Math.max(...extremePoints.map((point) => point.length())),
      extremePoints: extremePoints.flatMap((point) =>
        point.toArray().map((value) => Number(value.toPrecision(HULL_DIGITS))))
    }
  });

  // Baking transforms splits accessors that meshes shared; merge them back.
  await document.transform(dedup({ propertyTypes: [PropertyType.ACCESSOR] }), prune());
  const output = join(OUTPUT_DIR, `${name}.glb`);
  await io.write(output, document);
  const before = (await stat(join(SOURCE_DIR, `${name}.glb`))).size;
  const after = (await stat(output)).size;
  console.log(`${name}: ${(before / 1e6).toFixed(2)} MB -> ${(after / 1e6).toFixed(2)} MB`);
  for (const line of summary) console.log(`  ${line}`);
}

await mkdir(OUTPUT_DIR, { recursive: true });
const names = (await readdir(SOURCE_DIR))
  .filter((file) => file.endsWith(".glb"))
  .map((file) => parse(file).name)
  .sort();
for (const name of names) await prepare(name);
