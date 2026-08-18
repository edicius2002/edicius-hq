/**
 * `versor` ships no types, and there is no `@types/versor`.
 *
 * Four functions, declared to what they actually are rather than to `any`:
 * this is the quaternion maths behind dragging a globe, and a wrong argument
 * order there produces a map that tumbles instead of turning — exactly the
 * kind of mistake a type checker should be allowed to catch.
 *
 * Source: https://github.com/Fil/versor (ISC).
 */
declare module 'versor' {
  type Quaternion = [number, number, number, number];
  type Cartesian = [number, number, number];
  type Angles = [number, number, number];

  interface Versor {
    (angles: Angles | [number, number]): Quaternion;
    /** A `[longitude, latitude]` point as a unit vector. */
    cartesian(point: [number, number]): Cartesian;
    /** The rotation carrying `from` onto `to`. */
    delta(from: Cartesian, to: Cartesian, alpha?: number): Quaternion;
    multiply(a: Quaternion, b: Quaternion): Quaternion;
    /** Back to the `[lambda, phi, gamma]` a d3 projection wants. */
    rotation(quaternion: Quaternion): Angles;
  }

  const versor: Versor;
  export default versor;
}
