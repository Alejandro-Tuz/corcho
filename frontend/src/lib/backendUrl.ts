/**
 * De dónde cuelga el backend: un solo lugar para esta decisión, porque REST
 * (`fetch`, en `app/Landing.tsx`) y WebSocket (`realtime/socket.ts`) la necesitan
 * igual, derivada del mismo override.
 *
 * `VITE_BACKEND_URL` es el escape hatch para producción (Render): wiring pendiente
 * de cuándo se aborde el deploy, no hoy. El default asume `uvicorn app.main:app
 * --reload` corriendo en el puerto 8000 del mismo host -alcanza para `npm run dev`
 * sin ninguna configuración, que es el único entorno que importa en el día 2.
 */
function backendOrigin(): string {
  const configured = import.meta.env.VITE_BACKEND_URL as string | undefined
  if (configured !== undefined) return configured
  const scheme = window.location.protocol === 'https:' ? 'https' : 'http'
  return `${scheme}://${window.location.hostname}:8000`
}

export function apiBaseUrl(): string {
  return `${backendOrigin()}/api/v1`
}

export function wsBaseUrl(): string {
  const origin = backendOrigin()
  return origin.startsWith('https') ? `wss${origin.slice('https'.length)}` : `ws${origin.slice('http'.length)}`
}
