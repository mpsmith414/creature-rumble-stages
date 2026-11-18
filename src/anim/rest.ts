import { Matrix4, Quaternion, Vector3 } from 'three/webgpu';
import type { BodyLayout, Segment } from './layout';

/**
 * Where each segment's piece sits at rest (the creature standing at the origin facing +z): kept apart from the poses
 * so the renderer can read it without reaching the stage's game code.
 */

const UP = new Vector3(0, 1, 0);
const ONE = new Vector3(1, 1, 1);

/** A segment's piece at rest: its capsule's centre, turned so its +y runs from `a` to `b`. */
export function restPiece(seg: Pick<Segment, 'a' | 'b'>): { p: Vector3; q: Quaternion } {
  const a = new Vector3(seg.a.x, seg.a.y, seg.a.z), b = new Vector3(seg.b.x, seg.b.y, seg.b.z);
  const axis = b.clone().sub(a);
  const len = axis.length();
  const p = a.clone().add(b).multiplyScalar(0.5);
  return { p, q: len > 1e-6 ? new Quaternion().setFromUnitVectors(UP, axis.divideScalar(len)) : new Quaternion() };
}

/** Each segment's piece at rest, as a matrix (new matrices each call). */
export function restPieces(layout: Pick<BodyLayout, 'segments'>): Matrix4[] {
  return layout.segments.map((g) => {
    const { p, q } = restPiece(g);
    return new Matrix4().compose(p, q, ONE);
  });
}
