/**
 * Marks a result whose compressor failed its self-test: the decompressed data
 * differed from the input (or the input was not exactly representable for a
 * floating-point compressor), so the numbers are not a lossless measurement.
 */
export default function SelfTestBadge({ failures }: { failures?: number }) {
  if (!failures) return null
  return (
    <span
      className="shrink-0 rounded border border-red-300 bg-red-50 px-1 text-[10px] font-medium text-red-800 dark:border-red-800 dark:bg-red-950 dark:text-red-200"
      title={`Self-test failed on ${failures} input${failures === 1 ? '' : 's'}: the decompressed data did not match the input, so this result is not lossless. See the warnings above.`}
    >
      self-test failed
    </span>
  )
}
