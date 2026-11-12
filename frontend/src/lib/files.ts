/** Upload formats accepted by the backend (spec §4.5). */
export const ACCEPTED_EXTENSIONS = ['.bin', '.csv', '.zip', '.tar'] as const

export interface FileCheck {
  accepted: File[]
  /** Human-readable reasons for each rejected file. */
  rejected: string[]
}

function extensionOf(name: string): string {
  const idx = name.lastIndexOf('.')
  return idx === -1 ? '' : name.slice(idx).toLowerCase()
}

/**
 * Client-side pre-check mirroring the server: extension allow-list and the
 * per-file size limit from `GET /config` (`maxFileSizeMb`, 0 = no limit).
 */
export function checkUploadFiles(files: File[], maxFileSizeMb: number): FileCheck {
  const accepted: File[] = []
  const rejected: string[] = []
  const maxBytes = maxFileSizeMb > 0 ? maxFileSizeMb * 1024 * 1024 : Infinity
  for (const file of files) {
    const ext = extensionOf(file.name)
    if (!(ACCEPTED_EXTENSIONS as readonly string[]).includes(ext)) {
      rejected.push(`${file.name}: unsupported type (${ext || 'no extension'})`)
    } else if (file.size > maxBytes) {
      rejected.push(`${file.name}: larger than ${maxFileSizeMb} MB`)
    } else if (file.size === 0) {
      rejected.push(`${file.name}: empty file`)
    } else {
      accepted.push(file)
    }
  }
  return { accepted, rejected }
}
