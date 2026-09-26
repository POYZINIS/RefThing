/**
 * Minimal glTF 2 binaries for the model tests, built here instead of
 * checked in: a UV sphere with smooth normals and one base colour.
 */

/** A UV sphere: positions, smooth normals, outward (CCW) triangles. */
export function sphere(segments = 16, rings = 10) {
  const positions = [];
  for (let ring = 0; ring <= rings; ring += 1) {
    const phi = (ring / rings) * Math.PI;
    for (let segment = 0; segment <= segments; segment += 1) {
      const theta = (segment / segments) * Math.PI * 2;
      positions.push(
        Math.sin(phi) * Math.cos(theta),
        Math.cos(phi),
        Math.sin(phi) * Math.sin(theta),
      );
    }
  }
  const at = (index) => positions.slice(index * 3, index * 3 + 3);
  const indices = [];
  const triangle = (a, b, c) => {
    // Keep every triangle facing outward, whatever the loop order.
    const [pa, pb, pc] = [at(a), at(b), at(c)];
    const u = pb.map((v, i) => v - pa[i]);
    const w = pc.map((v, i) => v - pa[i]);
    const normal = [
      u[1] * w[2] - u[2] * w[1],
      u[2] * w[0] - u[0] * w[2],
      u[0] * w[1] - u[1] * w[0],
    ];
    const center = pa.map((v, i) => v + pb[i] + pc[i]);
    const outward = normal[0] * center[0] + normal[1] * center[1] + normal[2] * center[2];
    if (Math.hypot(...normal) < 1e-9) return; // degenerate at the poles
    indices.push(...(outward >= 0 ? [a, b, c] : [a, c, b]));
  };
  for (let ring = 0; ring < rings; ring += 1) {
    for (let segment = 0; segment < segments; segment += 1) {
      const a = ring * (segments + 1) + segment;
      const b = a + segments + 1;
      triangle(a, b, a + 1);
      triangle(b, b + 1, a + 1);
    }
  }
  // On a unit sphere the smooth normal is the position.
  return { positions, normals: [...positions], indices };
}

/** Pack a mesh into a .glb with one material of `baseColor` (linear RGBA). */
export function glb({ positions, normals, indices }, baseColor = [0.8, 0.25, 0.2, 1]) {
  const f32 = (values) => Buffer.from(new Float32Array(values).buffer);
  const u16 = (values) => Buffer.from(new Uint16Array(values).buffer);
  const pad4 = (buffer, fill = 0) =>
    buffer.length % 4 === 0
      ? buffer
      : Buffer.concat([buffer, Buffer.alloc(4 - (buffer.length % 4), fill)]);
  const views = [pad4(f32(positions)), pad4(f32(normals)), pad4(u16(indices))];
  let offset = 0;
  const bufferViews = views.map((view, index) => {
    const entry = {
      buffer: 0,
      byteOffset: offset,
      byteLength: view.length,
      target: index < 2 ? 34962 : 34963,
    };
    offset += view.length;
    return entry;
  });
  const bin = Buffer.concat(views);
  const count = positions.length / 3;
  const min = [0, 1, 2].map((axis) => Math.min(...positions.filter((_, i) => i % 3 === axis)));
  const max = [0, 1, 2].map((axis) => Math.max(...positions.filter((_, i) => i % 3 === axis)));
  const json = {
    asset: { version: '2.0' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0, NORMAL: 1 }, indices: 2, material: 0 }] }],
    materials: [{ pbrMetallicRoughness: { baseColorFactor: baseColor } }],
    buffers: [{ byteLength: bin.length }],
    bufferViews,
    accessors: [
      { bufferView: 0, componentType: 5126, count, type: 'VEC3', min, max },
      { bufferView: 1, componentType: 5126, count, type: 'VEC3' },
      { bufferView: 2, componentType: 5123, count: indices.length, type: 'SCALAR' },
    ],
  };
  const jsonChunk = pad4(Buffer.from(JSON.stringify(json)), 0x20);
  const header = Buffer.alloc(12);
  header.write('glTF', 0, 'ascii');
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(12 + 8 + jsonChunk.length + 8 + bin.length, 8);
  const chunk = (type, data) => {
    const head = Buffer.alloc(8);
    head.writeUInt32LE(data.length, 0);
    head.write(type, 4, 'ascii');
    return Buffer.concat([head, data]);
  };
  return Buffer.concat([header, chunk('JSON', jsonChunk), chunk('BIN\0', bin)]);
}
