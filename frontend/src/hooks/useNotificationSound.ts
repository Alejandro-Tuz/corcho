/**
 * Sonido de notificación (CLAUDE.md, "Comprometido, pendiente" #1). Primer uso real
 * de `hooks/` -hasta acá esa carpeta estaba vacía.
 *
 * Suena cuando pasa algo que ya deja renglón en la franja de actividad
 * (`store/activity.ts`) Y no lo disparé yo -mi propio click no necesita avisarme
 * nada-. Reusa el mismo filtro de "qué es actividad" que ya tiene la franja en vez de
 * mantener una segunda lista de eventos "que suenan": si algún día
 * `store/activity.ts` deja de loguear algo, este hook deja de sonar por eso también,
 * sin tocarlo.
 *
 * Compara por LARGO del array, no por el id del último renglón: un lote de eventos
 * que llegan casi juntos (dos personas reaccionando casi a la vez, por ejemplo) puede
 * sumar más de un renglón nuevo entre un render y el siguiente -mirar solo el último
 * se perdería los demás. Un solo beep alcanza igual aunque haya más de un renglón
 * nuevo en el lote: no hace falta uno por cada uno. Si el largo BAJA (una
 * reconexión reinicia `activity` a `[]`, `store/roomStore.ts`), no hay nada que
 * sonar -se vuelve a alinear la referencia y listo.
 */

import { useEffect, useRef, useState } from 'react'
import { useRoom } from '../app/RoomStoreContext'
import { loadMuted, playNotificationSound, saveMuted } from '../lib/notificationSound'

export function useNotificationSound(): { muted: boolean; toggleMuted: () => void } {
  const [muted, setMuted] = useState(loadMuted)
  const activity = useRoom((s) => s.activity)
  const myParticipantId = useRoom((s) => s.me?.participantId ?? null)
  const previousLengthRef = useRef(activity.length)

  useEffect(() => {
    const previousLength = previousLengthRef.current
    previousLengthRef.current = activity.length
    if (activity.length <= previousLength) return
    if (muted) return

    const newEntries = activity.slice(previousLength)
    const fromSomeoneElse = newEntries.some((entry) => entry.participantId !== myParticipantId)
    if (fromSomeoneElse) playNotificationSound()
  }, [activity, muted, myParticipantId])

  function toggleMuted(): void {
    setMuted((current) => {
      const next = !current
      saveMuted(next)
      return next
    })
  }

  return { muted, toggleMuted }
}
