/**
 * Franja de actividad (bloque 4): una tira horizontal con los últimos eventos de
 * la sala, para que alguien mirando la pantalla note "algo cambió" sin tener que
 * escanear las tres columnas. Fuente de datos: `state.activity`, ya formateado en
 * texto por `store/activity.ts` en el momento en que cada evento se aplica -ver
 * ese módulo para qué eventos entran y cuáles se dejan afuera a propósito.
 *
 * Solo lectura: no dispara ninguna acción. Se autodesplaza al último evento con
 * cada renglón nuevo -si alguien se puso a leer uno viejo más a la izquierda, un
 * evento nuevo se lo vuelve a tapar; aceptable para una franja de "lo que está
 * pasando ahora", no un historial para revisar con calma.
 */

import { useEffect, useRef } from 'react'
import { useRoom } from '../../app/RoomStoreContext'
import { PARTICIPANT_COLOR_HEX } from '../../lib/participantColor'
import './Activity.css'

export function Activity() {
  const activity = useRoom((s) => s.activity)
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = scrollRef.current
    if (el === null) return
    el.scrollLeft = el.scrollWidth
  }, [activity])

  return (
    <div ref={scrollRef} className="activity-strip">
      {activity.length === 0 && <span className="activity-empty">sin actividad todavía</span>}
      {activity.map((entry) => (
        <span key={entry.id} className="activity-entry">
          <span
            aria-hidden
            className="activity-dot"
            style={{ background: entry.color !== null ? PARTICIPANT_COLOR_HEX[entry.color] : '#999' }}
          />
          <span>{entry.text}</span>
          <span className="activity-time">
            {new Date(entry.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
          </span>
        </span>
      ))}
    </div>
  )
}
