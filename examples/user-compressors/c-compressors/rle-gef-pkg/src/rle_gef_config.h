/*
 * rle_gef_config.h — compile-time configuration of the MCU RLE-GEF library.
 *
 * The library is a trimmed, self-contained port of the random-access
 * RLE_GEF from reference/generalized-elias-fano (same split-point and
 * bit-layout logic as the original C port) intended for microcontrollers:
 *
 *   - no rank/select index and no random access: sequential encode/decode
 *     only (the thesis' Cortex-M streaming variant);
 *   - no file I/O: compressed chunks are packed to/from caller memory;
 *   - all heap use goes through RGEF_MALLOC/RGEF_CALLOC/RGEF_FREE so the
 *     firmware can plug a static pool or an arena instead of the libc heap;
 *   - sample types enabled individually below.
 */
#ifndef RLE_GEF_CONFIG_H
#define RLE_GEF_CONFIG_H

/* Sample types to instantiate (each costs code + nothing else). */
#ifndef RGEF_ENABLE_I8
#define RGEF_ENABLE_I8 1
#endif
#ifndef RGEF_ENABLE_I16
#define RGEF_ENABLE_I16 1
#endif

/* Allocator. Override all three on the target with plain function
 * identifiers, e.g.
 *   -DRGEF_MALLOC=my_alloc -DRGEF_FREE=my_free -DRGEF_CALLOC=my_calloc
 * Define RGEF_ALLOC_DECLARE to have the standard prototypes emitted here
 * (they expand to the chosen identifiers).
 */
#ifdef RGEF_ALLOC_DECLARE
#include <stddef.h>
void *RGEF_MALLOC(size_t size);
void *RGEF_CALLOC(size_t n, size_t size);
void RGEF_FREE(void *p);
#endif

#ifndef RGEF_MALLOC
#define RGEF_MALLOC malloc
#endif
#ifndef RGEF_FREE
#define RGEF_FREE free
#endif
#ifndef RGEF_CALLOC
#define RGEF_CALLOC calloc
#endif

#endif /* RLE_GEF_CONFIG_H */
