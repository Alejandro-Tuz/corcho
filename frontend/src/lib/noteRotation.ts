/**
 * Rotación leve y fija por nota (dirección visual aprobada, día 3): nunca al
 * azar en cada render -saltaría con cada actualización de estado, un
 * `note.move` de otra persona haría temblar la nota en mi pantalla-. Hash
 * simple y determinista del `id` de la nota (estable, generado una sola vez en
 * cliente al crearla) a un ángulo chico: mismo id, mismo ángulo, siempre, en
 * cualquier pantalla.
 */

const MIN_DEG = -3
const MAX_DEG = 3

export function noteRotationDeg(noteId: string): number {
  let hash = 0
  for (let i = 0; i < noteId.length; i++) {
    hash = (hash * 31 + noteId.charCodeAt(i)) | 0
  }
  const normalized = (Math.abs(hash) % 1000) / 1000 // [0, 1)
  return MIN_DEG + normalized * (MAX_DEG - MIN_DEG)
}
