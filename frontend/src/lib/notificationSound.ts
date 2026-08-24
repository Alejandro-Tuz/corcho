/**
 * Sonido de notificación (CLAUDE.md, "Comprometido, pendiente" #1: estaba en el
 * alcance original y había quedado sin hacer).
 *
 * Beep corto sintetizado con Web Audio, no un archivo de audio -nada que empaquetar
 * ni servir, y "silenciar" es simplemente no llamar a `playNotificationSound`, sin un
 * `<audio>` que pausar/reanudar ni un asset que cachear.
 *
 * La preferencia de silencio es GLOBAL, no por sala -a diferencia de
 * `lib/identity.ts`-: es una preferencia de la persona frente a esta pestaña, no algo
 * que dependa de en qué sala está. Si la silencié porque estoy en una reunión, sigue
 * silenciada al entrar a otra sala.
 */

const MUTED_KEY = 'corcho:notifications_muted'

export function loadMuted(): boolean {
  return localStorage.getItem(MUTED_KEY) === '1'
}

export function saveMuted(muted: boolean): void {
  localStorage.setItem(MUTED_KEY, muted ? '1' : '0')
}

// Un solo AudioContext para toda la pestaña, creado recién con el primer sonido -no
// al importar el módulo-: crearlo antes de cualquier gesto del usuario es lo que
// dispara la política de autoplay de los navegadores en primer lugar.
let audioContext: AudioContext | null = null

function getAudioContext(): AudioContext {
  audioContext ??= new AudioContext()
  return audioContext
}

export function playNotificationSound(): void {
  try {
    const ctx = getAudioContext()
    // `resume()` es inofensivo llamarlo aunque el contexto ya esté corriendo -hace
    // falta igual porque un `AudioContext` puede arrancar "suspended" hasta el
    // primer gesto del usuario en la página, y para cuando suena la primera
    // notificación esa interacción (onboarding, un click) ya pasó, pero el
    // contexto en sí recién se crea acá.
    void ctx.resume()

    const oscillator = ctx.createOscillator()
    const gain = ctx.createGain()
    oscillator.type = 'sine'
    oscillator.frequency.value = 880 // A5: audible sin ser estridente
    gain.gain.setValueAtTime(0, ctx.currentTime)
    gain.gain.linearRampToValueAtTime(0.15, ctx.currentTime + 0.01)
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.25)
    oscillator.connect(gain)
    gain.connect(ctx.destination)
    oscillator.start()
    oscillator.stop(ctx.currentTime + 0.25)
  } catch {
    // Sin Web Audio disponible (navegador viejo, contexto bloqueado): sin sonido,
    // no rompe nada más -una notificación perdida no es un estado inconsistente.
  }
}
