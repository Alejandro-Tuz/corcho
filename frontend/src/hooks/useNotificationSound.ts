/**
 * Sonido de notificación (CLAUDE.md, "Comprometido, pendiente" #1). Primer uso real
 * de `hooks/` -hasta acá esa carpeta estaba vacía.
 *
 * Suena cuando pasa algo que ya deja renglón en la franja de actividad
 * (`store/activity.ts`) Y no lo disparé yo -mi propio click no necesita avisarme
 * nada-. Reusa el mismo filtro de "qué es actividad" que ya tiene la franja en vez de
 * mantener una segunda lista de eventos "que suenan": si algún día
 * `store/activity.ts` deja de loguear algo, este hook deja de sonar por eso también,
 * sin tocarlo. Deliberadamente sin tocar para el resto de los eventos (conectar,
 * crear/mover/borrar una nota, cupos, reacciones, fondo, pedir un resumen): suenan
 * todos igual que antes, sin distinguir cuáles son más "urgentes" -esa priorización
 * es una decisión de producto aparte, no algo que este cambio deba resolver.
 *
 * Compara por LARGO del array, no por el id del último renglón: un lote de eventos
 * que llegan casi juntos (dos personas reaccionando casi a la vez, por ejemplo) puede
 * sumar más de un renglón nuevo entre un render y el siguiente -mirar solo el último
 * se perdería los demás. Un solo beep alcanza igual aunque haya más de un renglón
 * nuevo en el lote: no hace falta uno por cada uno. Si el largo BAJA (una
 * reconexión reinicia `activity` a `[]`, `store/roomStore.ts`), no hay nada que
 * sonar -se vuelve a alinear la referencia y listo.
 *
 * ## `chatWatching`: la única excepción, un tipo de evento a la vez
 *
 * Un `chat.message` ajeno (`entry.isChatMessage`, ver `store/types.ts`) NO suena si
 * `chatWatching` es `true` -el panel de chat está abierto Y con el scroll en el
 * fondo, se está viendo llegar en vivo, sonarle además es redundante-. Todo lo
 * demás sigue sonando sin condición extra, esté el chat abierto o no: no hay
 * ningún motivo para que ver el chat silencie, por ejemplo, que alguien tomó un
 * cupo.
 *
 * `chatWatching` viaja como PARÁMETRO, no como un `useContext` acá adentro: quien
 * lo calcula es `features/chat/ChatContext.ts`, provisto por `Canvas.tsx` -el mismo
 * componente que llama a este hook, en su propio cuerpo, ANTES de la línea que
 * arma ese Provider. Un componente no puede consumir con `useContext` el Provider
 * que él mismo va a renderizar más abajo en su return -no es un ancestro propio-,
 * así que `Canvas.tsx` le pasa el `useState` que ya tiene a mano en vez de que este
 * hook intente leerlo del árbol.
 */

import { useEffect, useRef, useState } from 'react'
import { useRoom } from '../app/RoomStoreContext'
import { loadMuted, playNotificationSound, saveMuted } from '../lib/notificationSound'

export function useNotificationSound(chatWatching: boolean): {
  muted: boolean
  toggleMuted: () => void
} {
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
    const shouldSound = newEntries.some((entry) => {
      if (entry.participantId === myParticipantId) return false
      if (entry.isChatMessage && chatWatching) return false
      return true
    })
    if (shouldSound) playNotificationSound()
  }, [activity, muted, myParticipantId, chatWatching])

  function toggleMuted(): void {
    setMuted((current) => {
      const next = !current
      saveMuted(next)
      return next
    })
  }

  return { muted, toggleMuted }
}
