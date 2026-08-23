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
 */

export function throttle<Args extends unknown[]>(
  fn: (...args: Args) => void,
  intervalMs: number,
): (...args: Args) => void {
  let lastCallAt = 0
  let pendingArgs: Args | null = null
  let timer: ReturnType<typeof setTimeout> | null = null

  function invoke(args: Args): void {
    lastCallAt = Date.now()
    pendingArgs = null
    fn(...args)
  }

  return (...args: Args) => {
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
  }
}
