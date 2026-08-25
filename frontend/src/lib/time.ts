/** Formato de hora compartido -antes vivía duplicado en `RoomSummaryButton.tsx` y
 * se necesitaba de nuevo en `features/chat/ChatPanel.tsx`, misma regla exacta
 * (`es-AR`, dos dígitos de hora y minuto) las dos veces. */
export function formatClockTime(iso: string): string {
  return new Date(iso).toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' })
}
