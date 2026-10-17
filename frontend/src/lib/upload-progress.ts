/**
 * Per-file upload progress helpers.
 *
 * A single benchmark upload is one multipart request containing every file,
 * so the browser only reports total bytes sent. Because multipart fields are
 * streamed in order, the cumulative file sizes can be compared against the
 * sent byte count to derive which files have already been transmitted.
 */

export type UploadPhase = 'idle' | 'uploading' | 'processing' | 'done' | 'error'

export type FileUploadStatus = 'ready' | 'uploading' | 'sent' | 'processing' | 'done' | 'error'

interface SizedFile {
  size: number
}

/** Cumulative file bytes after each file (end offsets). */
export function cumulativeBytes(files: SizedFile[]): number[] {
  const ends: number[] = []
  let sum = 0
  for (const file of files) {
    sum += Math.max(0, file.size)
    ends.push(sum)
  }
  return ends
}

/** Sum of all file sizes. */
export function totalFileBytes(files: SizedFile[]): number {
  return files.reduce((sum, file) => sum + Math.max(0, file.size), 0)
}

/**
 * Statuses for a batch upload (all files in one request):
 * - `uploading` phase → files whose bytes have been sent are `sent`;
 * - `processing` → every file is `processing` (bytes sent, server working);
 * - `done` / `error` → final outcome for all files.
 */
export function batchFileStatuses(
  files: SizedFile[],
  phase: UploadPhase,
  loaded: number,
  total: number
): FileUploadStatus[] {
  switch (phase) {
    case 'idle':
      return files.map(() => 'ready')
    case 'processing':
      return files.map(() => 'processing')
    case 'done':
      return files.map(() => 'done')
    case 'error':
      return files.map(() => 'error')
    case 'uploading': {
      if (total <= 0) return files.map(() => 'uploading')
      const totalBytes = totalFileBytes(files)
      if (totalBytes <= 0) return files.map(() => 'sent')
      const sentFileBytes = Math.min(totalBytes, (loaded / total) * totalBytes)
      const ends = cumulativeBytes(files)
      return files.map((_, index) => (ends[index] <= sentFileBytes ? 'sent' : 'uploading'))
    }
  }
}

/**
 * Statuses for sequential uploads (one request per file): files before the
 * active one are done, the active one reflects the current phase and the rest
 * stay ready.
 */
export function sequentialFileStatuses(
  count: number,
  activeIndex: number,
  phase: UploadPhase
): FileUploadStatus[] {
  const statuses: FileUploadStatus[] = []
  for (let index = 0; index < count; index++) {
    if (index < activeIndex) {
      statuses.push('done')
    } else if (index === activeIndex) {
      statuses.push(phase === 'idle' ? 'ready' : phase)
    } else {
      statuses.push('ready')
    }
  }
  return statuses
}
