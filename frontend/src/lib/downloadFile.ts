/**
 * Descarga un string como archivo, del lado del cliente -sin backend de por
 * medio: un `Blob` + un `<a download>` temporal es lo único que hace falta, no
 * se justifica una librería para esto (CLAUDE.md: no agregar dependencias sin
 * decirlo). Usado por "exportar el tablero a markdown"
 * (`store/exportMarkdown.ts`), pero no sabe nada de notas ni de salas -genérico
 * a propósito, cualquier texto plano sirve.
 */
export function downloadTextFile(filename: string, content: string, mimeType: string): void {
  const blob = new Blob([content], { type: mimeType })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  link.click()
  URL.revokeObjectURL(url)
}
