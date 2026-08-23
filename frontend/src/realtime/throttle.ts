/**
 * Throttle genérico para los dos emisores de alta frecuencia: cursores y arrastre en
 * curso (`presence.cursor`, `presence.dragging` -invariante 6, nunca se persisten,
 * se transmiten y se descartan).
 *
 * Con flanco y cola: si pasó suficiente tiempo desde la última llamada, se manda ya
 * -no hay motivo para esperar y sentir el cursor atrasado-; si no, se guarda la
 * posición más reciente y se manda una sola vez, al cumplirse el intervalo. Sin la
 * cola, dejar de mover el mouse a mitad de un intervalo dejaría al resto de la sala
 * viendo la posición de la llamada anterior, no la última real.
 *
 * `cancel()`: hace falta para `presence.dragging` en particular -bug real encontrado
 * y corregido en el camino (ver `Note.tsx`)-. Si la cola tiene una llamada pendiente
 * en el momento de soltar el arrastre, y nadie la cancela, ese `presence.dragging`
 * atrasado puede llegar DESPUÉS de que `note.move` ya limpió el fantasma del lado del
 * store (`applyNoteMove`), y como `applyPresenceDragging` no sabe distinguir "en
 * vuelo" de "atrasado", lo vuelve a poner: el fantasma queda pegado para siempre, sin
 * nadie arrastrando nada. `Note.tsx` cancela el throttle de arrastre en
 * `pointerup`, antes de mandar el `note.move` final, para que esa cola nunca llegue a
 * dispararse sola.
 */

export interface Throttled<Args extends unknown[]> {
  (...args: Args): void
  cancel(): void
}

export function throttle<Args extends unknown[]>(
  fn: (...args: Args) => void,
  intervalMs: number,
): Throttled<Args> {
  let lastCallAt = 0
  let pendingArgs: Args | null = null
  let timer: ReturnType<typeof setTimeout> | null = null

  function invoke(args: Args): void {
    lastCallAt = Date.now()
    pendingArgs = null
    fn(...args)
  }

  const throttled = ((...args: Args) => {
    const elapsed = Date.now() - lastCallAt
    if (elapsed >= intervalMs) {
      invoke(args)
      return
    }
    pendingArgs = args
    if (timer === null) {
      timer = setTimeout(() => {
        timer = null
        if (pendingArgs !== null) invoke(pendingArgs)
      }, intervalMs - elapsed)
    }
  }) as Throttled<Args>

  throttled.cancel = () => {
    if (timer !== null) clearTimeout(timer)
    timer = null
    pendingArgs = null
  }

  return throttled
}
