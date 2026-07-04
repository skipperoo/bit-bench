import SparkMD5 from 'spark-md5'

export function computeMD5(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunkSize = 2 * 1024 * 1024 // 2MB
    const spark = new SparkMD5.ArrayBuffer()
    const reader = new FileReader()
    let currentChunk = 0

    reader.onerror = () => reject(new Error('Failed to read file for MD5'))

    reader.onload = (e) => {
      spark.append(e.target!.result as ArrayBuffer)
      currentChunk++

      if (currentChunk * chunkSize < file.size) {
        loadNext()
      } else {
        resolve(spark.end())
      }
    }

    function loadNext() {
      const start = currentChunk * chunkSize
      const end = Math.min(start + chunkSize, file.size)
      reader.readAsArrayBuffer(file.slice(start, end))
    }

    loadNext()
  })
}
